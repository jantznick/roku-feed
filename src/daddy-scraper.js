/**
 * DaddyLive (thedaddy.li) 24/7 channels — secondary / fill-in source.
 *
 * Runs after TimStreams/ppv 24/7: skip any channel whose name already exists
 * in the combined scrape, resolve the rest. Useful as failover when TimStreams
 * drops a channel, and for USA extras TimStreams doesn't carry (RedZone,
 * regionals, Cinemax, etc.).
 *
 * Catalog: GET https://thedaddy.li/24-7-channels.php (HTML cards)
 * Player:  https://thedaddy.li/stream/stream-{id}.php → dembed.st → signed m3u8
 */

import { resolveStreamFromEmbed } from './embed-resolver.js';
import { BROWSER_USER_AGENT } from './proxy-payload.js';
import { mapPool, getEmbedConcurrency } from './async-pool.js';
import { isBrowserConnected } from './puppeteer-utils.js';
import {
    shouldReuseStreams,
    reuseStreamsFromFeedItem,
} from './stream-reuse.js';

const SITE_ORIGIN = 'https://thedaddy.li/';
const CHANNELS_PAGE = 'https://thedaddy.li/24-7-channels.php';
const STREAM_WRAPPER = (id) => `https://thedaddy.li/stream/stream-${id}.php`;

/**
 * Exact catalog titles (no "USA" suffix) that are still US nets we want.
 * Names must match thedaddy.li card titles exactly.
 */
const EXTRA_US_TITLES = new Set([
    'NFL Network',
    'NFL RedZone',
    'Fox News',
    'The Weather Channel',
    'Paramount Network',
    'Cartoon Network',
    'Boomerang',
    'Adult Swim',
    'Disney Channel',
    'Disney XD',
    'Disney JR',
    'NICK',
    'Nicktoons',
    'TeenNick',
    'NICK JR',
    'Telemundo',
    'Univision',
    'HGTV',
    'The Food Network',
    'Discovery Channel',
    'Animal Planet',
    'FX Movie Channel',
    'CBS Sports Network (CBSSN)',
    'Starz',
    'Starz Cinema',
    'Starz Comedy',
    'Starz Edge',
    'Starz In Black',
    'Starz Kids & Family',
    'Starz Encore',
    'Starz Encore Action',
    'Starz Encore Black',
    'Starz Encore Classic',
    'Starz Encore Family',
    'Starz Encore Suspense',
    'Starz Encore Westerns',
    'NBC Sports Bay Area',
    'NBC Sports Philadelphia',
    'NBC Sports Boston',
    'NBC Sports California',
]);

const MOVIE_MARKERS = [
    'hbo',
    'showtime',
    'starz',
    'cinemax',
    'mgm',
    'epix',
    'tmc',
];
const NEWS_MARKERS = [
    'cnn',
    'fox news',
    'cnbc',
    'newsmax',
    'newsnation',
    'weather',
    'bbc news',
];
const CARTOON_MARKERS = [
    'cartoon',
    'boomerang',
    'disney',
    'nick',
    'teennick',
    'adult swim',
    'universal kids',
];
const SPORTS_MARKERS = [
    'espn',
    'nfl',
    'nba',
    'nhl',
    'mlb',
    'fox sports',
    'cbs sports',
    'golf',
    'acc network',
    'sec network',
    'big ten',
    'btn',
    'tudn',
    'bein',
    'racer',
    'nesn',
    'yes network',
    'msg',
    'masn',
    'spectrum sports',
    'pac-12',
    'nbc sports',
    'redzone',
];

/**
 * Normalize channel titles for cross-source dedupe (Daddy ↔ TimStreams ↔ ppv).
 * @param {string} name
 */
