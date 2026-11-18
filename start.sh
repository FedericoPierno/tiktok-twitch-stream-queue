#!/usr/bin/env bash
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "  Node.js is not installed."
  echo "  Get the LTS build from https://nodejs.org and try again."
  echo
  exit 1
fi

node server.js "$@"
