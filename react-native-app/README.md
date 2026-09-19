# We Like Sports (Expo)

React Native / Expo app for **iOS and Android** (app-store path). Streaming player plus account settings that sync feed URLs with the backend and Roku.

The **browser** settings UI stays in `/frontend` (Vite). Do not use Expo for web.

## Features

- Browse the JSON content feed and play HLS streams
- Magic-link / code login (bearer `accessToken` stored in AsyncStorage)
- Account feed URL (`GET`/`PUT /user/settings`)
- Claim a Roku pairing code (`POST /device/pair/claim`)

## Setup

```bash
cd react-native-app
cp .env.example .env
npm install
npm start
```

Set `EXPO_PUBLIC_API_BASE_URL` to your backend (default `http://localhost:3001`). On a physical device, use your LAN IP.

Then press `i` / `a` for simulator, or scan with Expo Go / a dev client.

## Scripts

| Script | Purpose |
|--------|---------|
| `npm start` | Expo dev server (native) |
| `npm run ios` | Open iOS |
| `npm run android` | Open Android |

## Auth note

Native clients use `Authorization: Bearer <accessToken>` from login/verify responses. The Vite web app continues to use cookie sessions (`feed.sid`).

## Related

- Web settings: `/frontend`
- API: `/backend`
- Roku channel: `/roku-app`
