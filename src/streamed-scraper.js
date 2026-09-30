import fs from 'fs/promises';
import path from 'path';
import { isBrowserConnected } from './puppeteer-utils.js';
import { resolveStreamFromEmbed } from './embed-resolver.js';
import { buildFetchHeaders } from './proxy-payload.js';
import { mapPool, getEmbedConcurrency } from './async-pool.js';
import { shouldReuseStreams, reuseStreamsFromFeedItem } from './stream-reuse.js';

const LIVE_MATCHES_URL = 'https://streamed.pk/api/matches/live';
const STREAM_API_BASE_URL = 'https://streamed.pk/api/stream';
const SAMPLE_DATA_PATH = path.resolve(process.cwd(), 'data', 'streamed-live-sample.json');
const MAX_STREAMS_PER_GAME = 5;

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

function buildGameId(title, date) {
    return `${slugify(title)}-${new Date(date || Date.now()).toISOString().slice(0, 10)}`;
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
            return getFinalStreamUrl(browser, job.embedUrl, job.sourceName);
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
    console.log(`\n--- Scraping Streamed.pk for: ${sportsCategories.join(', ')} ---`);

    // 1. Get all game data from the API (cheap — no Puppeteer)
    const allGames = await getLiveStreams(sportsCategories);
    if (allGames.length === 0) {
        console.log('No streams found for the specified categories on Streamed.pk.');
        return [];
    }

    console.log(`\n--- Processing ${allGames.length} games from Streamed.pk... ---`);

    const resolveJobs = [];
    let reusedCount = 0;

    for (const game of allGames) {
        game.id = buildGameId(game.title, game.date);
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

        const teams = game.title.includes(' vs ') ? game.title.split(' vs ') : [game.title, ''];

        return {
            id: game.id,
            name: game.title,
            teams: teams,
            time: new Date(game.date || Date.now()).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
            shortDescription: `Live stream of the ${game.title} match.`,
            releaseDate: new Date(game.date || Date.now()).toISOString(),
            dateAdded: dateAdded,
            league: getLeague(game),
            poster: game.poster,
            streamLinks: streamLinks
        };
    }).filter(Boolean);

    console.log(`✅ Found and processed ${formattedGames.length} games from Streamed.pk.`);
    return formattedGames;
}

function getLeague(game) {
    if (game.category === 'football' && game.title.includes(':')) {
        return game.title.split(':')[0].trim();
    }
    return game.category.toUpperCase();
}

async function getLiveStreams(categories) {
    try {
        const isDebug = process.env.DEBUG === 'true';
        let matches;

        if (isDebug) {
            console.log('DEBUG MODE: Reading from local sample file for Streamed.pk...');
            try {
                const sampleData = await fs.readFile(SAMPLE_DATA_PATH, 'utf8');
                matches = JSON.parse(sampleData);
            } catch (error) {
                console.error(`Error reading sample file at ${SAMPLE_DATA_PATH}. Please ensure the file has been created.`, error);
                return [];
            }
        } else {
            console.log('Fetching live matches from Streamed.pk...');
            const matchesResponse = await fetch(LIVE_MATCHES_URL);
            if (!matchesResponse.ok) throw new Error(`API returned status ${matchesResponse.status}`);
            matches = await matchesResponse.json();
        }

        const sportGames = matches.filter(match => categories.includes(match.category) && match.sources && match.sources.length > 0);

        if (sportGames.length === 0) {
            return [];
        }

        const categoryCounts = sportGames.reduce((acc, game) => {
            acc[game.category] = (acc[game.category] || 0) + 1;
            return acc;
        }, {});
        console.log('Games found after filtering by category:', categoryCounts);


        console.log(`Found ${sportGames.length} games across specified categories. Fetching initial stream info...`);
        const allGameStreams = [];

        for (const game of sportGames) {
            try {
                const allEmbedUrls = [];

                for (const source of game.sources) {
                    try {
                        const streamApiUrl = `${STREAM_API_BASE_URL}/${source.source}/${source.id}`;
                        const streamsResponse = await fetch(streamApiUrl);
                        if (!streamsResponse.ok) continue;
                        const streams = await streamsResponse.json();

                        if (streams && streams.length > 0) {
                            const embedInfos = streams.map(stream => ({
                                url: stream.embedUrl,
                                sourceName: source.source
                            })).filter(info => !info.url.includes('gg.poocloud.in'));
                            allEmbedUrls.push(...embedInfos);
                        }
                    } catch (sourceError) {
                        // Suppress verbose warnings during normal operation
                    }
                }

                if (allEmbedUrls.length > 0) {
                    allGameStreams.push({
                        title: game.title,
                        category: game.category,
                        embedUrls: allEmbedUrls,
                        date: game.date,
                        poster: game.poster
                    });
                }
            } catch (gameError) {
                console.error(`Could not process game "${game.title}": ${gameError.message}`);
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
            console.log('  -> strmd CDN: Node replay usually fails (403) — proxy will use Chromium.');
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
    console.log(`\n--- Scraping for 24/7 Channels ---`);
    const channelMap = {
        'hockey': ['NHL NETWORK'],
        'baseball': ['MLB TV', 'Marquee Sports Network'],
        'basketball': ['TNT', 'NBA TV'],
        'american-football': ['ESPN USA', 'NFL REDZONE', 'NFL NETWORK']
    };

    let allChannels = [];

    for (const sport in channelMap) {
        try {
            const response = await fetch(`https://streamed.pk/api/matches/${sport}`);
            if (!response.ok) continue;

            const sportChannels = await response.json();
            const targetTitles = channelMap[sport];

            for (const channel of sportChannels) {
                for (const targetTitle of targetTitles) {
                    if (channel.title.toLowerCase().includes(targetTitle.toLowerCase())) {
                        channel.cleanTitle = targetTitle;
                        allChannels.push(channel);
                        console.log(`  -> Matched API title "${channel.title}" to target "${targetTitle}"`);
                        break;
                    }
                }
            }
        } catch (error) {
            console.error(`  -> Failed to fetch channels for ${sport}:`, error.message);
        }
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
        channel.embedUrls = [];

        for (const source of channel.sources) {
             try {
                const streamApiUrl = `${STREAM_API_BASE_URL}/${source.source}/${source.id}`;
                const streamsResponse = await fetch(streamApiUrl);
                if (!streamsResponse.ok) continue;
                const streams = await streamsResponse.json();
                if (streams && streams.length > 0) {
                    const embedInfos = streams.map(s => ({
                        url: s.embedUrl,
                        sourceName: source.source
                    })).filter(info => !info.url.includes('gg.poocloud.in'));
                    channel.embedUrls.push(...embedInfos);
                }
            } catch (e) {}
        }

        channel.embedUrls.sort((a, b) => {
            const aIsPoo = a.url.includes('gg.poocloud.in');
            const bIsPoo = b.url.includes('gg.poocloud.in');
            return aIsPoo - bIsPoo;
        });

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
