# Web stream viewer (phone / laptop testing)

Minimal internal UI to browse the Roku feed JSON and play HLS streams through your LAN proxy.

## Run with Docker

From repo root (or `web/`):

```bash
cd web
export FEED_URL='https://your-bucket/.../feed.json'
# Optional if feed proxy host is wrong for phones:
# export PROXY_REWRITE_FROM='192.168.1.50:8787'
# export PROXY_REWRITE_TO='192.168.1.50:8787'
docker compose up -d --build
```

Open `http://<server-lan-ip>:8080` on your phone (VPN).

## Env

| Variable | Purpose |
|----------|---------|
| `FEED_URL` | Default feed JSON URL (also editable in the UI) |
| `WEB_PORT` | Host port (default `8080`) |
| `PROXY_REWRITE_FROM` / `PROXY_REWRITE_TO` | Rewrite proxy host inside feed video URLs |

The browser never fetches the feed from S3/B2 directly (CORS). The container proxies `/api/feed`. Stream URLs still go straight from the phone to your HLS proxy (`:8787`).

## Local without Docker

```bash
cd web
npm install
FEED_URL='https://…/feed.json' npm start
```
