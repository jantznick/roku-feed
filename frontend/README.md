# Feed Settings Frontend

Vite + React 19 + Tailwind CSS v4 app for magic-link login and configuring a custom Roku feed URL.

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
| `/` | Settings (auth required): view/edit feed URL, reset, logout |

## API integration

Auth (mirrors twin-rinks):

- `POST /auth/magic-link/request` — `{ email, intent? }`
- `GET /auth/magic-link/verify?token=…`
- `POST /auth/magic-code/verify` — `{ email, code }`
- `POST /auth/logout`
- `GET /auth/me` — `{ ok, user: { id, email, emailVerified, feedUrl } }`
- Optional: `POST /auth/register`, `POST /auth/login`

Settings:

- `GET /user/settings` — `{ ok, settings: { feedUrl, defaultFeedUrl } }`
- `PUT /user/settings` — `{ feedUrl }` (empty string clears to default)
