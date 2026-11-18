'use strict';

/*
 * Live Queue
 * Copyright (c) 2026 Federico Pierno
 * MIT License with the Commons Clause. See LICENSE.
 */

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { exec } = require('node:child_process');

const DEMO = process.argv.includes('--demo');
const NO_BROWSER = process.argv.includes('--no-browser');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_LOGO_BYTES = 2 * 1024 * 1024;

const DEFAULT_THEME = {
  accent: '#2f80ed',
  bg: '#0e1117',
  surface: '#171b22',
  border: '#272d38',
  text: '#e6eaf1',
  twitch: '#9146ff',
  tiktok: '#25f4ee'
};

const DEFAULTS = {
  language: 'en',
  panelTitle: 'Live Queue',
  overlayTitle: 'Up next',
  twitchChannel: '',
  keyword: '!queue',
  queueLimit: 300,
  overlayRows: 10,
  sources: 'both',
  blockDuplicates: true,
  tikfinity: 'ws://127.0.0.1:21213/',
  port: 8420,
  theme: { ...DEFAULT_THEME },
  logoFile: null,
  logoVersion: 0
};

let settings = { ...DEFAULTS };

function loadConfig() {
  try {
    const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    settings = { ...DEFAULTS, ...saved, theme: { ...DEFAULT_THEME, ...(saved.theme || {}) } };
  } catch {
    saveConfig();
    console.log('Created config.json with the default settings.');
  }
}

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(settings, null, 2), 'utf8');
  } catch (err) {
    console.log('Could not write config.json:', err.message);
  }
}

// The queue only ever lives in memory. Close the program and it is gone.

let queue = [];
let nextId = 1;
let called = 0;

const state = {
  twitch: { key: 'off' },
  tiktok: { key: 'off' }
};

const listeners = new Set();

function snapshot() {
  return { queue, state, called, settings, demo: DEMO };
}

function broadcast() {
  const payload = `data: ${JSON.stringify(snapshot())}\n\n`;
  for (const res of listeners) {
    try {
      res.write(payload);
    } catch {
      listeners.delete(res);
    }
  }
}

function setState(source, key, detail) {
  state[source] = detail ? { key, detail } : { key };
  broadcast();
}

function enqueue(platform, name, message) {
  const handle = String(name || '').trim().slice(0, 60);
  if (!handle) return;

  if (queue.length >= settings.queueLimit) {
    console.log(`Queue is full (${settings.queueLimit}), skipped ${handle}`);
    return;
  }

  if (settings.blockDuplicates) {
    const alreadyThere = queue.some(entry =>
      entry.platform === platform && entry.name.toLowerCase() === handle.toLowerCase()
    );
    if (alreadyThere) return;
  }

  queue.push({
    id: nextId++,
    platform,
    name: handle,
    message: String(message || '').trim().slice(0, 400),
    at: new Date().toISOString()
  });

  console.log(`+ ${handle} (${platform})`);
  broadcast();
}

function callNext() {
  const entry = queue.shift();
  if (!entry) return null;
  called++;
  console.log(`Called ${entry.name} (${entry.platform})`);
  broadcast();
  return entry;
}

function removeById(id) {
  const before = queue.length;
  queue = queue.filter(entry => entry.id !== id);
  if (queue.length === before) return false;
  called++;
  broadcast();
  return true;
}

// The keyword has to appear as a whole word, so "!queue blue" counts
// but "!queueeee" does not.

function hasKeyword(text) {
  const keyword = String(settings.keyword || '').toLowerCase().trim();
  if (!keyword) return false;
  const pattern = new RegExp(
    '(?:^|\\s)' + keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=\\s|$)', 'i'
  );
  return pattern.test(String(text || ''));
}

function handleMessage(platform, name, text) {
  if (hasKeyword(text)) enqueue(platform, name, text);
}