export function normalizeChannelName(name) {
    let s = String(name || '')
        .toLowerCase()
        .replace(/&amp;/g, '&')
        .replace(/&/g, ' and ')
        .replace(/\+/g, ' plus ');
    s = s.replace(/\(.*?\)/g, ' ');
    s = s.replace(/\b(usa|us|uk|ca|hd)\b/g, ' ');
    s = s.replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();

    const aliases = {
        ae: 'ae',
        'a and e': 'ae',
        espn2: 'espn2',
        'espn 2': 'espn2',
        espnu: 'espnu',
        'fox sports 1': 'fox sports 1',
        fs1: 'fox sports 1',
        'fox sports 2': 'fox sports 2',
        fs2: 'fox sports 2',
        'big ten network': 'big ten network',
        'big ten network btn': 'big ten network',
        btn: 'big ten network',
        'cbs sports network': 'cbs sports network',
        'cbs sports network cbssn': 'cbs sports network',
        cbssn: 'cbs sports network',
        'golf channel': 'golf channel',
        'nba tv': 'nba tv',
        'nhl network': 'nhl network',
        'mlb network': 'mlb network',
        'acc network': 'acc network',
        'sec network': 'sec network',
        'nfl network': 'nfl network',
        'nfl redzone': 'nfl redzone',
        'disney jr': 'disney junior',
        'disney junior': 'disney junior',
        nick: 'nickelodeon',
        nickelodeon: 'nickelodeon',
        'nick jr': 'nick jr',
        'food network': 'food network',
        'the food network': 'food network',
        'weather channel': 'weather channel',
        'the weather channel': 'weather channel',
        'fox news': 'fox news',
        'racer tv': 'racer network',
        'racer network': 'racer network',
        'bein sports': 'bein sports',
        'usa network': 'usa network',
        'fx movie channel': 'fxm',
        fxm: 'fxm',
        'hbo 2': 'hbo2',
        hbo2: 'hbo2',
        'showtime 2': 'showtime 2',
        'showtime 2 sho2': 'showtime 2',
        'starz kids and family': 'starz kids and family',
        'starz kids family': 'starz kids and family',
        'nbc sports bay area': 'nbc sports bay area',
        'nbc sports philadelphia': 'nbc sports philadelphia',
        'nbc sports boston': 'nbc sports boston',
        'nbc sports california': 'nbc sports california',
    };
    return aliases[s] || s;
}

