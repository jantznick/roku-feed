# Roku Hockey Feed Generator

\* **Work in progress:** A configurable-feeds / multi-publisher direction is underway (`backend/`, `frontend/`, account-linked Roku sync). The sports scraper and clients below remain the supported path today; that existing work will be ported onto the new platform over time. See [Future migration](#future-migration-configurable-feeds).

This project scrapes `onhockey.tv` for NHL, NHL Rookie Camp, NCAA Men's, and AHL hockey games, generates poster images for each game, and creates a Roku-compatible JSON content feed.

## Apps in this repo

| Path | Role |
|------|------|
| `src/` | Scraper + feed generator → B2 |
| `roku-app/` | Roku channel (sports feed; optional account sync \*) |
| `react-native-app/` | Expo mobile client (iOS / Android) |
| `web/` | Browser HLS feed viewer |
| `proxy/` | HLS proxy |
| `backend/` \* | Auth + per-user feed URL + device pairing API |
| `frontend/` \* | Web settings UI (login, feed URL, link Roku) |

\* Configurable-feeds pieces — early / evolving. Details in [Future migration](#future-migration-configurable-feeds).

## Features

- Scrapes NHL, NHL Rookie Camp, NCAA Men's, and AHL hockey games.
- Resolves modern onhockey providers (`streamd`, `plytvme`, `mtchor`, `fluidtv`, `brcove`, `vodcast`, `sportpl`) to HLS.
- Scrapes TimStreams (timst.top) live-TV into `24/7 Channels` (US sports), `Entertainment`, and `Cartoons` (catalog logos used as posters).
- Generates dynamic poster images for each game.
- Creates a Roku-compliant JSON feed.
- Uploads the feed and images to Backblaze B2.
- Compares against the last scan to only process new/removed games.

## Setup

For full local testing (B2, React Native, Roku), see **[docs/LOCAL_SETUP.md](docs/LOCAL_SETUP.md)**.

1.  **Clone the repository.**

2.  **Create an environment file:**
    Copy the `.env.example` file to a new file named `.env` and fill in your Backblaze B2 credentials and a secret name for your feed file.
    ```bash
    cp .env.example .env
    ```

3.  **Install dependencies:**
    Run the following command to install the required Node.js packages:
    ```bash
    npm install puppeteer dotenv @aws-sdk/client-s3 fuse.js node-vibrant
    ```

## Usage

To run the scraper and generate the feed, use the following command:

```bash
npm start
```

### Dry Run Mode

To run the script without uploading or deleting any files on Backblaze B2, set the `DRY_RUN` variable in your `.env` file to `true`. This is useful for testing.

### Debug Mode

To run the script against a local `debug-output.html` file instead of the live website, set the `DEBUG` variable in your `.env` file to `true`.

## Future migration (configurable feeds)

\* **Status: work in progress.** The long-term shape is a config-driven channel shell (theme + feed URL) with web/mobile account settings and Roku pairing, so this repo is not sports-only forever. The scraper, B2 feed, proxy, and current clients keep working as they do today; they will be ported onto that platform gradually (e.g. sports as the first “publisher,” shared auth, baked `roku-app/config/channel.json`).

| Area | Direction |
|------|-----------|
| Roku | Package config (`config/channel.json`), account link, synced feed URL |
| Backend | Magic-link auth, per-user `feedUrl`, device pairing |
| Web | Vite settings app (`frontend/`) — not Expo |
| Mobile | Expo app gains the same account APIs over time |

**Guide:** [docs/CONFIGURABLE_FEEDS.md](docs/CONFIGURABLE_FEEDS.md)

Package notes: [backend](backend/README.md) · [frontend](frontend/README.md) · [roku-app](roku-app/README.md) · [react-native-app](react-native-app/README.md)
