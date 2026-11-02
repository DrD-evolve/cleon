#!/usr/bin/env bash
# Launch Cleon: start the server if it isn't running, then open the dashboard in its own
# Chrome app window (no tabs or address bar). The desktop shortcut runs this in a minimized Git Bash
# window; that window IS the server, so closing it stops the dashboard. ＋ Panels → Restart server makes
# the server exit with 75, and this script starts it again in the same window.
#
# Env: MC_PORT (default 4317), MC_NO_BROWSER=1 to skip opening the window (used when testing).
set -u
cd "$(dirname "$0")/.." || exit 1
PORT="${MC_PORT:-4317}"
URL="http://127.0.0.1:${PORT}/"
CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
RESTART_CODE=75 # RESTART_CODE in server.mjs

up() { curl -s -o /dev/null -m 2 "$URL"; }
open_ui() {
  [ "${MC_NO_BROWSER:-}" = 1 ] && return
  if [ -x "$CHROME" ]; then "$CHROME" --app="$URL" >/dev/null 2>&1 &
  else start "" "$URL"; fi   # no Chrome: the default browser
}

if up; then
  echo "Cleon is already running on $URL"
  open_ui
  exit 0
fi

echo "Starting Cleon on $URL (close this window to stop it)"
# Open the window once the server answers, without holding up the server itself.
( for _ in $(seq 1 40); do up && { open_ui; exit 0; }; sleep 0.25; done
  echo "Server didn't answer within 10s; check the output above." ) &
# MC_SUPERVISED tells the server a restart will be picked up here. Any other exit ends the script.
export MC_PORT="$PORT" MC_SUPERVISED=1
while :; do
  node server.mjs
  code=$?
  [ "$code" -eq "$RESTART_CODE" ] || exit "$code"
  echo "Restarting Cleon on $URL"
done