function decodeHtmlEntities(text) {
    return String(text || '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
}

function isUsaInterest(name) {
    if (/\bUSA\b/i.test(name) || name === 'USA Network') return true;
    return EXTRA_US_TITLES.has(name);
}

function leagueForDaddyChannel(name) {
    const lower = name.toLowerCase();
    if (MOVIE_MARKERS.some((m) => lower.includes(m))) return 'Movies';
    if (NEWS_MARKERS.some((m) => lower.includes(m))) return 'News';
    if (CARTOON_MARKERS.some((m) => lower.includes(m))) return 'Cartoons';
    if (SPORTS_MARKERS.some((m) => lower.includes(m))) return '24/7 Channels';
    return 'Entertainment';
}

/**
 * @param {string} html
 * @returns {Array<{ id: number, name: string }>}
 */
export function parseDaddyChannelsHtml(html) {
    const cards = [
        ...String(html).matchAll(
            /href="\/watch\.php\?id=(\d+)"[\s\S]*?<div class="card__title">([^<]+)<\/div>/gi
        ),
    ];
    const byId = new Map();
    for (const match of cards) {
        const id = Number.parseInt(match[1], 10);
        const name = decodeHtmlEntities(match[2].replace(/\s+/g, ' ').trim());
        if (!id || !name) continue;
        byId.set(id, { id, name });
    }
    return [...byId.values()];
}

async function fetchDaddyCatalog() {
    const response = await fetch(CHANNELS_PAGE, {
        headers: {
            'User-Agent': BROWSER_USER_AGENT,
            Accept: 'text/html,application/xhtml+xml',
            Referer: SITE_ORIGIN,
        },
    });
    if (!response.ok) {
        throw new Error(`channels page HTTP ${response.status}`);
    }
    const html = await response.text();
    return parseDaddyChannelsHtml(html);
}

/**
 * @param {Iterable<object>} existingItems - already-scraped feed items (any source)
 * @returns {Set<string>}
 */
export function buildExistingChannelKeys(existingItems) {
    const keys = new Set();
    for (const item of existingItems || []) {
        const name = item?.name || item?.title || '';
        const key = normalizeChannelName(name);
        if (key) keys.add(key);
        // Also index team[0] for 24/7-style items
        const team0 = Array.isArray(item?.teams) ? item.teams[0] : '';
        const teamKey = normalizeChannelName(team0);
        if (teamKey) keys.add(teamKey);
    }
    return keys;
}

async function resolveDaddyStream(browser, channelId, label) {
    if (!isBrowserConnected(browser)) return null;

    const embedUrl = STREAM_WRAPPER(channelId);
    const streamInfo = await resolveStreamFromEmbed(browser, embedUrl, {
        sourceName: 'DaddyLive',
        verbose: true,
        checkNodeReplay: false,
    });
    if (!streamInfo) {
        console.log(`-- DaddyLive: no m3u8 for ${label}`);
        return null;
    }

    return {
        streamUrl: streamInfo.streamUrl,
        referer: streamInfo.referer || 'https://dembed.st/',
        embedUrl,
        sourceName: 'DaddyLive',
        confirmedAt: streamInfo.confirmedAt || new Date().toISOString(),
        directFetchOk: Boolean(streamInfo.directFetchOk),
        requestHeaders: streamInfo.requestHeaders || {},
    };
}

/**
 * Scrape DaddyLive 24/7 USA channels that are not already present.
 *
 * @param {import('puppeteer').Browser} browser
 * @param {object[]} existingItems - items already collected this run
 * @param {Map<string, object>} [previousById]
 */
export async function scrapeDaddyChannels(
    browser,
    existingItems = [],
    previousById = new Map()
) {
    if (process.env.SKIP_DADDY === 'true') {
        console.log('\n--- Skipping DaddyLive 24/7 (SKIP_DADDY=true) ---');
        return [];
    }

    console.log('\n--- Scraping DaddyLive 24/7 (thedaddy.li) — fill-in only ---');

    let catalog;
    try {
        catalog = await fetchDaddyCatalog();
    } catch (error) {
        console.error(`DaddyLive catalog fetch failed: ${error.message}`);
        return [];
    }

    const usaInterest = catalog.filter((c) => isUsaInterest(c.name));
    const existingKeys = buildExistingChannelKeys(existingItems);
    const candidates = usaInterest.filter(
        (c) => !existingKeys.has(normalizeChannelName(c.name))
    );

    console.log(
        `DaddyLive catalog: ${catalog.length} total, ${usaInterest.length} USA-ish, ` +
            `${candidates.length} new after skipping ${usaInterest.length - candidates.length} overlaps.`
    );

    if (candidates.length === 0) {
        console.log('No new DaddyLive channels to add.');
        return [];
    }

    const byLeague = candidates.reduce((acc, ch) => {
        const league = leagueForDaddyChannel(ch.name);
        acc[league] = (acc[league] || 0) + 1;
        return acc;
    }, {});
    console.log(
        `Resolving ${candidates.length} DaddyLive extras ` +
            `(${Object.entries(byLeague).map(([k, v]) => `${k}: ${v}`).join(', ')})…`
    );

    const concurrency = Math.min(getEmbedConcurrency(), 2);
    const dateAdded = new Date().toISOString();
    let reusedCount = 0;

    const results = await mapPool(
        candidates,
        concurrency,
        async (channel) => {
            if (!isBrowserConnected(browser)) return null;

            const id = `daddy-${channel.id}`;
            const embedUrl = STREAM_WRAPPER(channel.id);
            const embedUrls = [{ url: embedUrl, sourceName: 'DaddyLive' }];
            const league = leagueForDaddyChannel(channel.name);
            const shortDescription =
                league === 'Cartoons'
                    ? 'DaddyLive cartoons'
                    : league === 'Movies'
                        ? 'DaddyLive movies'
                        : league === 'News'
                            ? 'DaddyLive news'
                            : league === '24/7 Channels'
                                ? 'DaddyLive live TV'
                                : 'DaddyLive entertainment';

            const previousItem = previousById.get(id);
            if (shouldReuseStreams(previousItem, embedUrls, { currentTitle: channel.name })) {
                const reused = reuseStreamsFromFeedItem(previousItem);
                if (reused?.length) {
                    reusedCount += 1;
                    console.log(`↻ Reusing DaddyLive stream for: ${channel.name}`);
                    return {
                        id,
                        name: channel.name,
                        teams: [channel.name, ''],
                        time: '24/7',
                        shortDescription,
                        releaseDate: new Date().toISOString(),
                        dateAdded,
                        league,
                        poster: null,
                        streamLinks: reused,
                    };
                }
            }

            const resolved = await resolveDaddyStream(browser, channel.id, channel.name);
            if (!resolved) return null;

            return {
                id,
                name: channel.name,
                teams: [channel.name, ''],
                time: '24/7',
                shortDescription,
                releaseDate: new Date().toISOString(),
                dateAdded,
                league,
                poster: null,
                streamLinks: [
                    {
                        name: resolved.sourceName,
                        url: resolved.streamUrl,
                        headers: { Referer: resolved.referer },
                        requestHeaders: resolved.requestHeaders || {},
                        embedUrl: resolved.embedUrl,
                        directFetchOk: Boolean(resolved.directFetchOk),
                        confirmedAt: resolved.confirmedAt,
                    },
                ],
            };
        },
        { shouldStop: () => !isBrowserConnected(browser) }
    );

    const channels = results.filter(Boolean);
    const leagueCounts = channels.reduce((acc, ch) => {
        acc[ch.league] = (acc[ch.league] || 0) + 1;
        return acc;
    }, {});
    console.log(
        `✅ DaddyLive: ${channels.length}/${candidates.length} extras ready` +
            (reusedCount ? ` (${reusedCount} reused)` : '') +
            ` → ${Object.entries(leagueCounts).map(([k, v]) => `${k}: ${v}`).join(', ') || 'none'}`
    );
    return channels;
}
