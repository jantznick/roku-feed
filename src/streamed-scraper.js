import fs from 'fs/promises';
import path from 'path';
import { isBrowserConnected } from './puppeteer-utils.js';
import { resolveStreamFromEmbed } from './embed-resolver.js';
import { buildFetchHeaders } from './proxy-payload.js';
import { mapPool, getEmbedConcurrency } from './async-pool.js';
import { shouldReuseStreams, reuseStreamsFromFeedItem } from './stream-reuse.js';

/** ppv.st (successor to streamed.pk) — primary + fallback API hosts. */
const API_BASES = [
    'https://api.ppv.st/api',
    'https://api.ppv.cx/api',
];
const STREAMS_PATH = '/streams';
const SAMPLE_DATA_PATH = path.resolve(process.cwd(), 'data', 'streamed-live-sample.json');
const MAX_STREAMS_PER_GAME = 5;

/**
 * Config slugs used in index.js → ppv.st category names from /api/streams.
 * Keep the slug interface so callers do not need to change.
 */
const CATEGORY_ALIASES = {
    hockey: 'Ice Hockey',
    'ice-hockey': 'Ice Hockey',
    baseball: 'Baseball',
    basketball: 'Basketball',
    'american-football': 'American Football',
    'motor-sports': 'Motorsports',
    motorsports: 'Motorsports',
    football: 'Football',
    soccer: 'Football',
};

/**
 * Sanitizes a string to be URL- and filename-safe.
 * @param {string} text
 * @returns {string}
 */
