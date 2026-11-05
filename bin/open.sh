#!/bin/bash
# Starts the tracker if it isn't already running, then opens it in Chrome.
set -u

# Apps launched from Finder or the Dock don't get your shell's PATH.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${AGENT_TRACKER_PORT:-47823}"
LOG="$ROOT/data/server.log"

is_running() {
  curl -fs -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/api/board"
}

if ! is_running; then
  mkdir -p "$ROOT/data"
  # Background only the server, with every stream detached. Anything left holding this
  # script's output makes the app that launched it wait forever.
  cd "$ROOT" || exit 1
  nohup node server.js </dev/null >>"$LOG" 2>&1 &
  for _ in {1..50}; do
    is_running && break
    sleep 0.2
  done
  if ! is_running; then
    echo "Agent Tracker didn't start. See $LOG" >&2
    exit 1
  fi
fi

URL="http://localhost:$PORT"
if open -Ra "Google Chrome" 2>/dev/null; then
  open -a "Google Chrome" "$URL"
else
  open "$URL"
fi
