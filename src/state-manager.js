import fs from 'fs/promises';
import path from 'path';
import { downloadFeed } from './uploader.js';
import { getStreamSignature } from './feed-generator.js';

const FEED_FILE_PATH = path.resolve(process.cwd(), 'dist', 'feed.json');

/**
 * Loads the previous feed from B2 when possible, then local dist/feed.json.
 * @param {object} defaultShell - The default feed structure to use if no file is found.
 * @returns {Promise<object>} The feed object from the last run.
 */
export async function getPreviousFeed(defaultShell) {
    await fs.mkdir(path.dirname(FEED_FILE_PATH), { recursive: true });

    const remoteFeedJson = await downloadFeed();
    if (remoteFeedJson) {
        await fs.writeFile(FEED_FILE_PATH, remoteFeedJson, 'utf8');
        console.log('Loaded previous feed from B2 (saved to dist/feed.json).');
        return JSON.parse(remoteFeedJson);
    }

    try {
        const data = await fs.readFile(FEED_FILE_PATH, 'utf8');
        console.log('Loaded previous feed from local dist/feed.json.');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log('No previous feed found. Starting with a new shell.');
            return defaultShell;
        }
        console.error('Error reading previous feed:', error);
        return defaultShell;
    }
}

function gameNeedsUpdate(currentGame, previousItem) {
    if (previousItem.title !== currentGame.name) {
        return true;
    }

    const currentSignature = getStreamSignature(currentGame);
    const previousSignature = previousItem.streamSignature || '';

    return currentSignature !== previousSignature;
}

/**
 * Compares the previous feed content and current games to find differences.
 * Unchanged games are left in the feed as-is (no re-scrape, no image re-upload).
 * @param {any[]} previousContent Feed items from the last run.
 * @param {any[]} currentGames Games from the current scrape.
 * @returns {{newGames: any[], removedGames: any[], updatedGames: any[], unchangedCount: number}}
 */
export function compareGames(previousContent, currentGames) {
    const previousById = new Map(previousContent.map((item) => [item.id, item]));
    const currentGameIds = new Set(currentGames.map((game) => game.id));

    const newGames = currentGames.filter((game) => !previousById.has(game.id));
    const removedGames = previousContent.filter((item) => !currentGameIds.has(item.id));

    const updatedGames = [];
    let unchangedCount = 0;

    for (const game of currentGames) {
        const previousItem = previousById.get(game.id);
        if (!previousItem) {
            continue;
        }
        if (gameNeedsUpdate(game, previousItem)) {
            updatedGames.push(game);
        } else {
            unchangedCount++;
        }
    }

    console.log(
        `Game comparison: ${newGames.length} new, ${removedGames.length} removed, ` +
        `${updatedGames.length} to update, ${unchangedCount} unchanged.`
    );

    return { newGames, removedGames, updatedGames, unchangedCount };
}
