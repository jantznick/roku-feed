# Roku Feed API

Small Express + Prisma + Postgres backend for magic-link auth and per-user custom feed URLs. Patterned after [twin-rinks](https://github.com/jantznick/twin-rinks).

## Stack

- Node / Express 5
- PostgreSQL + Prisma ORM
- Cookie sessions (`feed.sid`) via `express-session` + `connect-pg-simple`
- Resend for magic-link / code emails (console fallback in development)

## Quick start (Docker)

From this directory:

```bash
cp .env.example .env
# edit SESSION_SECRET (and RESEND_* if you want real email)
docker compose up --build
```

API: `http://localhost:3001`  
Health: `GET /health`

Migrations run automatically on container start.

## Local (without Docker API)

```bash
cp .env.example .env
# set DATABASE_URL to your Postgres
npm install
npx prisma migrate deploy
npm run dev
```

Do not start Compose on the shared laptop if that is reserved for other work; run DB/API on your home server or a dedicated machine.

## Auth API

| Method | Path | Notes |
|--------|------|--------|
| POST | `/auth/magic-link/request` | `{ email, intent? }` — creates user if needed; emails link + 6-digit code |
| GET | `/auth/magic-link/verify?token=` | Sets session + marks email verified |
| POST | `/auth/magic-code/verify` | `{ email, code }` |
| POST | `/auth/register` | `{ email, password }` (optional password path) |
| POST | `/auth/login` | `{ email, password }` |
| POST | `/auth/logout` | Clears `feed.sid` |
| GET | `/auth/me` | Current user |
| POST | `/auth/forgot-password` | `{ email }` |
| POST | `/auth/reset-password` | `{ token, password }` |
| GET | `/auth/verify-email?token=` | Email verification link |
| POST | `/auth/verify-email/resend` | Auth required |

Magic-link emails point at `{APP_URL}/auth/verify?token=...` (Vite frontend route).

Successful auth responses also include `accessToken` (30-day bearer) for Expo / native clients. Cookie sessions remain the primary auth for the web app.

## Device pairing (Roku ↔ web account)

| Method | Path | Who | Notes |
|--------|------|--------|--------|
| POST | `/device/pair/start` | Roku | `{ deviceId? }` → `{ deviceId, code, expiresAt, pollAfterMs }` |
| GET | `/device/pair/status?deviceId=` | Roku | `pending` / `linked` / `expired`; `accessToken` returned **once** when linked |
| POST | `/device/pair/claim` | Web (session) | `{ code }` links TV to signed-in user |
| GET | `/device/settings` | Roku | `Authorization: Bearer <accessToken>` → account feed URL |
| DELETE | `/device/link` | Roku | Unlink device |

Flow: TV shows code → user signs in on web and enters code → TV polls status, stores bearer token → on each launch TV calls `/device/settings` and uses `effectiveFeedUrl`.

## Settings API

| Method | Path | Notes |
|--------|------|--------|
| GET | `/user/settings` | `{ feedUrl, effectiveFeedUrl, defaultFeedUrl }` |
| PUT | `/user/settings` | `{ feedUrl }` — empty string clears custom URL |

Session cookie + CORS credentials required. `FRONTEND_URL` may be a comma-separated allowlist.

## User shape (`/auth/me`)

```json
{
  "ok": true,
  "user": {
    "id": "...",
    "email": "you@example.com",
    "emailVerified": true,
    "feedUrl": null,
    "effectiveFeedUrl": "https://…/secretfeedfilename.json",
    "defaultFeedUrl": "https://…/secretfeedfilename.json"
  }
}
```

## Frontend

- Web UI: `/frontend` (Vite)
- Mobile: `/react-native-app` (Expo)
- End-to-end guide: [docs/CONFIGURABLE_FEEDS.md](../docs/CONFIGURABLE_FEEDS.md)
