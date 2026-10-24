#!/bin/bash
# Double-click in Finder to start the Unspoken demo and a public link.
# Keep this window open while people use the link. Close it (or press Ctrl+C) to stop.
cd "$(dirname "$0")"

if [ ! -x ./bin/cloudflared ]; then
  echo "cloudflared is missing. Download it from"
  echo "https://github.com/cloudflare/cloudflared/releases (cloudflared-darwin-arm64.tgz on Apple silicon),"
  echo "unpack it, and put the cloudflared file in the bin/ folder next to this script."
  read -r -p "Press Enter to close." _
  exit 1
fi

if ! lsof -ti tcp:3100 -sTCP:LISTEN >/dev/null; then
  node --disable-warning=ExperimentalWarning server.js &
  SERVER_PID=$!
  sleep 1
fi

LOG=$(mktemp)
./bin/cloudflared tunnel --no-autoupdate --protocol http2 --url http://127.0.0.1:3100 >"$LOG" 2>&1 &
TUNNEL_PID=$!
trap 'kill $TUNNEL_PID $SERVER_PID 2>/dev/null; rm -f "$LOG"' EXIT

echo "Starting public link..."
for i in $(seq 1 30); do
  URL=$(grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" "$LOG" | head -1)
  [ -n "$URL" ] && break
  sleep 1
done

if [ -z "$URL" ]; then
  echo "Could not start the public link. Details:"
  cat "$LOG"
  exit 1
fi

echo ""
echo "=============================================="
echo "  Public link (send this to the client):"
echo "  $URL"
echo "=============================================="
echo ""
echo "Keep this window open. Close it to stop the demo."
wait $TUNNEL_PID
