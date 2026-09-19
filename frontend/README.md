# Feed Settings Frontend (Web)

Vite + React 19 + Tailwind CSS v4 **browser** app for magic-link login, feed URL settings, and linking a Roku.

Mobile / app-store clients live in `/react-native-app` (Expo). This package is web-only.

## Setup

```bash
cd frontend
cp .env.example .env
npm install
npm run dev
```

Dev server defaults to Vite’s port (usually `http://localhost:5173`). Point `VITE_API_BASE_URL` at the backend (default `http://localhost:3001`).

## Environment

| Variable | Default | Description |
| --- | --- | --- |
| `VITE_API_BASE_URL` | `http://localhost:3001` | Backend origin for API calls |

Session cookies (`feed.sid`) are sent with `credentials: "include"`. The backend must allow CORS with credentials from the Vite origin.

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
