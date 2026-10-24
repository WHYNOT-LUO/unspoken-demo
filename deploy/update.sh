#!/usr/bin/env bash
# Update Unspoken to the latest version on GitHub:   sudo bash /opt/unspoken/app/deploy/update.sh
# Takes a backup first, runs the tests, and only restarts the service if they pass.
set -euo pipefail
APP_DIR=/opt/unspoken/app
BACKUP_DIR=/var/backups/unspoken

if [[ $EUID -ne 0 ]]; then echo "Run as root: sudo bash $APP_DIR/deploy/update.sh"; exit 1; fi

echo "==> Backing up the database"
sudo -u unspoken bash -c "cd $APP_DIR && node --disable-warning=ExperimentalWarning scripts/admin.js backup $BACKUP_DIR/unspoken-before-update-$(date +%F-%H%M).db"

echo "==> Fetching the latest version"
before=$(git -C "$APP_DIR" rev-parse --short HEAD)
git -C "$APP_DIR" pull --ff-only
after=$(git -C "$APP_DIR" rev-parse --short HEAD)
if [[ "$before" == "$after" ]]; then echo "Already up to date ($after)."; exit 0; fi

echo "==> Running the tests"
if ! (cd "$APP_DIR" && node --disable-warning=ExperimentalWarning --test test/*.test.js >/tmp/unspoken-tests.log 2>&1); then
  echo "Tests failed; rolling back to $before. See /tmp/unspoken-tests.log"
  git -C "$APP_DIR" reset --hard "$before"
  exit 1
fi

echo "==> Restarting"
install -m 644 "$APP_DIR/deploy/unspoken.service" /etc/systemd/system/unspoken.service
systemctl daemon-reload
systemctl restart unspoken
sleep 2
systemctl is-active --quiet unspoken && echo "Updated $before -> $after and running." || { echo "Service failed to start: journalctl -u unspoken -n 50"; exit 1; }
