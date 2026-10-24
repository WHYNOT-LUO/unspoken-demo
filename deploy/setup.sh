#!/usr/bin/env bash
# One-time setup of Unspoken on a fresh Ubuntu 22.04 / 24.04 server.
#
#   sudo bash setup.sh your-domain.com
#
# Installs Node.js 22 and Caddy (automatic HTTPS), creates a locked-down "unspoken" user,
# installs the app under /opt/unspoken/app, stores data in /var/lib/unspoken, runs the app
# as a systemd service, opens the firewall for SSH/HTTP/HTTPS, and schedules nightly backups.
# Safe to run again: existing data, .env and backups are kept.
set -euo pipefail

DOMAIN="${1:-}"
REPO="${REPO:-https://github.com/WHYNOT-LUO/unspoken-demo.git}"
APP_DIR=/opt/unspoken/app
DATA_DIR=/var/lib/unspoken
BACKUP_DIR=/var/backups/unspoken

if [[ $EUID -ne 0 ]]; then echo "Run as root: sudo bash setup.sh your-domain.com"; exit 1; fi
if [[ -z "$DOMAIN" ]]; then echo "Usage: sudo bash setup.sh your-domain.com"; exit 1; fi
if ! grep -qE '^ID=ubuntu' /etc/os-release; then echo "This script expects Ubuntu."; exit 1; fi

step() { echo; echo "==> $*"; }

step "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl git gnupg ufw debian-keyring debian-archive-keyring apt-transport-https

step "Installing Node.js 22"
node_ok() { node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 13) ? 0 : 1)' 2>/dev/null; }
if ! command -v node >/dev/null || ! node_ok; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node --version

step "Installing Caddy (web server with automatic HTTPS)"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

step "Creating the unspoken user and folders"
id unspoken >/dev/null 2>&1 || useradd --system --home /opt/unspoken --shell /usr/sbin/nologin unspoken
mkdir -p /opt/unspoken "$DATA_DIR" "$BACKUP_DIR"
chown unspoken:unspoken "$DATA_DIR" "$BACKUP_DIR"
chmod 700 "$DATA_DIR" "$BACKUP_DIR"

step "Installing the app"
if [[ -d "$APP_DIR/.git" ]]; then
  git -C "$APP_DIR" pull --ff-only
else
  git clone "$REPO" "$APP_DIR"
fi

if [[ ! -f "$APP_DIR/.env" ]]; then
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  sed -i -E "s#^HOST=.*#HOST=127.0.0.1#; s#^PORT=.*#PORT=3100#; s#^DATA_DIR=.*#DATA_DIR=$DATA_DIR#; s#^\# ?SECURE_COOKIES=.*#SECURE_COOKIES=1#" "$APP_DIR/.env"
fi
chown -R root:root "$APP_DIR"
chown unspoken:unspoken "$APP_DIR/.env"
chmod 600 "$APP_DIR/.env"

step "Checking the app"
(cd "$APP_DIR" && node --disable-warning=ExperimentalWarning --test test/*.test.js >/tmp/unspoken-tests.log 2>&1) \
  && echo "All tests passed." \
  || { echo "Tests failed; see /tmp/unspoken-tests.log"; exit 1; }

step "Installing the service"
install -m 644 "$APP_DIR/deploy/unspoken.service" /etc/systemd/system/unspoken.service
systemctl daemon-reload
systemctl enable unspoken
systemctl restart unspoken

step "Configuring HTTPS for $DOMAIN"
sed "s/YOUR_DOMAIN/$DOMAIN/" "$APP_DIR/deploy/Caddyfile" > /etc/caddy/Caddyfile
systemctl reload caddy || systemctl restart caddy

step "Scheduling nightly backups (kept 14 days)"
install -m 644 "$APP_DIR/deploy/unspoken-backup.cron" /etc/cron.d/unspoken-backup

step "Opening the firewall (SSH, HTTP, HTTPS)"
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null
ufw status | sed -n '1,8p'

sleep 2
if systemctl is-active --quiet unspoken; then
  echo; echo "Unspoken is running."
else
  echo; echo "The service did not start. Check: journalctl -u unspoken -n 50"; exit 1
fi

cat <<EOF

Next steps
  1. Add your DeepSeek key:   sudo nano $APP_DIR/.env      (then: sudo systemctl restart unspoken)
  2. Create invite codes:     sudo -u unspoken bash -c 'cd $APP_DIR && node --disable-warning=ExperimentalWarning scripts/admin.js invite 10'
  3. Open https://$DOMAIN     (the HTTPS certificate is issued on the first visit; this needs DNS
                               pointing here and ports 80/443 open in your cloud provider's firewall too)
EOF
