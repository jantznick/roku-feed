import fs from 'fs/promises';
import path from 'path';

const FEED_FILE_PATH = path.resolve(process.cwd(), 'dist', 'feed.json');

/**
 * Reads the entire feed from the previous run.
 * @param {object} defaultShell - The default feed structure to use if no file is found.
 * @returns {Promise<object>} The feed object from the last run.
 */
export async function getPreviousFeed(defaultShell) {
    try {
        const data = await fs.readFile(FEED_FILE_PATH, 'utf8');
        console.log('Successfully loaded previous feed.');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log('No previous feed file found. Starting with a new shell.');
            return defaultShell;
        }
        console.error('Error reading previous feed:', error);
        return defaultShell;
    }
}

/**
 * Compares the previous feed content and current games to find differences.
 * @param {any[]} previousContent The content array from the last feed.
 * @param {any[]} currentGames The list of games from the current run.
 * @returns {{newGames: any[], removedGames: any[]}}
 */
export function compareGames(previousContent, currentGames) {
    const prevGameIds = new Set(previousContent.map(item => item.id));
    const currentGameIds = new Set(currentGames.map(game => game.id));

    const newGames = currentGames.filter(game => !prevGameIds.has(game.id));
    
    const removedGames = previousContent.filter(item => !currentGameIds.has(item.id));

    // Find games that exist in both the old and new lists. These are candidates for an update.
    const updatedGames = currentGames.filter(game => prevGameIds.has(game.id));

    console.log(`Game comparison: ${newGames.length} new, ${removedGames.length} removed, ${updatedGames.length} to update.`);

    return { newGames, removedGames, updatedGames };
}
