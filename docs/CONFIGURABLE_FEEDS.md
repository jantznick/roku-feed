# Configurable feeds

Account-backed feed URLs so a Roku (and later other clients) can sync the catalog the user picks on the web or in the mobile app.

## Architecture

```
┌─────────────────┐     cookie session      ┌──────────────────┐
│  frontend/      │ ───────────────────────►│                  │
│  (Vite web)     │     set feedUrl         │                  │
└─────────────────┘     claim pair code     │    backend/      │
                                            │  Express+Prisma  │
┌─────────────────┐     Bearer token        │  + Postgres      │
│ react-native-   │ ───────────────────────►│                  │
│ app/ (Expo)     │     same settings API   └────────┬─────────┘
└─────────────────┘                                  │
                                                     │ device bearer
┌─────────────────┐     pair + sync                  │
│  roku-app/      │ ◄────────────────────────────────┘
│  channel.json   │     GET /device/settings
│  apiBaseUrl     │     → effectiveFeedUrl → content feed JSON
└─────────────────┘
```

| Piece | Path | Role |
|-------|------|------|
| API | `backend/` | Auth, per-user `feedUrl`, Roku device pairing |
| Web UI | `frontend/` | Magic-link login, feed URL, “Link a Roku” |
| Mobile | `react-native-app/` | Expo iOS/Android player + same account APIs |
| Roku | `roku-app/` | Plays feed; links account; syncs URL from API |
| Feed file | B2 / scraper | Public JSON catalog (unchanged format) |

Web uses **cookie sessions** (`feed.sid`). Expo and Roku use **bearer tokens**.

---

## Quick start (home server / Docker)

Run API + Postgres + settings UI together from `backend/`:

```bash
cd backend
cp .env.example .env
# For LAN access, set PUBLIC_API_BASE_URL / PUBLIC_FRONTEND_URL to http://<server-ip>:3001 and :5173
# Also set FRONTEND_URL and APP_URL to that same frontend URL (see .env.example).
# Set SESSION_SECRET. Optionally RESEND_* for real email (otherwise codes print in API logs).
docker compose up --build -d
docker compose logs -f api
```

| Service | URL |
|---------|-----|
| API health | `http://<host>:3001/health` |
| Settings UI | `http://<host>:5173` |

Migrations apply on API container start.

**Frontend on a laptop instead?** You can still `cd frontend && npm run dev` and point `VITE_API_BASE_URL` at the server API. That works for solo testing. For phones/other PCs on the LAN (and magic links / Roku pairing), serve the UI from Compose on the home server.

See [backend/README.md](../backend/README.md) and [frontend/README.md](../frontend/README.md).

### Roku channel config

Edit **`roku-app/config/channel.json`** before packaging/sideloading:

```json
{
  "apiBaseUrl": "https://your-api.example.com",
  "defaultFeedUrl": "https://f004.backblazeb2.com/file/roku-hockey/secretfeedfilename.json"
}
```

| Field | Purpose |
|-------|---------|
| `apiBaseUrl` | Backend origin the TV calls for pairing/sync (**not** editable on device) |
| `defaultFeedUrl` | Feed used when the TV is not linked / has no synced URL |

Package/sideload `roku-app/` as usual. Details: [roku-app/README.md](../roku-app/README.md).

### Link TV ↔ account

1. On Roku: **Options (`*`)** on the grid → **Link Web Account** → note the 6-digit code.
2. On web (or Expo settings): sign in → **Link a Roku** → enter the code.
3. TV stores a device token. Every feed load calls `GET /device/settings` and uses `effectiveFeedUrl`.

Change the feed URL on the web → TV picks it up on next launch/reload (or **Sync Feed Now**).

### 5. Expo mobile (optional)

```bash
cd react-native-app
cp .env.example .env   # EXPO_PUBLIC_API_BASE_URL=http://<lan-ip>:3001
npm install
npm start
```

Web stays in `frontend/`; Expo is **iOS/Android only**. See [react-native-app/README.md](../react-native-app/README.md).

