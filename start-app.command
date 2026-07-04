#!/bin/zsh
# Start de Portfolio Tracker via een lokale server (nodig voor live koersen).
# Dubbelklik dit bestand in Finder.
cd "$(dirname "$0")"
PORT=8642
if ! lsof -i ":$PORT" >/dev/null 2>&1; then
  nohup python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 &
  sleep 1
fi
open "http://127.0.0.1:$PORT/index.html"
