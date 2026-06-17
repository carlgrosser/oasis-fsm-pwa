# PWA deployment (production)

In production the PWA is served by **nginx**, not by `server.py`:

- nginx serves the static files directly: `alias /var/www/pwa/;`
- nginx proxies the Odoo API (`/web/*`, `/jsonrpc`, longpolling) to the Odoo
  upstream, so there's no CORS problem and no app server to keep alive.
- Served on `www.oasispooltilecleaning.com` and `system.oasisholidaylighting.com`.

`server.py` in this repo is the **local dev server only** (serves the files and
proxies to Odoo so you can test at `http://localhost:8080`). It is NOT used on
the production box — don't add a systemd unit for it there.

## Deploying a change

```bash
# On the server, in the checkout that nginx serves:
cd /var/www/pwa
git pull
```

nginx picks up changed static files immediately — no restart needed. To make
**devices** load changed JS/CSS, bump the service-worker cache version in
`sw.js` (`CACHE_NAME = 'fsm-pwa-vNN'`); that's what invalidates each device's
cached copy.

If the PWA is unreachable, the thing to check/restart is nginx and the Odoo
upstream, not `server.py`:

```bash
systemctl is-active nginx
sudo nginx -t && sudo systemctl reload nginx
```

## Related: office app SSE server (`office-sse.service`)

Separate from the PWA. Runs `/var/www/office/server.py` as **www-data** (proxied
by nginx, e.g. `127.0.0.1:8081`) for the office app's real-time updates.

It must be able to write `/var/www/office/ics_config.json`. If it crash-loops
with `PermissionError: [Errno 13] ... ics_config.json`, a deploy left the files
owned by the deploy user; restore write access for the service user:

```bash
sudo chgrp www-data /var/www/office
sudo chmod g+w /var/www/office
sudo chown www-data:www-data /var/www/office/ics_config.json 2>/dev/null || true
sudo systemctl reset-failed office-sse
sudo systemctl restart office-sse
```
