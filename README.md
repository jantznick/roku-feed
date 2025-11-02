# Roku Hockey Feed Generator

This project scrapes `onhockey.tv` for NHL and NCAA Men's hockey games, generates poster images for each game, and creates a Roku-compatible JSON content feed.

## Features

- Scrapes NHL and NCAA Men's hockey games.
- Filters for `vodcast` and `fluidtv` streams.
- Generates dynamic poster images for each game.
- Creates a Roku-compliant JSON feed.
- Uploads the feed and images to Backblaze B2.
- Compares against the last scan to only process new/removed games.

## Setup

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
