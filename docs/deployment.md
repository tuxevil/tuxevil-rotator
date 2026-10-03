# Deployment

## Option A: npm (Global Install)

```bash
npm install -g tuxevil-rotator
tuxevil-rotator login
tuxevil-rotator start
```

The proxy starts on `http://0.0.0.0:51200` by default. Dashboard at `http://localhost:51200/dashboard`.

## Option B: Clone from Source

```bash
git clone https://github.com/tuxevil/tuxevil-rotator.git
cd tuxevil-rotator
npm install
npm run login
npm start
```

## Option C: Docker

**Pre-built image (recommended):**

```bash
docker pull ghcr.io/tuxevil/tuxevil-rotator:latest
```

**Using Docker Compose:**

```bash
mkdir -p docker-data
docker compose up -d
```

The image is multi-arch (`linux/amd64`, `linux/arm64`). The compose file:
- Pulls `ghcr.io/tuxevil/tuxevil-rotator:latest`
- Persists data under `./docker-data` (mapped to `/data` in the container)
- Publishes the proxy on `127.0.0.1:51200` only (secure by default)
- Runs as non-root `node` user (UID/GID 1000)

To build locally from source instead, uncomment `build: .` in `docker-compose.yml`.

**Enable Virtual Keys and Spend Logging inside Docker:**

Add `TUXEVIL_ROTATOR_DATABASE_URL` to your compose environment block:

```yaml
environment:
  TUXEVIL_ROTATOR_DATABASE_URL: "postgres://user:pass@postgres_host:5432/rotatordb"
```

See [Setting up PostgreSQL](integrations/setup-postgresql.md) for a full setup guide.

**LAN access:**

By default the compose file binds to `127.0.0.1` only. To expose on the LAN, change the port mapping to `51200:51200` and ensure you are behind a firewall or reverse proxy.

Inside the container the rotator always listens on `0.0.0.0`, and it cannot see which host address the port is published on. The dashboard therefore lists **Proxy listens on all interfaces** as a note rather than a warning: the native and `/v1` proxy routes reach as far as the published port.

**Linux permissions:**

On Linux, ensure `docker-data` is writable by UID 1000:

```bash
sudo chown -R 1000:1000 docker-data
```

---

## Running as a systemd Service

Create `/etc/systemd/system/tuxevil-rotator.service`:

```ini
[Unit]
Description=Tuxevil Rotator
After=network.target

[Service]
Type=simple
User=your-user
WorkingDirectory=/path/to/tuxevil-rotator
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5
Environment=TUXEVIL_ROTATOR_BIND_HOST=127.0.0.1

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable tuxevil-rotator
sudo systemctl start tuxevil-rotator
sudo journalctl -u tuxevil-rotator -f
```

---

## Running with nohup

```bash
nohup npm start > rotator.log 2>&1 &
echo $! > rotator.pid
```

Stop it:

```bash
kill $(cat rotator.pid)
```

---

## Reverse Proxy with nginx

For HTTPS or custom domain setups, put the rotator behind nginx:

```nginx
server {
    listen 443 ssl;
    server_name rotator.your-domain.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:51200;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection '';
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 600s;
        chunked_transfer_encoding on;
    }
}
```

The `proxy_buffering off` and long `proxy_read_timeout` are important for SSE streaming, both for model responses and for the dashboard's live updates.

The dashboard signs in with a session cookie. Forwarding `Host` lets the rotator confirm that dashboard actions come from its own page (without it they fail with `403`), and `X-Forwarded-Proto` marks the cookie `Secure` when the proxy serves HTTPS.

---

## Updating

**npm install:**

```bash
npm install -g tuxevil-rotator@latest
```

Or use the one-click update button in the dashboard (auto-update notifications appear when a newer version is available).

**Docker:**

```bash
docker compose pull
docker compose up -d
```
