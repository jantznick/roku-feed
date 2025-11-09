import 'dotenv/config';
import puppeteer from 'puppeteer';
import fs from 'fs/promises';
import path from 'path';
import { scrapeMainPage, deepScrapeGames } from './scraper.js';
import { scrapeStreamedGames } from './streamed-scraper.js';
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
    
    // Ensure the old 'content' array is removed if it exists from a previous run
    if (feed.content) {
        delete feed.content;
    }

    // 2. Scrape for games
    const onHockeyGames = await scrapeMainPage(browser);

    const sportsCategories = ['golf', 'basketball', 'american-football', 'baseball', 'hockey'];
    const streamedGames = await scrapeStreamedGames(browser, sportsCategories);

    // Combine the games from all sources
    const allCurrentGames = [...onHockeyGames, ...streamedGames];
    console.log(`\nFound ${onHockeyGames.length} games from onhockey.tv and ${streamedGames.length} games from Streamed.pk.`);
    console.log(`Total unique games to process: ${allCurrentGames.length}`);
    
    // 3. Compare the old feed content with the current scrape
    // We need to get ALL previous content for comparison.
    const previousLeagues = Object.keys(feed).filter(k => Array.isArray(feed[k]));
    const previousContent = previousLeagues.flatMap(league => feed[league]);
    const { newGames, removedGames } = compareGames(previousContent, allCurrentGames);

    // 4. Handle removed games
    await deleteImages(removedGames);
    await cleanupLocalImages(removedGames);
    // Filter all league arrays to remove old games
    previousLeagues.forEach(league => {
        feed[league] = feed[league].filter(item => !removedGames.some(removed => removed.id === item.id));
    });
    console.log(`Removed ${removedGames.length} games from the feed.`);

    // 5. Handle new games
    // The 'deepScrapeGames' is specific to onhockey.tv, so we only pass its new games.
    const newOnHockeyGames = newGames.filter(game => onHockeyGames.some(g => g.id === game.id));
    const newStreamedGames = newGames.filter(game => streamedGames.some(g => g.id === game.id));
    
    const newOnHockeyGamesWithStreams = await deepScrapeGames(browser, newOnHockeyGames);

    // The new streamed games already have their streams, so we just combine them.
    const allNewGamesWithStreams = [...newOnHockeyGamesWithStreams, ...newStreamedGames];

    const localImageMap = await generateImages(browser, allNewGamesWithStreams);
    const publicUrlMap = await uploadImages(localImageMap);

    // Add the new items to the correct league array.
    allNewGamesWithStreams.forEach(game => {
        // --- START EXHAUSTIVE LOGGING ---
        // console.log('--- PROCESSING GAME OBJECT ---');
        // console.log(JSON.stringify(game, null, 2));
        // console.log(`- Game Name: ${game.name}`);
        // console.log(`- Release Date Value: ${game.releaseDate}`);
        // console.log(`- Type of Release Date: ${typeof game.releaseDate}`);
        // console.log('----------------------------');
        // --- END EXHAUSTIVE LOGGING ---

        const feedItem = createFeedItem(game, publicUrlMap.get(game.id));
        const league = game.league === 'NCAA' ? 'NCAA D1 Mens' : game.league;

        if (!feed[league]) {
            feed[league] = [];
        }
        feed[league].push(feedItem);
    });
    console.log(`Added ${allNewGamesWithStreams.length} new games to the feed.`);

    // Sort NCAA games to put "Western Michigan" at the front
    if (feed["NCAA D1 Mens"]) {
        feed["NCAA D1 Mens"].sort((a, b) => {
            const aIsWM = a.title.includes('Western Michigan');
            const bIsWM = b.title.includes('Western Michigan');
            if (aIsWM && !bIsWM) return -1;
            if (!aIsWM && bIsWM) return 1;
            return 0; // Keep original order for other games
        });
    }
    
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
