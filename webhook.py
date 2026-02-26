#!/usr/bin/env python3
"""
Git Pull Webhook for FSM PWA.

Accepts POST /git-pull with X-Token header, runs 'sudo git pull origin main'
in this directory, and returns JSON { success, output }.

SETUP
─────
1. Set a secure token below (or export GIT_PULL_TOKEN=... before starting).

2. Allow git without a password prompt — create /etc/sudoers.d/pwa-git
   (replace 'youruser' with the Linux user this script runs as):

       youruser ALL=(ALL) NOPASSWD: /usr/bin/git pull origin main

3. Proxy through nginx so the HTTPS PWA can reach it:

       location /git-pull {
           proxy_pass         http://127.0.0.1:9876;
           proxy_set_header   X-Real-IP $remote_addr;
           proxy_read_timeout 90;
       }

   Reload nginx: sudo nginx -s reload

4. Run as a systemd service — /etc/systemd/system/fsm-gitpull.service:

       [Unit]
       Description=FSM PWA Git Pull Webhook
       After=network.target

       [Service]
       ExecStart=/usr/bin/python3 /path/to/field-worker-pwa/webhook.py
       WorkingDirectory=/path/to/field-worker-pwa
       User=youruser
       Restart=on-failure

       [Install]
       WantedBy=multi-user.target

   Then: sudo systemctl enable --now fsm-gitpull
"""
import http.server
import json
import os
import subprocess

PORT = int(os.environ.get('GIT_PULL_PORT', '9876'))
TOKEN = os.environ.get('GIT_PULL_TOKEN', 'CHANGE_ME_SECRET')
REPO_DIR = os.path.dirname(os.path.abspath(__file__))


class Handler(http.server.BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self._respond(200, None)

    def do_POST(self):
        if self.path != '/git-pull':
            self._respond(404, {'error': 'Not found'})
            return
        if self.headers.get('X-Token', '') != TOKEN:
            self._respond(403, {'error': 'Unauthorized'})
            return
        try:
            result = subprocess.run(
                ['sudo', 'git', 'pull', 'origin', 'main'],
                cwd=REPO_DIR,
                capture_output=True,
                text=True,
                timeout=60,
            )
            output = (result.stdout + result.stderr).strip()
            self._respond(200, {'success': result.returncode == 0, 'output': output})
        except Exception as e:
            self._respond(500, {'success': False, 'output': str(e)})

    def _respond(self, code, body):
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'X-Token, Content-Type')
        self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
        self.end_headers()
        if body is not None:
            self.wfile.write(json.dumps(body).encode())

    def log_message(self, fmt, *args):
        print(f'[git-pull] {fmt % args}')


if __name__ == '__main__':
    if TOKEN == 'CHANGE_ME_SECRET':
        print('WARNING: Using default token. Set GIT_PULL_TOKEN env var or edit webhook.py.')
    print(f'Listening on 127.0.0.1:{PORT}  —  repo: {REPO_DIR}')
    server = http.server.HTTPServer(('127.0.0.1', PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nStopped.')
        server.server_close()
