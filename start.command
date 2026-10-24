#!/bin/bash
# Double-click this file (or run it) to launch the PS1 emulator on localhost.
cd "$(dirname "$0")" || exit 1
PORT=8000
# Pick a free port starting at 8000.
while lsof -i :$PORT >/dev/null 2>&1; do PORT=$((PORT+1)); done
URL="http://localhost:$PORT/"
echo "Serving PS1 emulator at $URL"
echo "Press Ctrl+C to stop."
( sleep 1; open "$URL" ) &
exec python3 -m http.server "$PORT"