/* Twitch -------------------------------------------------------------------
   Public chat, read only, over the anonymous IRC gateway. Twitch accepts any
   justinfan* user and ignores the password for them, so there is no account
   or token involved and the program cannot post anything. */

const ANON_PASSWORD = 'NONE';

function anonUser() {
  return 'justinfan' + Math.floor(10000 + Math.random() * 80000);
}

function cleanChannel(value) {
  return String(value || '').trim().toLowerCase()
    .replace(/^https?:\/\/(www\.)?twitch\.tv\//, '')
    .replace(/^@/, '')
    .split(/[/?#]/)[0];
}

function unescapeTag(value) {
  return String(value || '')
    .replace(/\\s/g, ' ')
    .replace(/\\n/g, '')
    .replace(/\\r/g, '')
    .replace(/\\:/g, ';')
    .replace(/\\\\/g, '\\');
}

function parseIrc(line) {
  let rest = line;
  const tags = {};

  if (rest.startsWith('@')) {
    const space = rest.indexOf(' ');
    for (const pair of rest.slice(1, space).split(';')) {
      const eq = pair.indexOf('=');
      if (eq === -1) tags[pair] = '';
      else tags[pair.slice(0, eq)] = unescapeTag(pair.slice(eq + 1));
    }
    rest = rest.slice(space + 1);
  }

  let prefix = '';
  if (rest.startsWith(':')) {
    const space = rest.indexOf(' ');
    prefix = rest.slice(1, space);
    rest = rest.slice(space + 1);
  }

  const space = rest.indexOf(' ');
  const command = space === -1 ? rest : rest.slice(0, space);
  const params = space === -1 ? '' : rest.slice(space + 1);
  let text = '';

  if (params.startsWith(':')) {
    text = params.slice(1);
  } else {
    const marker = params.indexOf(' :');
    if (marker !== -1) text = params.slice(marker + 2);
  }

  return { tags, prefix, command, text };
}

let twitchSocket = null;
let twitchTimer = null;
let twitchStopped = true;
let twitchBackoff = 1000;

function stopTwitch() {
  twitchStopped = true;
  clearTimeout(twitchTimer);
  if (twitchSocket) {
    try { twitchSocket.close(); } catch { /* already gone */ }
  }
  twitchSocket = null;
  state.twitch = { key: 'off' };
}

function startTwitch() {
  if (DEMO) return;
  if (settings.sources === 'tiktok') { stopTwitch(); broadcast(); return; }

  const channel = cleanChannel(settings.twitchChannel);
  if (!channel) {
    stopTwitch();
    setState('twitch', 'no_channel');
    return;
  }

  twitchStopped = false;
  setState('twitch', 'connecting');

  twitchSocket = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
  const socket = twitchSocket;

  socket.addEventListener('open', () => {
    socket.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
    socket.send('PASS ' + ANON_PASSWORD);
    socket.send('NICK ' + anonUser());
    socket.send('JOIN #' + channel);
    twitchBackoff = 1000;
    setState('twitch', 'connected', channel);
    console.log(`Twitch: joined #${channel}`);
  });

  socket.addEventListener('message', (event) => {
    for (const line of String(event.data).split('\r\n')) {
      if (!line) continue;
      if (line.startsWith('PING')) { socket.send('PONG :tmi.twitch.tv'); continue; }

      const message = parseIrc(line);
      if (message.command !== 'PRIVMSG') continue;

      const name = message.tags['display-name'] || message.prefix.split('!')[0];
      handleMessage('twitch', name, message.text);
    }
  });

  socket.addEventListener('error', () => { /* the close handler deals with it */ });

  socket.addEventListener('close', () => {
    if (twitchStopped || socket !== twitchSocket) return;
    setState('twitch', 'retrying');
    twitchTimer = setTimeout(startTwitch, twitchBackoff);
    twitchBackoff = Math.min(twitchBackoff * 2, 30000);
  });
}

/* TikTok -------------------------------------------------------------------
   There is no public API for live chat, so this reads the local Event API of
   TikFinity Desktop, which has to run on the same machine and be signed in. */

function tiktokName(data) {
  return data.nickname || data.uniqueId || data.displayName || data.userName || data.username ||
         (data.user && (data.user.nickname || data.user.uniqueId || data.user.displayName)) || '';
}

function tiktokText(data) {
  return data.comment ?? data.message ?? data.text ?? data.content ?? '';
}

let tiktokSocket = null;
let tiktokTimer = null;
let tiktokStopped = true;
let tiktokBackoff = 1000;

function stopTiktok() {
  tiktokStopped = true;
  clearTimeout(tiktokTimer);
  if (tiktokSocket) {
    try { tiktokSocket.close(); } catch { /* already gone */ }
  }
  tiktokSocket = null;
  state.tiktok = { key: 'off' };
}

function startTiktok() {
  if (DEMO) return;
  if (settings.sources === 'twitch') { stopTiktok(); broadcast(); return; }

  tiktokStopped = false;
  setState('tiktok', 'looking');

  try {
    tiktokSocket = new WebSocket(settings.tikfinity);
  } catch {
    tiktokTimer = setTimeout(startTiktok, tiktokBackoff);
    return;
  }
  const socket = tiktokSocket;

  socket.addEventListener('open', () => {
    tiktokBackoff = 1000;
    setState('tiktok', 'connected', 'TikFinity');
    console.log('TikTok: connected to TikFinity');
  });

  socket.addEventListener('message', (event) => {
    let packet;
    try { packet = JSON.parse(String(event.data)); } catch { return; }

    const type = String(packet.event || packet.type || '').toLowerCase();
    if (type !== 'chat' && type !== 'comment') return;

    const data = packet.data || packet;
    handleMessage('tiktok', tiktokName(data), tiktokText(data));
  });

  socket.addEventListener('error', () => { /* the close handler deals with it */ });

  socket.addEventListener('close', () => {
    if (tiktokStopped || socket !== tiktokSocket) return;
    setState('tiktok', 'unreachable');
    tiktokTimer = setTimeout(startTiktok, tiktokBackoff);
    tiktokBackoff = Math.min(tiktokBackoff * 2, 15000);
  });
}

/* Demo mode: fake messages so the panel can be tried off stream. */

const SAMPLE_CHAT = [
  ['tiktok', 'first_viewer', '!queue I would love to play'],
  ['twitch', 'SecondViewer', '!queue happy to trade a spare item'],
  ['twitch', 'JustWatching', 'hello everyone, great stream'],
  ['tiktok', 'third.viewer', '!queue'],
  ['twitch', 'FourthInLine', '!queue looking for the blue one'],
  ['tiktok', 'fifth_viewer', '!queue first time here']
];

function startDemo() {
  let i = 0;
  state.twitch = { key: 'demo' };
  state.tiktok = { key: 'demo' };
  console.log('Demo mode: one fake message every three seconds.');
  setInterval(() => {
    const [platform, name, text] = SAMPLE_CHAT[i++ % SAMPLE_CHAT.length];
    handleMessage(platform, name, text);
  }, 3000);
}

/* Uploaded logo ------------------------------------------------------------
   The file arrives as the raw request body. The type comes from the first
   bytes rather than the file name. */

function imageKind(buffer) {
  if (buffer.length < 12) return null;
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
  if (buffer.slice(0, 3).toString('latin1') === 'GIF') return 'gif';
  if (buffer.slice(0, 4).toString('latin1') === 'RIFF' &&
      buffer.slice(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

function clearOldLogos(keep) {
  for (const ext of ['png', 'jpg', 'gif', 'webp']) {
    const name = 'logo.' + ext;
    if (name === keep) continue;
    try { fs.unlinkSync(path.join(PUBLIC_DIR, name)); } catch { /* wasn't there */ }
  }
}

/* HTTP ------------------------------------------------------------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
};

const SERVABLE = new Set([
  'index.html', 'styles.css', 'app.js', 'i18n.js', 'favicon.svg',
  'logo.png', 'logo.jpg', 'logo.gif', 'logo.webp'
]);

function sendFile(res, fileName) {
  const name = path.basename(fileName);
  if (!SERVABLE.has(name)) {
    res.writeHead(404);
    return res.end('Not found');
  }

  fs.readFile(path.join(PUBLIC_DIR, name), (err, buffer) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(name)] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(buffer);
  });
}

function sendJson(res, body, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 1e5) req.destroy();
    });
    req.on('end', () => {
      try { resolve(JSON.parse(raw)); } catch { resolve({}); }
    });
  });
}

function readBinary(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let overflow = false;

    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_LOGO_BYTES) {
        // stop keeping the data but let the upload finish, so the browser
        // gets a proper answer instead of a dropped connection
        overflow = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (overflow) reject(new Error('too large'));
      else resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

const HEX = /^#[0-9a-f]{6}$/i;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const route = url.pathname;

  if (route === '/' || route === '/overlay') return sendFile(res, 'index.html');
  if (route === '/styles.css') return sendFile(res, 'styles.css');
  if (route === '/app.js') return sendFile(res, 'app.js');
  if (route === '/i18n.js') return sendFile(res, 'i18n.js');
  if (route === '/favicon.svg' || route === '/favicon.ico') return sendFile(res, 'favicon.svg');
  if (route.startsWith('/logo.')) return sendFile(res, route.slice(1));

  if (route === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
    listeners.add(res);

    const ping = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { /* client went away */ }
    }, 25000);

    req.on('close', () => {
      clearInterval(ping);
      listeners.delete(res);
    });
    return;
  }

  if (route === '/api/state') return sendJson(res, snapshot());

  if (route === '/api/next' && req.method === 'POST') {
    return sendJson(res, { ok: true, called: callNext() });
  }

  if (route === '/api/remove' && req.method === 'POST') {
    return sendJson(res, { ok: removeById(Number(url.searchParams.get('id'))) });
  }

  if (route === '/api/clear' && req.method === 'POST') {
    queue = [];
    broadcast();
    return sendJson(res, { ok: true });
  }

  if (route === '/api/settings' && req.method === 'POST') {
    const body = await readJson(req);
    const previousChannel = settings.twitchChannel;
    const previousSources = settings.sources;
    const previousTikfinity = settings.tikfinity;

    if (['en', 'it'].includes(body.language)) settings.language = body.language;
    if (typeof body.panelTitle === 'string' && body.panelTitle.trim()) {
      settings.panelTitle = body.panelTitle.trim().slice(0, 40);
    }
    if (typeof body.overlayTitle === 'string' && body.overlayTitle.trim()) {
      settings.overlayTitle = body.overlayTitle.trim().slice(0, 40);
    }
    if (typeof body.twitchChannel === 'string') settings.twitchChannel = cleanChannel(body.twitchChannel);
    if (typeof body.keyword === 'string' && body.keyword.trim()) {
      settings.keyword = body.keyword.trim().toLowerCase().slice(0, 30);
    }
    if (Number.isFinite(+body.queueLimit)) {
      settings.queueLimit = Math.min(Math.max(+body.queueLimit, 1), 999);
    }
    if (Number.isFinite(+body.overlayRows)) {
      settings.overlayRows = Math.min(Math.max(+body.overlayRows, 1), 30);
    }
    if (['both', 'twitch', 'tiktok'].includes(body.sources)) settings.sources = body.sources;
    if (typeof body.blockDuplicates === 'boolean') settings.blockDuplicates = body.blockDuplicates;
    if (typeof body.tikfinity === 'string' && body.tikfinity.trim()) {
      settings.tikfinity = body.tikfinity.trim();
    }

    saveConfig();

    if (!DEMO) {
      if (settings.twitchChannel !== previousChannel || settings.sources !== previousSources) {
        stopTwitch();
        twitchBackoff = 1000;
        setTimeout(startTwitch, 250);
      }
      if (settings.tikfinity !== previousTikfinity || settings.sources !== previousSources) {
        stopTiktok();
        tiktokBackoff = 1000;
        setTimeout(startTiktok, 250);
      }
    }

    broadcast();
    return sendJson(res, { ok: true, settings });
  }

  if (route === '/api/theme' && req.method === 'POST') {
    const body = await readJson(req);

    if (body.reset === true) {
      settings.theme = { ...DEFAULT_THEME };
    } else {
      for (const key of Object.keys(DEFAULT_THEME)) {
        if (typeof body[key] === 'string' && HEX.test(body[key])) {
          settings.theme[key] = body[key].toLowerCase();
        }
      }
    }

    saveConfig();
    broadcast();
    return sendJson(res, { ok: true, theme: settings.theme });
  }

  if (route === '/api/logo' && req.method === 'POST') {
    let buffer;
    try {
      buffer = await readBinary(req);
    } catch {
      return sendJson(res, { ok: false, error: 'size' }, 413);
    }

    const kind = imageKind(buffer);
    if (!kind) return sendJson(res, { ok: false, error: 'format' }, 415);

    const fileName = 'logo.' + kind;
    try {
      fs.writeFileSync(path.join(PUBLIC_DIR, fileName), buffer);
    } catch (err) {
      console.log('Could not save the logo:', err.message);
      return sendJson(res, { ok: false, error: 'write' }, 500);
    }

    clearOldLogos(fileName);
    settings.logoFile = fileName;
    settings.logoVersion = (settings.logoVersion || 0) + 1;
    saveConfig();
    broadcast();
    console.log(`Logo saved as ${fileName} (${Math.round(buffer.length / 1024)} KB)`);
    return sendJson(res, { ok: true, logoFile: fileName });
  }

  if (route === '/api/logo/remove' && req.method === 'POST') {
    clearOldLogos(null);
    settings.logoFile = null;
    settings.logoVersion = (settings.logoVersion || 0) + 1;
    saveConfig();
    broadcast();
    return sendJson(res, { ok: true });
  }

  res.writeHead(404);
  res.end('Not found');
});

