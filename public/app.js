/*
 * Live Queue
 * Copyright (c) 2026 Federico Pierno
 * MIT License with the Commons Clause. See LICENSE.
 */

(function () {
  'use strict';

  var overlayMode = location.pathname === '/overlay' ||
                    new URLSearchParams(location.search).get('overlay') === '1';
  if (overlayMode) document.body.classList.add('overlay');

  var COLOUR_KEYS = ['accent', 'bg', 'surface', 'border', 'text', 'twitch', 'tiktok'];

  var COLOUR_LABELS = {
    en: { accent: 'Accent', bg: 'Background', surface: 'Panels', border: 'Borders', text: 'Text', twitch: 'Twitch', tiktok: 'TikTok' },
    it: { accent: 'Colore principale', bg: 'Sfondo', surface: 'Riquadri', border: 'Contorni', text: 'Testo', twitch: 'Twitch', tiktok: 'TikTok' }
  };

  var PLATFORMS = { twitch: 'Twitch', tiktok: 'TikTok' };

  var queueEl = document.getElementById('queue');
  var sidebar = document.getElementById('sidebar');
  var scrim = document.getElementById('scrim');
  var callNext = document.getElementById('call-next');
  var clearBtn = document.getElementById('clear-queue');
  var swatches = document.getElementById('swatches');

  var lang = 'en';
  var theme = null;
  var editing = false;
  var swatchesReady = false;

  function t(key, vars) {
    var dict = window.STRINGS[lang] || window.STRINGS.en;
    var s = dict[key] || window.STRINGS.en[key] || key;
    if (vars) {
      Object.keys(vars).forEach(function (k) {
        s = s.replace('{' + k + '}', vars[k]);
      });
    }
    return s;
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function clock(iso) {
    var d = new Date(iso);
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }

  function toast(id, message, bad) {
    var el = document.getElementById(id);
    el.textContent = message;
    el.classList.toggle('bad', !!bad);
    if (message) {
      setTimeout(function () {
        if (el.textContent === message) el.textContent = '';
      }, 2600);
    }
  }

  function post(url, body) {
    var options = { method: 'POST' };
    if (body !== undefined) {
      options.headers = { 'Content-Type': 'application/json' };
      options.body = JSON.stringify(body);
    }
    return fetch(url, options);
  }

  // colour helpers

  function rgb(hex) {
    var h = String(hex).replace('#', '');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }

  function hex(r, g, b) {
    return '#' + [r, g, b].map(function (v) {
      return ('0' + Math.round(Math.max(0, Math.min(255, v))).toString(16)).slice(-2);
    }).join('');
  }

  function blend(a, b, amount) {
    var x = rgb(a), y = rgb(b);
    return hex(x[0] + (y[0] - x[0]) * amount, x[1] + (y[1] - x[1]) * amount, x[2] + (y[2] - x[2]) * amount);
  }

  function isLight(colour) {
    var c = rgb(colour);
    return (c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114) > 150;
  }

  function fade(colour, alpha) {
    var c = rgb(colour);
    return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + alpha + ')';
  }

  function paint(colours) {
    var root = document.documentElement.style;
    COLOUR_KEYS.forEach(function (key) { root.setProperty('--' + key, colours[key]); });
    root.setProperty('--surface-2', blend(colours.surface, colours.accent, 0.13));
    root.setProperty('--muted', blend(colours.text, colours.bg, 0.45));
    root.setProperty('--on-accent', isLight(colours.accent) ? '#141414' : '#ffffff');
    root.setProperty('--accent-glow', fade(colours.accent, 0.3));
  }

  function buildSwatches(colours) {
    swatches.innerHTML = COLOUR_KEYS.map(function (key) {
      var label = (COLOUR_LABELS[lang] || COLOUR_LABELS.en)[key];
      return '<label class="swatch">' +
               '<input type="color" data-key="' + key + '" value="' + colours[key] + '">' +
               '<span><b>' + label + '</b><code data-hex="' + key + '">' + colours[key] + '</code></span>' +
             '</label>';
    }).join('');
    swatchesReady = true;
  }

  function refreshSwatches(colours) {
    if (!swatchesReady) { buildSwatches(colours); return; }
    COLOUR_KEYS.forEach(function (key) {
      var input = swatches.querySelector('input[data-key="' + key + '"]');
      if (input && input.value.toLowerCase() !== colours[key].toLowerCase()) {
        input.value = colours[key];
        swatches.querySelector('[data-hex="' + key + '"]').textContent = colours[key];
      }
    });
  }

  swatches.addEventListener('input', function (e) {
    var input = e.target.closest('input[type="color"]');
    if (!input || !theme) return;
    theme[input.dataset.key] = input.value;
    swatches.querySelector('[data-hex="' + input.dataset.key + '"]').textContent = input.value;
    paint(theme);
    drawLogo(currentLogo, currentVersion);
  });

  swatches.addEventListener('change', function (e) {
    if (!e.target.closest('input[type="color"]') || !theme) return;
    post('/api/theme', theme)
      .then(function () { toast('toast-colours', t('savedColours')); })
      .catch(function () { toast('toast-colours', t('failed'), true); });
  });

  document.getElementById('reset-colours').addEventListener('click', function () {
    post('/api/theme', { reset: true })
      .then(function () { toast('toast-colours', t('coloursReset')); })
      .catch(function () { toast('toast-colours', t('failed'), true); });
  });

  // logo

  var currentLogo = null;
  var currentVersion = 0;

  function placeholder() {
    var a = theme ? theme.accent : '#2f80ed';
    var b = theme ? blend(theme.text, theme.bg, 0.5) : '#8b93a1';
    return '<svg viewBox="0 0 64 64" aria-hidden="true">' +
             '<circle cx="17" cy="20" r="5" fill="' + a + '"/>' +
             '<rect x="28" y="16.5" width="22" height="7" rx="3.5" fill="' + a + '"/>' +
             '<circle cx="17" cy="32" r="5" fill="' + b + '"/>' +
             '<rect x="28" y="28.5" width="22" height="7" rx="3.5" fill="' + b + '"/>' +
             '<circle cx="17" cy="44" r="5" fill="' + b + '" opacity=".5"/>' +
             '<rect x="28" y="40.5" width="22" height="7" rx="3.5" fill="' + b + '" opacity=".5"/>' +
           '</svg>';
  }

  function drawLogo(file, version) {
    currentLogo = file;
    currentVersion = version;
    var html = file
      ? '<img src="/' + file + '?v=' + version + '" alt="">'
      : placeholder();
    ['brand-mark', 'overlay-mark', 'logo-preview'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.innerHTML = html;
    });
  }

  function uploadLogo(file) {
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { toast('toast-logo', t('tooLarge'), true); return; }

    fetch('/api/logo', {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.ok) toast('toast-logo', t('logoUploaded'));
        else toast('toast-logo', data.error === 'format' ? t('badFormat') : t('tooLarge'), true);
      })
      .catch(function () { toast('toast-logo', t('failed'), true); });
  }

  var dropzone = document.getElementById('dropzone');
  var logoInput = document.getElementById('logo-input');

  document.getElementById('pick-logo').addEventListener('click', function () { logoInput.click(); });
  logoInput.addEventListener('change', function () { uploadLogo(this.files[0]); this.value = ''; });

  document.getElementById('drop-logo').addEventListener('click', function () {
    post('/api/logo/remove')
      .then(function () { toast('toast-logo', t('logoRemoved')); })
      .catch(function () { toast('toast-logo', t('failed'), true); });
  });

  ['dragenter', 'dragover'].forEach(function (type) {
    dropzone.addEventListener(type, function (e) { e.preventDefault(); dropzone.classList.add('hover'); });
  });
  ['dragleave', 'drop'].forEach(function (type) {
    dropzone.addEventListener(type, function (e) { e.preventDefault(); dropzone.classList.remove('hover'); });
  });
  dropzone.addEventListener('drop', function (e) {
    if (e.dataTransfer.files && e.dataTransfer.files[0]) uploadLogo(e.dataTransfer.files[0]);
  });

  // translation of the static markup

  function translate() {
    document.querySelectorAll('[data-t]').forEach(function (el) {
      el.textContent = t(el.dataset.t);
    });
    document.getElementById('hint').innerHTML =
      t('hint', { key: '<kbd>N</kbd>', x: '<kbd>&times;</kbd>' });
    document.getElementById('open-menu').setAttribute('aria-label', t('settings'));
    document.documentElement.lang = lang;
    if (swatchesReady && theme) buildSwatches(theme);
  }

  // status lights

  function setLight(dotId, labelId, name, state) {
    var map = window.STATE_MAP[state.key] || window.STATE_MAP.off;
    var text = t(map.key);
    if (state.detail) text += ' ' + state.detail;
    document.getElementById(dotId).className = 'dot' + (map.dot ? ' ' + map.dot : '');
    document.getElementById(labelId).textContent = name + ' · ' + text;
  }

  // settings form

  function fillForm(settings) {
    if (editing) return;
    document.getElementById('f-keyword').value = settings.keyword;
    document.getElementById('f-channel').value = settings.twitchChannel;
    document.getElementById('f-sources').value = settings.sources;
    document.getElementById('f-limit').value = settings.queueLimit;
    document.getElementById('f-rows').value = settings.overlayRows;
    document.getElementById('f-duplicates').checked = settings.blockDuplicates;
    document.getElementById('f-tikfinity').value = settings.tikfinity;
    document.getElementById('f-title').value = settings.panelTitle;
    document.getElementById('f-overlay-title').value = settings.overlayTitle;
    document.getElementById('f-language').value = settings.language;
    document.getElementById('addr-panel').textContent = location.origin;
    document.getElementById('addr-overlay').textContent = location.origin + '/overlay';
  }

  document.getElementById('save-settings').addEventListener('click', function () {
    editing = false;
    post('/api/settings', {
      keyword: document.getElementById('f-keyword').value,
      twitchChannel: document.getElementById('f-channel').value,
      sources: document.getElementById('f-sources').value,
      queueLimit: Number(document.getElementById('f-limit').value),
      overlayRows: Number(document.getElementById('f-rows').value),
      blockDuplicates: document.getElementById('f-duplicates').checked,
      tikfinity: document.getElementById('f-tikfinity').value,
      panelTitle: document.getElementById('f-title').value,
      overlayTitle: document.getElementById('f-overlay-title').value
    })
      .then(function () { toast('toast-settings', t('savedSettings')); })
      .catch(function () { toast('toast-settings', t('failed'), true); });
  });

  document.getElementById('f-language').addEventListener('change', function () {
    post('/api/settings', { language: this.value }).catch(function () {});
  });

  sidebar.addEventListener('focusin', function (e) {
    if (/INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) editing = true;
  });
  sidebar.addEventListener('focusout', function () {
    setTimeout(function () {
      if (!sidebar.contains(document.activeElement)) editing = false;
    }, 120);
  });

  // rendering

  function render(snapshot) {
    var settings = snapshot.settings;

    if (settings.language !== lang) {
      lang = settings.language;
      translate();
    }

    theme = Object.assign({}, settings.theme);
    paint(theme);
    if (!swatches.querySelector('input:focus')) refreshSwatches(settings.theme);
    drawLogo(settings.logoFile, settings.logoVersion);

    document.title = settings.panelTitle;
    document.getElementById('panel-title').textContent = settings.panelTitle;
    document.getElementById('overlay-title').textContent = settings.overlayTitle;
    document.getElementById('keyword-echo').textContent = settings.keyword;
    document.getElementById('count-waiting').textContent = snapshot.queue.length;
    document.getElementById('count-called').textContent = snapshot.called;
    document.getElementById('overlay-count').textContent = t('overlayWaiting', { count: snapshot.queue.length });

    callNext.disabled = snapshot.queue.length === 0;
    clearBtn.disabled = snapshot.queue.length === 0;

    setLight('dot-twitch', 'label-twitch', 'Twitch', snapshot.state.twitch);
    setLight('dot-tiktok', 'label-tiktok', 'TikTok', snapshot.state.tiktok);
    fillForm(settings);

    var rows = overlayMode ? snapshot.queue.slice(0, settings.overlayRows) : snapshot.queue;

    if (rows.length === 0) {
      queueEl.innerHTML = overlayMode ? '' :
        '<div class="empty"><strong>' + t('emptyTitle') + '</strong>' +
        t('emptyBody', { keyword: '<code>' + escapeHtml(settings.keyword) + '</code>' }) + '</div>';
      return;
    }

    queueEl.innerHTML = rows.map(function (entry, i) {
      var from = 'from-' + entry.platform;
      return '<div class="entry ' + from + (i === 0 ? ' is-next' : '') + '">' +
               '<div class="rank">' + (i + 1) + '</div>' +
               '<div class="who">' +
                 '<div class="who-line">' +
                   '<span class="handle">' + escapeHtml(entry.name) + '</span>' +
                   '<span class="badge ' + from + '">' + (PLATFORMS[entry.platform] || entry.platform) + '</span>' +
                 '</div>' +
                 (entry.message ? '<div class="said">' + escapeHtml(entry.message) + '</div>' : '') +
               '</div>' +
               '<div class="time">' + clock(entry.at) + '</div>' +
               '<button class="remove" data-id="' + entry.id + '" ' +
                 'aria-label="' + escapeHtml(t('removeFrom', { name: entry.name })) + '">×</button>' +
             '</div>';
    }).join('');
  }

  // queue controls

  callNext.addEventListener('click', function () { post('/api/next').catch(function () {}); });
  clearBtn.addEventListener('click', function () { post('/api/clear').catch(function () {}); });

  queueEl.addEventListener('click', function (e) {
    var button = e.target.closest('.remove');
    if (button) post('/api/remove?id=' + button.dataset.id).catch(function () {});
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && sidebar.classList.contains('open')) { closeMenu(); return; }
    if (/INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
    if (e.key.toLowerCase() === 'n' && !e.ctrlKey && !e.metaKey && !e.altKey && !callNext.disabled) {
      post('/api/next').catch(function () {});
    }
  });

  // sidebar

  function openMenu() {
    sidebar.classList.add('open');
    scrim.classList.add('open');
    sidebar.setAttribute('aria-hidden', 'false');
    document.getElementById('open-menu').setAttribute('aria-expanded', 'true');
    document.getElementById('close-menu').focus();
  }

  function closeMenu() {
    sidebar.classList.remove('open');
    scrim.classList.remove('open');
    sidebar.setAttribute('aria-hidden', 'true');
    document.getElementById('open-menu').setAttribute('aria-expanded', 'false');
    document.getElementById('open-menu').focus();
  }

  document.getElementById('open-menu').addEventListener('click', openMenu);
  document.getElementById('close-menu').addEventListener('click', closeMenu);
  scrim.addEventListener('click', closeMenu);

  // live updates, with a retry if the server goes away

  function listen() {
    var stream = new EventSource('/events');
    stream.onmessage = function (e) { render(JSON.parse(e.data)); };
    stream.onerror = function () {
      stream.close();
      setTimeout(listen, 2000);
    };
  }

  translate();
  listen();
})();
