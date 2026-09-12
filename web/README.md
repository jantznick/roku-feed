# Web stream viewer (phone / laptop testing)

Minimal internal UI to browse the Roku feed JSON and play HLS streams through your LAN proxy.

Feed URL is configured only via `FEED_URL` (no paste UI).

## Run with Docker

```bash
cd web
export FEED_URL='https://your-bucket/.../feed.json'
# Optional host port if 8080 is taken:
export WEB_PORT=8091
docker compose up -d --build
```

Open `http://<server-lan-ip>:$WEB_PORT` (default **8080**).

## Env

| Variable | Purpose |
|----------|---------|
| `FEED_URL` | Required. Feed JSON URL |
| `WEB_PORT` | Host port mapped to the container (default `8080`) |
| `PROXY_REWRITE_FROM` / `PROXY_REWRITE_TO` | Rewrite proxy host inside feed video URLs |

The browser never fetches the feed from S3/B2 directly (CORS). The container proxies `/api/feed`. Stream URLs still go straight from the phone to your HLS proxy (`:8787`).

## Local without Docker

```bash
cd web
npm install
FEED_URL='https://…/feed.json' PORT=8091 npm start
```

`PORT` is the Node listen port when not using Docker. With Docker, leave container `PORT=8080` and change **`WEB_PORT`** on the host instead.