---

## Environment variables

### Backend (`backend/.env`)

| Variable | Required | Notes |
|----------|----------|--------|
| `DATABASE_URL` | Yes (Compose sets this) | Postgres |
| `SESSION_SECRET` | Yes | Cookie signing |
| `FRONTEND_URL` | Yes | CORS allowlist (comma-separated), e.g. `http://localhost:5173` |
| `APP_URL` | Yes | Base for magic-link emails → `{APP_URL}/auth/verify?token=…` |
| `DEFAULT_FEED_URL` | No | Fallback when user has no custom URL |
| `RESEND_API_KEY` / `RESEND_FROM_EMAIL` | No | Real email; without them, codes/links log to the console |
| `PORT` | No | Default `3001` |
| `NODE_ENV` | No | `production` enables secure cookies |

### Web (`frontend/.env`)

| Variable | Default | Notes |
|----------|---------|--------|
| `VITE_API_BASE_URL` | `http://localhost:3001` | Backend origin |

### Expo (`react-native-app/.env`)

| Variable | Default | Notes |
|----------|---------|--------|
| `EXPO_PUBLIC_API_BASE_URL` | `http://localhost:3001` | Use LAN IP on a physical phone |

### Roku

No `.env`. Use **`roku-app/config/channel.json`** only.

---

## Auth model

| Client | How it authenticates |
|--------|----------------------|
| Vite web | Cookie `feed.sid` + CSRF origin check (`FRONTEND_URL`) |
| Expo | `Authorization: Bearer <accessToken>` from login/verify (stored in AsyncStorage) |
| Roku | Device bearer from pairing (`GET /device/settings`) |

Magic link + 6-digit code are the primary login path. Password register/login exist on the API for completeness.

---

## Feed URL priority (Roku)

1. **Synced account URL** — if linked, last `effectiveFeedUrl` from the API (refreshed on each content load)
2. **Local registry override** — optional sideload testing (`*` → Set Local Feed URL Override)
3. **`defaultFeedUrl`** from `channel.json`

Web/Expo account settings write `User.feedUrl` in Postgres. Empty string clears to `DEFAULT_FEED_URL`.

---

## API surface (summary)

**Auth** — `/auth/*` (magic link/code, me, logout, optional password)

**User settings** — `GET` / `PUT /user/settings` `{ feedUrl }`

**Device pairing**

| Method | Path | Actor |
|--------|------|--------|
| `POST` | `/device/pair/start` | Roku |
| `GET` | `/device/pair/status?deviceId=` | Roku (receives `accessToken` once when linked) |
| `POST` | `/device/pair/claim` | Web/Expo (signed in) `{ code }` |
| `GET` | `/device/settings` | Roku (device bearer) |
| `DELETE` | `/device/link` | Roku unlink |

Full tables: [backend/README.md](../backend/README.md).

---

## Content feed format

Unchanged: public JSON where top-level array keys become grid rows. Default producer is the scraper → B2. See existing scraper docs and [LOCAL_SETUP.md](./LOCAL_SETUP.md) for B2 URLs.

Account `feedUrl` / Roku `defaultFeedUrl` should point at a feed shaped the same way.

---

## What’s intentionally out of scope (for later)

- Theme/branding config beyond `channel.json` API/feed URLs
- Pushing account feed URL into Expo’s player automatically beyond settings save
- Production hosting / DNS for `apiBaseUrl`
- App Store / Play Store submission polish

---

## Related docs

| Doc | Topic |
|-----|--------|
| [backend/README.md](../backend/README.md) | API + Docker |
| [frontend/README.md](../frontend/README.md) | Web UI |
| [react-native-app/README.md](../react-native-app/README.md) | Expo mobile |
| [roku-app/README.md](../roku-app/README.md) | Channel + `channel.json` |
| [LOCAL_SETUP.md](./LOCAL_SETUP.md) | Scraper, B2, classic local feed testing |
| [PROXY.md](./PROXY.md) | HLS proxy |
