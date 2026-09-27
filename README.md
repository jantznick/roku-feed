# Roku Hockey Feed Generator

This project scrapes `onhockey.tv` for NHL, NHL Rookie Camp, NCAA Men's, and AHL hockey games, generates poster images for each game, and creates a Roku-compatible JSON content feed.

## Apps in this repo

| Path | Role |
|------|------|
| `src/` | Scraper + feed generator → B2 |
| `roku-app/` | Roku channel (default feed + account-synced URL) |
| `backend/` | Auth + per-user feed URL + device pairing API |
| `frontend/` | **Web** settings UI (Vite + React) — login, feed URL, link Roku |
| `react-native-app/` | **Mobile** Expo app (iOS / Android) — player + same account APIs |
| `web/` | Browser HLS feed viewer |
| `proxy/` | HLS proxy |

### Configurable feeds (account sync)

End-to-end guide: **[docs/CONFIGURABLE_FEEDS.md](docs/CONFIGURABLE_FEEDS.md)**  
(Roku `config/channel.json`, backend auth, web/mobile settings, TV pairing.)

Package READMEs: [backend](backend/README.md) · [frontend](frontend/README.md) · [react-native-app](react-native-app/README.md) · [roku-app](roku-app/README.md)


## Features

- Scrapes NHL, NHL Rookie Camp, NCAA Men's, and AHL hockey games.
- Filters for `fluidtv` and `brcove` (Brightcove) streams.
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
