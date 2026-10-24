# Deploying Unspoken to a server

This guide puts Unspoken on a Hong Kong cloud server with its own domain and HTTPS. Hong Kong servers are reachable from mainland China and do not need ICP filing (备案).

> The scripts in this folder have been syntax-checked but not yet run on a real server. Expect the first run to need a small fix or two.

## What you need

| Item | Notes |
|---|---|
| A Hong Kong server | Tencent Cloud Lighthouse (轻量应用服务器) or Alibaba Cloud ECS, **Hong Kong region**, **Ubuntu 22.04 or 24.04**, 2 GB RAM is plenty. Roughly ¥30–60 per month. |
| A domain name | For example from Tencent Cloud, Alibaba Cloud, Namecheap or Cloudflare. HTTPS certificates are issued for domains, not bare IP addresses. |
| Your DeepSeek API key | The same key as in your local `.env`. |

## 1. Create the server

1. In the cloud console, create the server: Hong Kong region, Ubuntu 24.04.
2. Set a root password or add your SSH key.
3. In the server's **firewall / security group**, allow TCP ports **22, 80 and 443**. The cloud firewall is separate from the server's own firewall, and both must be open.
4. Note the server's public IP address.

## 2. Point your domain at the server

At your domain registrar, add a DNS record:

| Type | Name | Value |
|---|---|---|
| A | `@` (or a subdomain such as `app`) | the server's public IP |

Wait until `ping your-domain.com` shows the server's IP. This takes a few minutes, occasionally longer.

## 3. Run the setup script

Connect to the server (from Terminal on a Mac):

```bash
ssh root@SERVER_IP
```

Then, on the server:

```bash
curl -fsSL https://raw.githubusercontent.com/WHYNOT-LUO/unspoken-demo/main/deploy/setup.sh -o setup.sh
sudo bash setup.sh your-domain.com
```

The script takes a few minutes. It:

- installs Node.js 22, Git and Caddy (the web server that gets HTTPS certificates automatically);
- creates a system user `unspoken` with no login shell;
- installs the app in `/opt/unspoken/app` and keeps data in `/var/lib/unspoken`;
- runs the test suite, and stops if anything fails;
- starts the app as a service that restarts on crashes and on reboot;
- configures HTTPS for your domain;
- opens the firewall for SSH, HTTP and HTTPS only;
- schedules a database backup every night at 03:30, keeping 14 days.

## 4. Add the API key

```bash
sudo nano /opt/unspoken/app/.env
```

Put your key after `LLM_API_KEY=`, save (Ctrl+O, Enter, Ctrl+X), then:

```bash
sudo systemctl restart unspoken
```

## 5. Invite people

Create invite codes on the server. The number is how many sign-ups each code allows:

```bash
cd /opt/unspoken/app
sudo -u unspoken node --disable-warning=ExperimentalWarning scripts/admin.js invite 10 "first test group"
```

Send people the address `https://your-domain.com` and the code. On a phone they can use **Add to Home Screen** (iPhone: Safari share menu; Android: Chrome menu) to install it like an app.

## Everyday administration

All admin commands run on the server, from `/opt/unspoken/app`, as the `unspoken` user:

```bash
cd /opt/unspoken/app
alias unspoken-admin='sudo -u unspoken node --disable-warning=ExperimentalWarning scripts/admin.js'
```

| Task | Command |
|---|---|
| Create an invite code | `unspoken-admin invite 5 "note to self"` |
| List invite codes | `unspoken-admin invites` |
| List accounts | `unspoken-admin users` |
| Someone forgot their password | `unspoken-admin reset-password person@example.com`, then send them the temporary password privately; they change it under **Account** |
| Delete an account and its data | `unspoken-admin delete-user person@example.com` |
| Back up now | `unspoken-admin backup /var/backups/unspoken/manual.db` |

| To see… | Command |
|---|---|
| Whether the app is running | `systemctl status unspoken` |
| The app's log | `journalctl -u unspoken -n 100` |
| Caddy / HTTPS problems | `journalctl -u caddy -n 100` |

## Updating to a new version

After new code is pushed to GitHub:

```bash
sudo bash /opt/unspoken/app/deploy/update.sh
```

It backs up the database, pulls the new version, runs the tests, and restarts only if they pass. If they fail, it rolls the code back and leaves the running app untouched.

## Restoring a backup

```bash
sudo systemctl stop unspoken
sudo -u unspoken cp /var/backups/unspoken/unspoken-YYYY-MM-DD.db /var/lib/unspoken/unspoken.db
sudo rm -f /var/lib/unspoken/unspoken.db-wal /var/lib/unspoken/unspoken.db-shm
sudo systemctl start unspoken
```

Backups stay on the same server. For safety, copy one off the server now and then, for example `scp root@SERVER_IP:/var/backups/unspoken/unspoken-YYYY-MM-DD.db .` on your Mac.

## What the server stores

`/var/lib/unspoken/unspoken.db` holds accounts (email and a salted scrypt hash of the password, never the password itself), session token hashes, invite codes, and each user's notes, uploaded materials (extracted text) and course progress. Anyone with root access to the server can read this file, so keep the server's login secure.
