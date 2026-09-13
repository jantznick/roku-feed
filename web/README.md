# Web stream viewer (phone / laptop testing)

Minimal internal UI to browse the Roku feed JSON and play HLS streams through your LAN proxy.

Feed URL is configured only via `FEED_URL` (no paste UI).

## Run with Docker

```bash
cd web
export FEED_URL='https://your-bucket/.../feed.json'
# When the site is HTTPS, point at your LAN HLS proxy (avoids Mixed Content):
export HLS_PROXY_UPSTREAM='http://192.168.1.50:8787'
# Optional host port if 8080 is taken:
export WEB_PORT=8091
docker compose up -d --build
```

Open `http://<server-lan-ip>:$WEB_PORT` (default **8080**), or your reverse-proxied HTTPS hostname.

## Env

| Variable | Purpose |
|----------|---------|
| `FEED_URL` | Required. Feed JSON URL |
| `WEB_PORT` | Host port mapped to the container (default `8080`) |
| `HLS_PROXY_UPSTREAM` | LAN HLS proxy origin (e.g. `http://192.168.1.50:8787`). Rewrites feed + m3u8 URLs to same-origin `/hls` and proxies traffic. **Required for HTTPS viewers.** |
| `PROXY_REWRITE_FROM` / `PROXY_REWRITE_TO` | Optional extra host rewrite inside feed video URLs |

The browser never fetches the feed from S3/B2 directly (CORS). The container proxies `/api/feed`.

With `HLS_PROXY_UPSTREAM` set:
- Server can rewrite feed/m3u8 URLs to `/hls…` and proxies `/hls` → the LAN proxy
- The **browser also rewrites** any leftover `http://192.168…/proxy…` URLs to `/hls…` before hls.js loads them (and again for each segment request)

Without `HLS_PROXY_UPSTREAM`, `/hls` cannot proxy anywhere — HTTPS pages will still block plain `http://` LAN URLs.

## Reverse proxy (HTTPS)

If you terminate TLS in Caddy/nginx/Traefik in front of this container, **forward the whole host** (or at least `/`, `/api`, and `/hls`) to the container.

`/hls` must reach Node. If your proxy only sends `/api` upstream and uses `try_files` → `index.html` for everything else, the browser will get HTML for `/hls/proxy/…` and playback will fail.

**Quick check** (should NOT be `text/html`):

```bash
curl -sI https://your-host/api/config
curl -sI "https://your-host/hls/proxy/test"
# Expect: application/json for config; 502/503 text/plain (or m3u8) for /hls — never text/html
docker exec roku-feed-web printenv HLS_PROXY_UPSTREAM
```

Example Caddy site block:

```caddy
sports.example.com {
  reverse_proxy 127.0.0.1:8090
}
```

## Local without Docker

```bash
cd web
npm install
FEED_URL='https://…/feed.json' \
HLS_PROXY_UPSTREAM='http://192.168.1.50:8787' \
PORT=8091 npm start
```

`PORT` is the Node listen port when not using Docker. With Docker, leave container `PORT=8080` and change **`WEB_PORT`** on the host instead.