function slugify(text) {
  if (!text) return '';
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-') // Replace spaces with -
    .replace(/[/\\?%*:|"<>]/g, '-') // Replace invalid filename chars with -
    .replace(/[^\w-]+/g, '') // Remove all non-word chars except hyphen
    .replace(/--+/g, '-') // Replace multiple hyphens with a single one
    .replace(/^-+|-+$/g, ''); // Trim hyphens from start/end
}

function buildGameId(uriName, title, startsAtSec) {
    if (uriName) {
        return slugify(String(uriName).replace(/\//g, '-'));
    }
    const dateMs = startsAtSec ? startsAtSec * 1000 : Date.now();
    return `${slugify(title)}-${new Date(dateMs).toISOString().slice(0, 10)}`;
}

function normalizeCategoryName(value) {
    if (!value) return '';
    const key = String(value).trim().toLowerCase();
    if (CATEGORY_ALIASES[key]) return CATEGORY_ALIASES[key];
    // Allow passing the display name directly ("Basketball", "Ice Hockey")
    return String(value).trim();
}

function resolveWantedCategories(categories) {
    return new Set(categories.map(normalizeCategoryName).filter(Boolean));
}

async function fetchJson(url) {
    const response = await fetch(url, {
        headers: {
            Accept: 'application/json',
            Origin: 'https://ppv.st',
            Referer: 'https://ppv.st/',
            'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
    });
    if (!response.ok) {
        throw new Error(`API returned status ${response.status} for ${url}`);
    }
    return response.json();
}

async function fetchStreamsPayload() {
    let lastError;
    for (const base of API_BASES) {
        const url = `${base}${STREAMS_PATH}`;
        try {
            const payload = await fetchJson(url);
            if (payload?.success && Array.isArray(payload.streams)) {
                return payload;
            }
            lastError = new Error(`Unexpected streams payload from ${url}`);
        } catch (error) {
            lastError = error;
        }
    }
    throw lastError || new Error('Failed to fetch ppv.st streams');
}

function flattenStreams(payload) {
    const nowSec = payload.timestamp || Math.floor(Date.now() / 1000);
    const flat = [];
    for (const group of payload.streams || []) {
        const category = group.category || group.name || '';
        for (const stream of group.streams || []) {
            flat.push({
                ...stream,
                category_name: stream.category_name || category,
                _nowSec: nowSec,
            });
        }
    }
    return flat;
}

function isCurrentlyLive(stream, nowSec) {
    if (stream.always_live) return true;
    const start = Number(stream.starts_at) || 0;
    const end = Number(stream.ends_at) || 0;
    if (!start) return false;
    // Treat missing/zero end as still live once started (rare for events).
    if (!end) return start <= nowSec;
    return start <= nowSec && nowSec < end;
}

/**
 * Collect embed URLs for a stream. Prefer the HD primary iframe, then HD
 * substreams, then SD — capped later by MAX_STREAMS_PER_GAME.
 */
function collectEmbedInfos(stream) {
    const embeds = [];
    const seen = new Set();

    const push = (iframe, sourceName) => {
        if (!iframe || seen.has(iframe) || iframe.includes('gg.poocloud.in')) return;
        seen.add(iframe);
        embeds.push({ url: iframe, sourceName: sourceName || 'ppv' });
    };

    push(stream.iframe, stream.source_tag || 'HD');

    const subs = [...(stream.substreams || [])];
    subs.sort((a, b) => {
        const aHd = /HD/i.test(a.source_tag || '') ? 0 : 1;
        const bHd = /HD/i.test(b.source_tag || '') ? 0 : 1;
        return aHd - bHd;
    });

    for (const sub of subs) {
        push(sub.iframe, sub.source_tag || 'ppv');
    }

    return embeds.slice(0, MAX_STREAMS_PER_GAME);
}

/**
 * Resolve embed→m3u8 for a list of jobs with bounded concurrency.
 * Results are assigned back onto each job's game.finalStreamInfo (max 5 each).
 * @param {import('puppeteer').Browser} browser
 * @param {Array<{ game: object, embedUrl: string, sourceName: string }>} resolveJobs
 */
async function resolveEmbedJobs(browser, resolveJobs) {
    if (resolveJobs.length === 0) {
        return;
    }

    const concurrency = getEmbedConcurrency();
    console.log(
        `Resolving ${resolveJobs.length} embeds with concurrency=${concurrency}...`
    );

    const results = await mapPool(
        resolveJobs,
        concurrency,
        async (job) => {
            if (!isBrowserConnected(browser)) {
                return null;
            }
            try {
                return await getFinalStreamUrl(browser, job.embedUrl, job.sourceName);
            } catch (error) {
                // Keep the pool alive — one embed must not abort the whole Streamed pass.
                console.warn(
                    `  -> Embed resolve failed (${job.sourceName}): ${error.message}`
                );
                return null;
            }
        },
        { shouldStop: () => !isBrowserConnected(browser) }
    );

    for (let i = 0; i < resolveJobs.length; i++) {
        const info = results[i];
        if (!info) {
            continue;
        }
        const { game } = resolveJobs[i];
        if (game.finalStreamInfo.length >= MAX_STREAMS_PER_GAME) {
            continue;
        }
        game.finalStreamInfo.push(info);
    }
}

/**
 * @param {import('puppeteer').Browser} browser
 * @param {string[]} sportsCategories
 * @param {Map<string, object>} [previousById] - prior feed items for TTL stream reuse
 */
export async function scrapeStreamedGames(browser, sportsCategories, previousById = new Map()) {
    console.log(`\n--- Scraping ppv.st for: ${sportsCategories.join(', ')} ---`);

    // 1. Get all game data from the API (cheap — no Puppeteer)
    const allGames = await getLiveStreams(sportsCategories);
    if (allGames.length === 0) {
        console.log('No streams found for the specified categories on ppv.st.');
        return [];
    }

    console.log(`\n--- Processing ${allGames.length} games from ppv.st... ---`);

    const resolveJobs = [];
    let reusedCount = 0;

    for (const game of allGames) {
        game.id = buildGameId(game.uriName, game.title, game.date);
        game.finalStreamInfo = [];
        game.reusedStreamLinks = null;

        const previousItem = previousById.get(game.id);
        if (shouldReuseStreams(previousItem, game.embedUrls, { currentTitle: game.title })) {
            const reused = reuseStreamsFromFeedItem(previousItem);
            if (reused) {
                game.reusedStreamLinks = reused;
                reusedCount += 1;
                console.log(
                    `↻ Reusing ${reused.length} stream(s) for: ${game.title} (still fresh)`
                );
                continue;
            }
        }

        console.log(`\nProcessing game: ${game.title} (Category: ${game.category})`);
        for (const embed of game.embedUrls) {
            resolveJobs.push({
                game,
                embedUrl: embed.url,
                sourceName: embed.sourceName,
            });
        }
    }

    console.log(
        `\nStream reuse: ${reusedCount} game(s) skipped Puppeteer; ` +
        `${allGames.length - reusedCount} game(s) need embed resolve.`
    );

    await resolveEmbedJobs(browser, resolveJobs);

    // 3. Transform the data into the final format for the main feed
    const dateAdded = new Date().toISOString();
    const formattedGames = allGames.map(game => {
        const streamLinks = game.reusedStreamLinks
            ? game.reusedStreamLinks
            : (game.finalStreamInfo || []).map((info, index) => {
                if (!info) return null;
                return {
                    name: info.sourceName || `Stream ${index + 1}`,
                    url: info.streamUrl,
                    headers: {
                        Referer: info.referer
                    },
                    requestHeaders: info.requestHeaders || {},
                    embedUrl: info.embedUrl,
                    directFetchOk: Boolean(info.directFetchOk),
                    confirmedAt: info.confirmedAt
                };
            }).filter(Boolean);

        if (streamLinks.length === 0) return null;

        const teams = game.title.includes(' vs ')
            ? game.title.split(' vs ')
            : game.title.includes(' at ')
                ? game.title.split(' at ')
                : [game.title, ''];

        const startMs = (game.date || Math.floor(Date.now() / 1000)) * 1000;

        return {
            id: game.id,
            name: game.title,
            teams: teams,
            time: new Date(startMs).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
            shortDescription: `Live stream of the ${game.title} match.`,
            releaseDate: new Date(startMs).toISOString(),
            dateAdded: dateAdded,
            league: getLeague(game),
            poster: game.poster,
            streamLinks: streamLinks
        };
    }).filter(Boolean);

    console.log(`✅ Found and processed ${formattedGames.length} games from ppv.st.`);
    return formattedGames;
}

function getLeague(game) {
    if (game.tag) return game.tag;
    if (game.category === 'Football' && game.title.includes(':')) {
        return game.title.split(':')[0].trim();
    }
    return (game.category || 'Sports').toUpperCase();
}

async function getLiveStreams(categories) {
    try {
        const isDebug = process.env.DEBUG === 'true';
        let flatStreams;

        if (isDebug) {
            console.log('DEBUG MODE: Reading from local sample file for ppv.st...');
            try {
                const sampleData = await fs.readFile(SAMPLE_DATA_PATH, 'utf8');
                const parsed = JSON.parse(sampleData);
                // Support both the new ppv.st payload shape and a pre-flattened array.
                flatStreams = Array.isArray(parsed)
                    ? parsed
                    : flattenStreams(parsed);
            } catch (error) {
                console.error(`Error reading sample file at ${SAMPLE_DATA_PATH}. Please ensure the file has been created.`, error);
                return [];
            }
        } else {
            console.log('Fetching streams from ppv.st...');
            const payload = await fetchStreamsPayload();
            flatStreams = flattenStreams(payload);
        }

        const wanted = resolveWantedCategories(categories);
        const nowSec = flatStreams[0]?._nowSec || Math.floor(Date.now() / 1000);

        const sportGames = flatStreams.filter((stream) => {
            if (stream.always_live) return false; // handled by scrape247Channels
            if (!wanted.has(stream.category_name)) return false;
            if (!stream.iframe && !(stream.substreams || []).some((s) => s.iframe)) return false;
            // DEBUG sample dumps are static — skip the "currently live" window filter.
            return isDebug ? true : isCurrentlyLive(stream, nowSec);
        });

        if (sportGames.length === 0) {
            return [];
        }

        const categoryCounts = sportGames.reduce((acc, game) => {
            acc[game.category_name] = (acc[game.category_name] || 0) + 1;
            return acc;
        }, {});
        console.log('Games found after filtering by category:', categoryCounts);

        console.log(`Found ${sportGames.length} live games across specified categories.`);
        const allGameStreams = [];

        for (const game of sportGames) {
            try {
                const allEmbedUrls = collectEmbedInfos(game);
                if (allEmbedUrls.length === 0) continue;

                allGameStreams.push({
                    title: game.name,
                    category: game.category_name,
                    tag: game.tag,
                    embedUrls: allEmbedUrls,
                    date: game.starts_at,
                    poster: game.poster,
                    uriName: game.uri_name,
                });
            } catch (gameError) {
                console.error(`Could not process game "${game.name}": ${gameError.message}`);
            }
        }

        return allGameStreams;

    } catch (error) {
        console.error('An error occurred while fetching stream data:', error.message);
        return [];
    }
}

async function logReplayCheck(streamInfo) {
    const headers = buildFetchHeaders(streamInfo.referer, streamInfo.requestHeaders);
    try {
        const response = await fetch(streamInfo.streamUrl, { headers, redirect: 'follow' });
        const preview = response.ok
            ? (await response.text()).slice(0, 60).replace(/\s+/g, ' ')
            : `(body omitted, status ${response.status})`;
        console.log(`  -> Immediate Node replay check: ${response.status} ${response.statusText}`);
        if (response.ok) {
            console.log(`  -> Manifest preview: ${preview}`);
            console.log('  -> Will set d=1 on proxy URL (direct HTTP path)');
        } else if (streamInfo.referer?.includes('exposestrat.com')) {
            console.log('  -> zohanayaan CDN: Node replay often works with exposestrat.com referer.');
        } else {
            console.log('  -> CDN: Node replay usually fails (403) — proxy will use Chromium.');
        }
        return response.ok;
    } catch (error) {
        console.log(`  -> Immediate Node replay check failed: ${error.message}`);
        return false;
    }
}

export async function getFinalStreamUrl(browser, embedUrl, sourceName) {
    if (!isBrowserConnected(browser)) {
        return null;
    }

    const streamInfo = await resolveStreamFromEmbed(browser, embedUrl, {
        sourceName,
        verbose: true,
        checkNodeReplay: false,
    });

    if (streamInfo) {
        streamInfo.directFetchOk = await logReplayCheck(streamInfo);
    }

    return streamInfo;
}

/**
 * @param {import('puppeteer').Browser} browser
 * @param {Map<string, object>} [previousById]
 */
export async function scrape247Channels(browser, previousById = new Map()) {
    console.log(`\n--- Scraping ppv.st for 24/7 Channels ---`);
    // Match against channel name / source_tag (case-insensitive substring).
    const targetTitles = [
        'NHL NETWORK',
        'MLB TV',
        'Marquee Sports Network',
        'TNT',
        'NBA TV',
        'ESPN USA',
        'NFL REDZONE',
        'NFL NETWORK',
    ];

    let allChannels = [];

    try {
        const isDebug = process.env.DEBUG === 'true';
        let flatStreams;

        if (isDebug) {
            const sampleData = await fs.readFile(SAMPLE_DATA_PATH, 'utf8');
            const parsed = JSON.parse(sampleData);
            flatStreams = Array.isArray(parsed) ? parsed : flattenStreams(parsed);
        } else {
            const payload = await fetchStreamsPayload();
            flatStreams = flattenStreams(payload);
        }

        const alwaysLive = flatStreams.filter(
            (s) => s.always_live || /24\/7/i.test(s.tag || '') || /24\/7/i.test(s.category_name || '')
        );

        for (const channel of alwaysLive) {
            for (const targetTitle of targetTitles) {
                const haystack = `${channel.name || ''} ${channel.source_tag || ''}`.toLowerCase();
                if (haystack.includes(targetTitle.toLowerCase())) {
                    channel.cleanTitle = targetTitle;
                    allChannels.push(channel);
                    console.log(`  -> Matched API title "${channel.name}" to target "${targetTitle}"`);
                    break;
                }
            }
        }
    } catch (error) {
        console.error(`  -> Failed to fetch 24/7 channels from ppv.st:`, error.message);
        return [];
    }

    if (allChannels.length === 0) {
        console.log('No 24/7 channels found.');
        return [];
    }

    console.log(`\n--- Processing ${allChannels.length} found 24/7 channels... ---`);

    const resolveJobs = [];
    let reusedCount = 0;

    for (const channel of allChannels) {
        channel.id = channel.cleanTitle.replace(/\s+/g, '-');
        channel.finalStreamInfo = [];
        channel.reusedStreamLinks = null;
        channel.embedUrls = collectEmbedInfos(channel);
        channel.title = channel.name;

        const previousItem = previousById.get(channel.id);
        if (shouldReuseStreams(previousItem, channel.embedUrls, { currentTitle: channel.cleanTitle })) {
            const reused = reuseStreamsFromFeedItem(previousItem);
            if (reused) {
                channel.reusedStreamLinks = reused;
                reusedCount += 1;
                console.log(
                    `↻ Reusing ${reused.length} stream(s) for channel: ${channel.cleanTitle} (still fresh)`
                );
                continue;
            }
        }

        console.log(`\nProcessing channel: ${channel.title}`);
        for (const embed of channel.embedUrls) {
            resolveJobs.push({
                game: channel,
                embedUrl: embed.url,
                sourceName: embed.sourceName,
            });
        }
    }

    console.log(
        `\n24/7 reuse: ${reusedCount} channel(s) skipped Puppeteer; ` +
        `${allChannels.length - reusedCount} channel(s) need embed resolve.`
    );

    await resolveEmbedJobs(browser, resolveJobs);

    const formattedChannels = allChannels.map(channel => {
        const streamLinks = channel.reusedStreamLinks
            ? channel.reusedStreamLinks
            : (channel.finalStreamInfo || []).map((info, index) => {
                if (!info) return null;
                return {
                    name: info.sourceName || `Stream ${index + 1}`,
                    url: info.streamUrl,
                    headers: { Referer: info.referer },
                    requestHeaders: info.requestHeaders || {},
                    embedUrl: info.embedUrl,
                    directFetchOk: Boolean(info.directFetchOk),
                    confirmedAt: info.confirmedAt
                };
            }).filter(Boolean);

        if (streamLinks.length === 0) return null;

        const customLogo = channelLogoMap[channel.cleanTitle];
        const posterUrl = customLogo ? `${LOGO_BASE_URL}${customLogo}` : channel.poster;

        return {
            id: channel.id,
            name: channel.cleanTitle,
            teams: [channel.cleanTitle, ''],
            time: '24/7',
            shortDescription: 'Live 24/7 Channel',
            releaseDate: new Date().toISOString(),
            dateAdded: new Date().toISOString(),
            league: '24/7 Channels',
            poster: posterUrl,
            streamLinks: streamLinks
        };
    }).filter(Boolean);

    const uniqueChannels = Array.from(new Map(formattedChannels.map(c => [c.id, c])).values());

    console.log(`✅ Found and processed ${uniqueChannels.length} unique 24/7 channels.`);
    return uniqueChannels;
}

const channelLogoMap = {
    'ESPN USA': 'espn.png',
    'NFL REDZONE': 'nfl-red-zone.png',
    'NFL NETWORK': 'nfl-network.jpeg',
    'NHL NETWORK': 'nhl-network.jpg',
    'MLB TV': 'mlb-tv.png',
    'Marquee Sports Network': 'marquee.jpeg',
    'TNT': 'tnt.png',
    'NBA TV': 'nba-tv.png'
};

const LOGO_BASE_URL = 'https://roku-hockey.s3.us-west-004.backblazeb2.com/channel-logos/';
