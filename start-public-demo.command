#!/bin/bash
# Runs Unspoken on this Mac and shares it through a free Cloudflare quick tunnel.
# Double-click in Finder (or run in Terminal). Keep the window open; close it or press Ctrl+C to stop.
#
# While it runs it:
#   - keeps the Mac from sleeping (closing a laptop lid still sleeps it, so keep the lid open);
#   - restarts the server or the tunnel if either stops, or if the public link stops answering;
#   - copies the current link to the clipboard, saves it in data/public-link.txt,
#     and shows a notification whenever the link changes.
cd "$(dirname "$0")"

PORT=3100
LINK_FILE=data/public-link.txt
CHECK_EVERY=${CHECK_EVERY:-60}   # seconds between health checks
MAX_FAILS=${MAX_FAILS:-5}        # restart the tunnel after this many failed checks in a row

if [ ! -x ./bin/cloudflared ]; then
  echo "cloudflared is missing. Download it from"
  echo "https://github.com/cloudflare/cloudflared/releases (cloudflared-darwin-arm64.tgz on Apple silicon),"
  echo "unpack it, and put the cloudflared file in the bin/ folder next to this script."
  read -r -p "Press Enter to close." _
  exit 1
fi
if ! command -v node >/dev/null; then
  echo "Node.js is missing. Install Node.js 22 or later from https://nodejs.org"
  read -r -p "Press Enter to close." _
  exit 1
fi

mkdir -p data
LOG=$(mktemp -t unspoken-tunnel)
SERVER_PID=""
TUNNEL_PID=""
URL=""

cleanup() {
  kill $TUNNEL_PID $SERVER_PID 2>/dev/null
  rm -f "$LOG" "$LINK_FILE"
  echo
  echo "Stopped. The public link no longer works."
}
trap cleanup EXIT
trap 'exit 0' INT TERM HUP

# Keep the Mac awake for as long as this script runs.
caffeinate -ims -w $$ &

notify() {
  osascript -e "display notification \"$1\" with title \"Unspoken\"" >/dev/null 2>&1
}

server_up() {
  lsof -ti tcp:$PORT -sTCP:LISTEN >/dev/null 2>&1
}

start_server() {
  server_up && return 0
  node --disable-warning=ExperimentalWarning server.js >>data/server.log 2>&1 &
  SERVER_PID=$!
  for _ in $(seq 1 20); do
    curl -s -o /dev/null "http://127.0.0.1:$PORT/api/status" && return 0
    sleep 0.5
  done
  echo "The server did not start. See data/server.log"
  return 1
}

start_tunnel() {
  [ -n "$TUNNEL_PID" ] && kill "$TUNNEL_PID" 2>/dev/null
  : >"$LOG"
  # HTTP/2 also works behind VPNs and proxies that block the default QUIC connection.
  ./bin/cloudflared tunnel --no-autoupdate --protocol http2 --url "http://127.0.0.1:$PORT" >"$LOG" 2>&1 &
  TUNNEL_PID=$!
  URL=""
  for _ in $(seq 1 60); do
    URL=$(grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" "$LOG" | head -1)
    [ -n "$URL" ] && grep -q "Registered tunnel connection" "$LOG" && break
    sleep 1
  done
  if [ -z "$URL" ]; then
    echo "$(date '+%H:%M') Could not get a public link yet; will try again."
    return 1
  fi
  echo "$URL" >"$LINK_FILE"
  printf %s "$URL" | pbcopy
  echo
  echo "=============================================="
  echo "  $(date '+%H:%M')  Public link (copied to clipboard):"
  echo "  $URL"
  echo "=============================================="
  echo
  notify "New link copied: $URL"
}

public_ok() {
  [ -n "$URL" ] && curl -s -o /dev/null -w "%{http_code}" --max-time 15 "$URL/api/status" | grep -q 200
}

echo "Starting Unspoken. Keep this window open; close it to stop."
start_server || exit 1
start_tunnel

fails=0
while true; do
  sleep "$CHECK_EVERY" &
  wait $!   # waiting (instead of sleeping in the foreground) lets a stop signal take effect at once
  if ! server_up; then
    echo "$(date '+%H:%M') The server stopped; restarting it."
    start_server
  fi
  if [ -z "$URL" ] || ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
    echo "$(date '+%H:%M') The tunnel stopped; starting a new one (the link will change)."
    start_tunnel
    fails=0
    continue
  fi
  if public_ok; then
    fails=0
  else
    fails=$((fails + 1))
    echo "$(date '+%H:%M') The public link did not answer ($fails/$MAX_FAILS)."
    if [ "$fails" -ge "$MAX_FAILS" ]; then
      echo "$(date '+%H:%M') Starting a new tunnel (the link will change)."
      start_tunnel
      fails=0
    fi
  fi
done
