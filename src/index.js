import 'dotenv/config';
import puppeteer from 'puppeteer';
import fs from 'fs/promises';
import path from 'path';
import { scrapeMainPage, deepScrapeGames } from './scraper.js';
import { getPreviousFeed, compareGames } from './state-manager.js';
import { generateImages } from './image-generator.js';
import { createFeedItem, generateFeedShell } from './feed-generator.js';
import { uploadImages, uploadFeed, deleteImages } from './uploader.js';

const FEED_FILE_PATH = path.resolve(process.cwd(), 'dist', 'feed.json');

async function cleanupLocalImages(removedGames) {
    console.log('Cleaning up local image files...');
    for (const game of removedGames) {
        // Use the game's ID for the filename, which is now unique
        const imageName = `${game.id}.png`;
        const imagePath = path.resolve(process.cwd(), 'dist', 'images', imageName);
        try {
            await fs.unlink(imagePath);
            console.log(`  -> Deleted local image: ${imageName}`);
        } catch (error) {
            if (error.code !== 'ENOENT') {
                console.error(`  -> Error deleting local image ${imageName}:`, error);
            }
        }
    }
}

async function main() {
  console.log('--- Roku Feed Scraper ---');
  console.log(`- DEBUG MODE: ${process.env.DEBUG === 'true' ? '✅ Enabled' : '❌ Disabled'}`);
  console.log(`- DRY RUN: ${process.env.DRY_RUN === 'true' ? '✅ Enabled' : '❌ Disabled'}`);
  console.log('-------------------------');

  const browser = await puppeteer.launch({ headless: true });

  try {
    // 1. Get the previous feed, which serves as our cache
    let feed = await getPreviousFeed(generateFeedShell());

    // 2. Scrape onhockey.tv for current games
    const currentGames = await scrapeMainPage(browser);
    
    // 3. Compare the old feed content with the current scrape
    const { newGames, removedGames } = compareGames(feed.content, currentGames);

    // 4. Handle removed games
    await deleteImages(removedGames);
    await cleanupLocalImages(removedGames);
    feed.content = feed.content.filter(item => 
        !removedGames.some(removed => removed.id === item.id)
    );
    console.log(`Removed ${removedGames.length} games from the feed.`);

    // 5. Handle new games
    const newGamesWithStreams = await deepScrapeGames(browser, newGames);
    const localImageMap = await generateImages(browser, newGamesWithStreams);
    const publicUrlMap = await uploadImages(localImageMap);

    // Filter out any games that might already be in the feed, just in case.
    const uniqueNewGames = newGamesWithStreams.filter(newGame => 
        !feed.content.some(existingItem => existingItem.id === newGame.name.replace(/[^a-zA-Z0-9-]/g, ""))
    );

    const newFeedItems = uniqueNewGames.map(game => 
        createFeedItem(game, publicUrlMap.get(game.id))
    );
    feed.content.push(...newFeedItems);
    console.log(`Added ${newFeedItems.length} new games to the feed.`);
    
    // 6. Finalize and save the feed
    feed.lastUpdated = new Date().toISOString();
    const feedJson = JSON.stringify(feed, null, 2);
    // Write locally first for inspection
    await fs.writeFile(FEED_FILE_PATH, feedJson, 'utf8');
    // Then upload
    await uploadFeed(feedJson);

    // No longer need to save a separate games.json
  } catch (error) {
    console.error("Scraping process failed:", error);
  } finally {
    await browser.close();
    console.log('Scraper finished.');
  }
}

main().catch(error => {
  console.error("An error occurred during the scraping process:", error);
  process.exit(1);
});
