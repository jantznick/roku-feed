# Local setup and testing

This guide covers running the scraper, Backblaze B2, the React Native app, and the Roku channel on your machine.

For **account login, custom feed URLs, and Roku ↔ web pairing**, see **[CONFIGURABLE_FEEDS.md](./CONFIGURABLE_FEEDS.md)** instead.

## How the pieces connect

```
Scraper (npm start)  →  Backblaze B2  →  React Native app
                      ↘              ↗  Roku channel
                         feed.json
                         images/*
```

| Component | Location | Role |
|-----------|----------|------|
| **Scraper** | Repo root (`npm start`) | Scrapes onhockey.tv + Streamed.pk, uploads posters and `feed.json` to B2 |
| **Backblaze B2** | Cloud | Public JSON feed + poster images |
| **React Native** | `react-native-app/` | Fetches feed URL, league grid, HLS playback (`expo-video`) |
| **Web viewer** | `web/` | Simple phone/laptop browser UI for feed + HLS (Docker) |
| **Roku** | `roku-app/` | Same feed; grid → details → stream picker → playback |
| **Auth API** | `backend/` | Optional: accounts + synced feed URL (see CONFIGURABLE_FEEDS.md) |
| **Settings web** | `frontend/` | Optional: login + feed URL + link Roku |

Without an account link, clients use a default/hardcoded feed URL (Roku: `config/channel.json`; React Native: Settings / AsyncStorage).

---

## Backblaze B2 setup (new or reset bucket)

1. **Create a bucket** (e.g. `roku-hockey`).

2. **Bucket Settings → Bucket Info**
   - **S3 Endpoint** → `B2_ENDPOINT` (e.g. `s3.us-west-004.backblazeb2.com`)
   - **Region** → `B2_REGION` (e.g. `us-west-004`)

3. **App Keys** → Create a key with **read + write** on that bucket.
   - `B2_ACCESS_KEY_ID`
   - `B2_SECRET_ACCESS_KEY`

4. **Public access** — Apps fetch the feed and thumbnails over HTTPS without auth.
   - Bucket Settings → make the bucket (or objects) **public**
   - Enable **Friendly URL** if you want URLs like the ones already in the apps

5. **Feed object key** — Choose a filename/key, e.g. `feed.json` → set `SECRET_FEED_FILENAME=feed.json` in `.env`.

   **Public URL pattern** (confirm your download host in the B2 UI):

   ```
   https://f004.backblazeb2.com/file/<B2_BUCKET_NAME>/<SECRET_FEED_FILENAME>
   ```

   Example: `https://f004.backblazeb2.com/file/roku-hockey/feed.json`

6. **Optional static assets** (UI only; scraper does not create these):
   - `channel-header.png` — header image in Roku grid (`MainScene.xml`, `GridScreen.xml`)
   - `channel-logos/*` — 24/7 channel posters (see `LOGO_BASE_URL` in `src/streamed-scraper.js`)

The scraper creates the `images/` prefix automatically when it uploads posters.

---

## Scraper environment (repo root)

Copy the template and fill in credentials:

```bash
cd /path/to/roku-feed
cp .env.example .env
```

Edit `.env`:

```env
B2_REGION=us-west-004
B2_ENDPOINT=s3.us-west-004.backblazeb2.com
B2_ACCESS_KEY_ID=your_key_id
B2_SECRET_ACCESS_KEY=your_application_key
B2_BUCKET_NAME=roku-hockey
SECRET_FEED_FILENAME=feed.json
```

| Variable | Purpose |
|----------|---------|
| `B2_*` | S3-compatible API for upload/download |
| `SECRET_FEED_FILENAME` | Object key for feed JSON in the bucket |
| `DRY_RUN=true` | Skip B2 upload/delete; still writes `dist/feed.json` |
| `DEBUG=true` | Use local HTML / sample JSON instead of live sites |

### First run (recommended)

```bash
mkdir -p dist/images dist/league-logos
npm install
DRY_RUN=true npm start    # smoke test, no B2 writes
npm start                 # real upload
```

Verify in a browser:

```
https://f004.backblazeb2.com/file/<bucket>/<SECRET_FEED_FILENAME>
```

On startup the scraper **downloads the previous feed from B2** (when configured) so it does not re-upload unchanged posters.

### Optional local files (warnings only if missing)

| Path | Purpose |
|------|---------|
| `dist/league-logos/*.png` | League badges on generated posters |
| `dist/scraped-logo-data.json` | Fuzzy-match NCAA team logos |

### Sports scope

