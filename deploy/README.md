# PWA server deployment

The PWA is served by `server.py` (serves the static files and proxies
`/web/*` and `/jsonrpc` to Odoo). On the production box it lives at
`/var/www/pwa` and runs as the `administrator` user on port `8080`, with an
HTTPS front-end (nginx/Cloudflare) in front of it.

## One-time: install as a systemd service

Run on the server after `git pull` brings `deploy/fsm-pwa.service` down:

```bash
# Confirm the python path matches the unit (ExecStart). Adjust the unit if not /usr/bin/python3:
which python3

# Install and enable (auto-start on boot, auto-restart on crash):
sudo cp /var/www/pwa/deploy/fsm-pwa.service /etc/systemd/system/fsm-pwa.service
sudo systemctl daemon-reload
sudo systemctl enable --now fsm-pwa

# Verify:
systemctl status fsm-pwa --no-pager
sudo ss -ltnp | grep :8080            # python3 should be listening
curl -sI http://localhost:8080/ | head -1   # HTTP/1.0 200 OK
```

## Day-to-day

```bash
sudo systemctl restart fsm-pwa        # reset the PWA server
sudo systemctl stop fsm-pwa           # stop
journalctl -u fsm-pwa -f              # tail logs (proxy + static request lines)
```

After deploying new static files (`git pull`), a restart isn't required for
the files themselves (they're served from disk), but bumping the service worker
cache version in `sw.js` is what makes devices pick up changed JS/CSS.
