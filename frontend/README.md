# Feed Settings Frontend (Web)

Vite + React 19 + Tailwind CSS v4 **browser** app for magic-link login, feed URL settings, and linking a Roku.

Mobile / app-store clients live in `/react-native-app` (Expo). This package is web-only.

## Where should it run?

| Setup | Recommendation |
|-------|----------------|
| **Home server (LAN / Roku pairing)** | Serve from Docker on the server via `backend/docker-compose.yml` (API + UI together). |
| **Solo laptop testing** | `npm run dev` on the laptop is fine; point `VITE_API_BASE_URL` at the API (local or server). |

Magic links and cookie CORS use the URL you open in the browser (`APP_URL` / `FRONTEND_URL` on the API). Phones and other PCs need a host they can reach — usually the home server, not `localhost` on your laptop.

## Docker (recommended on the home server)

The frontend is built into the compose stack under `backend/`:

```bash
cd backend
cp .env.example .env
# PUBLIC_API_BASE_URL=http://192.168.x.x:3001
# FRONTEND_URL / APP_URL / PUBLIC_FRONTEND_URL=http://192.168.x.x:5173
docker compose up --build -d
```

Then open `http://<server>:5173`. See [docs/CONFIGURABLE_FEEDS.md](../docs/CONFIGURABLE_FEEDS.md).

## Local Vite (dev)

```bash
cd frontend
cp .env.example .env
npm install
npm run dev -- --host 0.0.0.0
```

| Variable | Default | Description |
| --- | --- | --- |
| `VITE_API_BASE_URL` | `http://localhost:3001` | Backend origin for API calls |

Session cookies (`feed.sid`) are sent with `credentials: "include"`. The backend must allow CORS with credentials from this app’s origin.

## Scripts

- `npm run dev` — local development
- `npm run build` — production build to `dist/`
- `npm run preview` — preview the production build

## Routes

| Path | Description |
| --- | --- |
| `/login` | Request magic link / enter 6-digit code |
| `/auth/verify?token=…` | Complete sign-in from email link |
| `/` | Settings (auth required): feed URL + link a Roku with pairing code |

## API integration

Auth (mirrors twin-rinks):

- `POST /auth/magic-link/request` — `{ email, intent? }`
- `GET /auth/magic-link/verify?token=…`
- `POST /auth/magic-code/verify` — `{ email, code }`
- `POST /auth/logout`
- `GET /auth/me` — `{ ok, user: { id, email, emailVerified, feedUrl } }`
- Optional: `POST /auth/register`, `POST /auth/login`

Settings:

- `GET /user/settings` — `{ ok, settings: { feedUrl, effectiveFeedUrl, defaultFeedUrl } }`
- `PUT /user/settings` — `{ feedUrl }` (empty string clears to default)

Device linking:

- `POST /device/pair/claim` — `{ code }` (session auth) links the TV showing that code

End-to-end guide: [docs/CONFIGURABLE_FEEDS.md](../docs/CONFIGURABLE_FEEDS.md).
