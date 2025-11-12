import 'dotenv/config';
import puppeteer from 'puppeteer';
import fs from 'fs/promises';
import path from 'path';
import { scrapeMainPage, deepScrapeGames } from './scraper.js';
import { scrapeStreamedGames, scrape247Channels } from './streamed-scraper.js';
import { getPreviousFeed, compareGames } from './state-manager.js';
import { generateImages } from './image-generator.js';
import { downloadPosters } from './poster-downloader.js';
import { createFeedItem, generateFeedShell } from './feed-generator.js';
import { uploadImages, uploadFeed, deleteImages } from './uploader.js';
import { logLeagues } from './league-logger.js';

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
  const startTime = new Date();
  console.log('*************************************');
  console.log(`\nScript Run Start: ${startTime.toLocaleString()}\n`);
  console.log('*************************************\n');

  let newGames = [], removedGames = [], updatedGames = [];

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

    const sportsCategories = ['golf', 'basketball', 'american-football', 'baseball', 'hockey', 'football', 'darts', 'motor-sports', 'tennis', 'rugby', 'billiards', 'afl', 'other'];
    const streamedGames = await scrapeStreamedGames(browser, sportsCategories);
    const channels247 = await scrape247Channels(browser);


    // Combine the games from all sources
    const allCurrentGames = [...onHockeyGames, ...streamedGames, ...channels247];
    console.log(`\nFound ${onHockeyGames.length} games from onhockey.tv and ${streamedGames.length} games from Streamed.pk.`);
    console.log(`Found ${channels247.length} 24/7 channels.`);
    console.log(`Total unique items to process: ${allCurrentGames.length}`);

    // Log any new soccer leagues discovered
    await logLeagues(allCurrentGames);
    
    // 3. Compare the old feed content with the current scrape
    // We need to get ALL previous content for comparison.
    const previousLeagues = Object.keys(feed).filter(k => Array.isArray(feed[k]));
    const previousContent = previousLeagues.flatMap(league => feed[league]);
    const comparisonResult = compareGames(previousContent, allCurrentGames);
    newGames = comparisonResult.newGames;
    removedGames = comparisonResult.removedGames;
    updatedGames = comparisonResult.updatedGames;

    // 4. Handle removed games
    await deleteImages(removedGames);
    await cleanupLocalImages(removedGames);
    // Filter all league arrays to remove old games
    previousLeagues.forEach(league => {
        feed[league] = feed[league].filter(item => !removedGames.some(removed => removed.id === item.id));
    });
    console.log(`Removed ${removedGames.length} games from the feed.`);

    // --- Game Processing Logic ---

    // First, remove the old versions of the updated games from our feed object.
    // This allows us to add the fresh versions back in with new stream links.
    const updatedGameIds = new Set(updatedGames.map(g => g.id));
    previousLeagues.forEach(league => {
        feed[league] = feed[league].filter(item => !updatedGameIds.has(item.id));
    });
    if (updatedGames.length > 0) {
        console.log(`Cleared ${updatedGames.length} existing games from the feed to prepare for update.`);
    }

    // We will process both new and updated games to get their streams and add them to the feed.
    const gamesToProcess = [...newGames, ...updatedGames];

    // The 'deepScrapeGames' is specific to onhockey.tv, so we separate the games by source.
    const onHockeyToProcess = gamesToProcess.filter(game => onHockeyGames.some(g => g.id === game.id));
    const streamedToProcess = gamesToProcess.filter(game => streamedGames.some(g => g.id === game.id));
    const channelsToProcess = gamesToProcess.filter(game => channels247.some(g => g.id === game.id));
    
    const onHockeyWithStreams = await deepScrapeGames(browser, onHockeyToProcess);

    // The streamed games and channels already have their streams, so we just combine everything.
    const allGamesToAddOrUpdate = [...onHockeyWithStreams, ...streamedToProcess, ...channelsToProcess];

    // --- IMAGE HANDLING ---
    
    // 1. Separate 24/7 channels, as their posters are static and don't need processing.
    const channelsForFeed = allGamesToAddOrUpdate.filter(game => game.league === '24/7 Channels');
    const gamesForImageProcessing = allGamesToAddOrUpdate.filter(game => game.league !== '24/7 Channels');

    // 2. Run the image pipeline ONLY on the regular games.
    const gamesToGenerate = gamesForImageProcessing.filter(game => !game.poster);
    const gamesWithPoster = gamesForImageProcessing.filter(game => game.poster);

    const [generatedImageMap, downloadedPosterMap] = await Promise.all([
        generateImages(browser, gamesToGenerate),
        downloadPosters(gamesWithPoster)
    ]);
    
    const localImageMap = new Map([...generatedImageMap, ...downloadedPosterMap]);
    // This map now only contains URLs for regular games.
    const publicUrlMap = await uploadImages(localImageMap);

    // 3. Add all new and updated items to the feed, using the correct poster URL for each type.
    allGamesToAddOrUpdate.forEach(game => {
        let posterUrl;
        if (game.league === '24/7 Channels') {
            // For channels, the poster URL is the final, hardcoded public URL.
            posterUrl = game.poster;
        } else {
            // For games, we get the URL from the map of freshly uploaded images.
            posterUrl = publicUrlMap.get(game.id);
        }

        const feedItem = createFeedItem(game, posterUrl);
        const league = game.league === 'NCAA' ? 'NCAA D1 Mens' : game.league;

        if (!feed[league]) {
            feed[league] = [];
        }
        feed[league].push(feedItem);
    });
    console.log(`Added or updated ${allGamesToAddOrUpdate.length} games/channels in the feed.`);

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

    // Re-order the feed object to place soccer leagues last
    const finalFeed = {
        providerName: feed.providerName,
        lastUpdated: feed.lastUpdated,
        language: feed.language,
    };

    const allLeagueKeys = Object.keys(feed).filter(key => Array.isArray(feed[key]));
    const knownNonSoccerLeagues = new Set(['NHL', 'NCAA D1 Mens', 'BASKETBALL', 'AMERICAN-FOOTBALL', 'BASEBALL', 'GOLF', 'HOCKEY', '24/7 Channels']);
    
    const nonSoccerLeagues = allLeagueKeys.filter(key => knownNonSoccerLeagues.has(key)).sort();
    const soccerLeagues = allLeagueKeys.filter(key => !knownNonSoccerLeagues.has(key));
    
    const genericFootball = soccerLeagues.find(key => key === 'FOOTBALL');
    const specificSoccerLeagues = soccerLeagues.filter(key => key !== 'FOOTBALL').sort();

    // Add non-soccer leagues first
    nonSoccerLeagues.forEach(league => {
        if (feed[league] && feed[league].length > 0) finalFeed[league] = feed[league];
    });

    // Add the generic FOOTBALL league next
    if (genericFootball && feed[genericFootball] && feed[genericFootball].length > 0) {
        finalFeed[genericFootball] = feed[genericFootball];
    }

    // Add specific soccer leagues last
    specificSoccerLeagues.forEach(league => {
        if (feed[league] && feed[league].length > 0) finalFeed[league] = feed[league];
    });

    // Add the script duration to the feed before writing
    const dataGenerationEndTime = new Date();
    const dataGenerationDuration = (dataGenerationEndTime - startTime) / 1000;
    finalFeed.scriptDuration = `${dataGenerationDuration.toFixed(2)} seconds`;

    const feedJson = JSON.stringify(finalFeed, null, 2);

    // Write locally first for inspection
    await fs.writeFile(FEED_FILE_PATH, feedJson, 'utf8');
    // Then upload
    await uploadFeed(feedJson);

    // No longer need to save a separate games.json
  } catch (error) {
    console.error("Scraping process failed:", error);
  } finally {
    await browser.close();
    
    const endTime = new Date();
    const duration = (endTime - startTime) / 1000; // in seconds

    console.log('\n*************************************');
    console.log(`\nScript Run End: ${endTime.toLocaleString()}`);
    console.log(`Duration: ${duration.toFixed(2)} seconds\n`);
    console.log('--- Summary ---');
    console.log(`- Added: ${newGames.length} items`);
    console.log(`- Updated: ${updatedGames.length} items`);
    console.log(`- Removed: ${removedGames.length} items`);
    console.log('---------------');
    console.log('\n*************************************');

    console.log('Scraper finished.');
  }
}

main().catch(error => {
  console.error("An error occurred during the scraping process:", error);
  process.exit(1);
});
