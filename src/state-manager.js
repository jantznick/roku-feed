import fs from 'fs/promises';
import path from 'path';
import { downloadFeed } from './uploader.js';
import { getStreamSignature } from './feed-generator.js';
import {
    getEmbedSignature,
    extractStreamLinksFromFeedItem,
    isStreamCacheFresh,
} from './stream-reuse.js';

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

/**
 * Index all league-array feed items by id.
 * Skips non-array feed keys (providerName, lastUpdated, language, …).
 * @param {object} feed
 * @returns {Map<string, object>}
 */
export function indexFeedItemsById(feed) {
    const byId = new Map();
    if (!feed || typeof feed !== 'object') {
        return byId;
    }

    for (const value of Object.values(feed)) {
        if (!Array.isArray(value)) {
            continue;
        }
        for (const item of value) {
            if (item?.id != null) {
                byId.set(item.id, item);
            }
        }
    }

    return byId;
}

/**
 * Decide whether a current game needs a new feed item vs the previous one.
 *
 * Change detection notes:
 * - Prefer embedSignature + TTL freshness when either side has embed identity
 *   (Streamed). Rotating m3u8 URLs alone no longer force an "update".
 * - onhockey often has no embedUrl on streamLinks: if both embedSignatures are
 *   empty, fall back to streamSignature (raw URLs) as before.
 * - When the Streamed integrator skips resolve and reuses previous streamLinks
 *   (same URLs), streamSignature will also match — that is expected for the
 *   reuse path. Without reuse, freshly resolved Streamed URLs rotate and would
 *   always look "updated" under streamSignature alone.
 *
 * @param {object} currentGame
 * @param {object} previousItem
 * @returns {boolean}
 */
function feedVideosUseProxy(previousItem) {
    const videos = previousItem?.content?.videos;
    if (!Array.isArray(videos)) {
        return false;
    }
    return videos.some((video) => typeof video?.url === 'string' && video.url.includes('/proxy/'));
}

function gameNeedsUpdate(currentGame, previousItem) {
    if (previousItem.title !== currentGame.name) {
        return true;
    }

    // Unchanged items keep prior feed JSON as-is. If createFeedItem would write
    // a /proxy/ URL (Referer present) but the feed still has a raw CDN URL —
    // e.g. after the brief TimStreams-raw experiment — force a rewrite.
    const wouldProxy = (currentGame.streamLinks || []).some((s) => s.headers?.Referer);
    if (wouldProxy && !feedVideosUseProxy(previousItem)) {
        return true;
    }

    const currentEmbedSig =
        currentGame.embedSignature ||
        getEmbedSignature(currentGame.streamLinks || []) ||
        '';
    const previousEmbedSig =
        previousItem.embedSignature ||
        getEmbedSignature(extractStreamLinksFromFeedItem(previousItem)) ||
        '';

    // onhockey / no-embed path: empty embed identity on both → raw URL signature.
    if (!currentEmbedSig && !previousEmbedSig) {
        const currentSignature = getStreamSignature(currentGame);
        const previousSignature = previousItem.streamSignature || '';
        return currentSignature !== previousSignature;
    }

    // Same embed identity and still-fresh confirmedAt → unchanged (ignore m3u8 rotation).
    // Exact signature match is enough here: scrapeStreamedGames reuses or re-resolves
    // before compareGames, so "fresh + same embeds" games arrive with reused links
    // (same signature) or are marked for update when TTL expired.
    if (
        currentEmbedSig &&
        previousEmbedSig &&
        currentEmbedSig === previousEmbedSig &&
        isStreamCacheFresh(previousItem)
    ) {
        return false;
    }

    return true;
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