/* Startup ---------------------------------------------------------------- */

function lanAddress() {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return null;
}

function openBrowser(address) {
  const command = process.platform === 'win32' ? `start "" "${address}"`
                : process.platform === 'darwin' ? `open "${address}"`
                : `xdg-open "${address}"`;
  exec(command, () => { /* the address is printed below anyway */ });
}

loadConfig();

server.listen(settings.port, '0.0.0.0', () => {
  const local = 'http://localhost:' + settings.port;
  const lan = lanAddress();

  console.log('');
  console.log('  ' + settings.panelTitle);
  console.log('  ' + '-'.repeat(settings.panelTitle.length));
  console.log('');
  console.log('  Keyword        ' + settings.keyword);
  console.log('  Twitch channel ' + (settings.twitchChannel || 'not set yet'));
  console.log('');
  console.log('  Panel          ' + local);
  if (lan) console.log('  From a phone   http://' + lan + ':' + settings.port);
  console.log('  OBS overlay    ' + local + '/overlay');
  console.log('');
  if (DEMO) console.log('  Demo mode is on: fake messages, live chat is off.');
  console.log('  Leave this window open and minimise it.');
  console.log('  Closing it stops the program and clears the queue.');
  console.log('');

  if (!NO_BROWSER) openBrowser(local);

  if (DEMO) startDemo();
  else { startTwitch(); startTiktok(); }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log('');
    console.log(`  Port ${settings.port} is already in use.`);
    console.log('  The program is probably already running in another window.');
    console.log('  You can pick a different port with "port" in config.json.');
    console.log('');
  } else {
    console.log('Error:', err.message);
  }
});