- **onhockey.tv:** NHL, NHL Rookie Camp, NCAA D1 Men, AHL. Links often appear only near game time; curl/wget get Cloudflare challenges — the scraper uses Puppeteer **stealth** + system Chrome when available, reuses `data/onhockey-cf-cookies.json` (`cf_clearance`), and retries. A failed onhockey scrape no longer aborts Streamed/TimStreams. Providers are `streamd` / `plytvme` / `mtchor` / `fluidtv` / `brcove` / `vodcast` / `sportpl`.
- **Streamed.pk:** hockey, baseball, basketball, american-football, motor-sports
- **24/7 channels:** USA networks (NHL Network, MLB TV, NBA TV, ESPN/NFL, etc.)
- **TimStreams (timst.top):** live-TV split by genre — US sports → `24/7 Channels`, US entertainment → `Entertainment`, all cartoons → `Cartoons`. Uses each channel’s catalog `logo` as the Roku poster (no local banner art required). Signed HLS via grandemx; may need the LAN proxy / home IP when datacenter CDNs 404.

### Streamed.pk (live only)

The scraper uses `GET https://streamed.pk/api/matches/live`, then keeps only your configured sports. If nothing is live in those categories, the feed will be empty — that is expected.

### Favorite teams (feed order)

The scraper sorts certain leagues so preferred teams appear first in the feed (same order clients show in each row):

| League key | Priority team(s) |
|------------|------------------|
| `NCAA D1 Mens` | Western Michigan |
| `BASEBALL` | Chicago Cubs |

Configured in `PRIORITY_TEAMS_BY_LEAGUE` in `src/index.js`. Add more league keys or team name substrings there as needed (match is case-sensitive substring on `title`).

---

## React Native app

### Feed URL

Default (hardcoded): `react-native-app/contexts/FeedContext.tsx` and `app/settings.tsx`.

**Easiest:** run the app → **Settings** → paste your B2 friendly URL → **Save**.

Or change `DEFAULT_FEED_URL` in both files to match your bucket and `SECRET_FEED_FILENAME`.

### Install and run

```bash
cd react-native-app
npm install
npx expo start
```

Press `i` for the iOS Simulator. Video playback uses `expo-video`; a **development build** is more reliable than Expo Go:

```bash
npx expo run:ios
```

---

## Web viewer (phone / VPN testing)

Minimal browser UI under `web/` — browse leagues and play proxied HLS on your phone while on the LAN/VPN.

```bash
cd web
export FEED_URL='https://f004.backblazeb2.com/file/<bucket>/<SECRET_FEED_FILENAME>'
export WEB_PORT=8091   # host port if 8080 is taken
docker compose up -d --build
# open http://<server-lan-ip>:$WEB_PORT
```

See **[web/README.md](../web/README.md)** for env vars (including optional proxy host rewrite).

## Roku channel

1. Update the feed URL in `roku-app/components/tasks/MainLoaderTask.brs` (line with `xfer.SetURL(...)`).
2. Enable [Roku developer mode](https://developer.roku.com/docs/developer-program/getting-started/developer-setup.md) on the device.
3. Package/sideload the `roku-app/` directory (manifest at zip root).

Optional: update `channel-header.png` URL in `MainScene.xml` / `GridScreen.xml` if your bucket name changed.

---

## Test without B2 (apps only)

Serve the local feed after a dry run:

```bash
npx serve dist -p 8080
```

| Client | Feed URL |
|--------|----------|
| iOS Simulator | `http://localhost:8080/feed.json` (RN Settings) |
| Physical phone | `http://<your-mac-lan-ip>:8080/feed.json` |
| Roku on TV | Same LAN URL in `MainLoaderTask.brs` |

---

## Stream playback and proxy

See **[docs/PROXY.md](PROXY.md)** for full detail (when URLs are proxied, the two `proxy/` servers, and troubleshooting).

To generate a feed **without** proxy URLs while your proxy machine is down:

```env
SKIP_PROXY=true
```

in `.env`, then run `npm start`. Streamed.pk streams may still fail playback without a referer-capable client; onhockey / direct URLs may work.

---

## Command checklist

```bash
# Scraper
cd /path/to/roku-feed
cp .env.example .env          # edit with B2 credentials
mkdir -p dist/images dist/league-logos
npm install
DRY_RUN=true npm start
npm start

# Verify feed
# open https://f004.backblazeb2.com/file/<bucket>/<SECRET_FEED_FILENAME>

# React Native
cd react-native-app
npm install
npx expo start                # or: npx expo run:ios

# Roku — edit MainLoaderTask.brs, then sideload roku-app/
```

---

## When B2 names change

| You change | Also update |
|------------|-------------|
| Bucket or feed filename | RN Settings / `DEFAULT_FEED_URL`; `MainLoaderTask.brs` |
| Bucket for 24/7 logos | `LOGO_BASE_URL` in `src/streamed-scraper.js` |
| Channel header image | B2 URL in `MainScene.xml`, `GridScreen.xml` |
| Priority teams | `PRIORITY_TEAMS_BY_LEAGUE` in `src/index.js` |

---

## Related files

| File | Purpose |
|------|---------|
| `.env.example` | Scraper environment template |
| `src/index.js` | Main pipeline + priority team sorting |
| `src/uploader.js` | B2 upload/download |
| `docs/LOCAL_SETUP.md` | This document |
