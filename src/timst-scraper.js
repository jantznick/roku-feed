/**
 * TimStreams (timst.top) live-TV channels.
 *
 * Channel catalog: GET https://timst.top/api/channels
 * Stream wrappers: https://grandemx.org/<id> → JW Player with a signed .m3u8
 *
 * The CDN often 404s from datacenter IPs; we still capture the signed URL +
 * Referer so the LAN proxy / home IP can fetch it (same pattern as Streamed).
 */

import { attachAdWindowHandler } from './manifest-capture.js';
import { BROWSER_USER_AGENT } from './proxy-payload.js';
import { mapPool, getEmbedConcurrency } from './async-pool.js';
import {
    isBrowserConnected,
    isBrowserConnectionError,
    safeClosePage,
} from './puppeteer-utils.js';
import {
    shouldReuseStreams,
    reuseStreamsFromFeedItem,
} from './stream-reuse.js';

const CHANNELS_API = 'https://timst.top/api/channels';
const SITE_ORIGIN = 'https://timst.top/';
const PLAYER_REFERER = 'https://grandemx.org/';

/**
 * Curated US cable / sports channels for the "Other" feed row (verification set).
 * Names must match timst.top catalog `channel.name` exactly.
 */
const CHANNEL_ALLOWLIST = [
    'ESPN',
    'ESPN2',
    'ESPNEWS',
    'ESPNU',
    'ESPN Deportes',
    'Fox Sports 1',
    'Fox Sports 2',
    'CBS Sports Network',
    'NFL Network',
    'NBA TV',
    'NHL Network',
    'MLB Network',
    'TNT',
    'TBS',
    'USA Network',
    'ABC',
    'CBS',
    'NBC',
    'Fox',
];

/**
 * @param {import('puppeteer').Browser} browser
 * @param {string} shortUrl - grandemx.org short link from the API
 * @param {string} label
 * @returns {Promise<{ streamUrl: string, referer: string, embedUrl: string, sourceName: string, confirmedAt: string, directFetchOk: boolean }|null>}
 */
async function resolveGrandeMxSignedUrl(browser, shortUrl, label) {
    if (!isBrowserConnected(browser)) return null;

    let page;
    let capturedM3u8 = null;

    try {
        page = await browser.newPage();
        await page.setCacheEnabled(false);
        await page.setUserAgent(BROWSER_USER_AGENT);
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9',
            Referer: SITE_ORIGIN,
        });
        attachAdWindowHandler(page, () => {});

        const consider = (url) => {
            if (!url || !url.includes('.m3u8')) return;
            if (url.includes('jwpltx.com') || url.includes('ping.gif')) return;
            capturedM3u8 = url;
        };

        page.on('request', (req) => consider(req.url()));
        page.on('response', (res) => consider(res.url()));

        console.log(`-- TimStreams: opening ${label}: ${shortUrl}`);
        await page.goto(shortUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });

        // Prefer JW Player playlist file (available even when CDN returns 404).
        const fromPlayer = await page
            .waitForFunction(() => {
                try {
                    if (typeof jwplayer !== 'function') return null;
                    const player = jwplayer('player');
                    if (!player || typeof player.getPlaylist !== 'function') return null;
                    const playlist = player.getPlaylist();
                    const item = playlist?.[0];
                    return item?.file || item?.sources?.[0]?.file || null;
                } catch {
                    return null;
                }
            }, { timeout: 15000 })
            .then((handle) => handle.jsonValue())
            .catch(() => null);

        if (fromPlayer) {
            consider(fromPlayer);
        }

        // Brief settle for late network requests if JW was slow.
        if (!capturedM3u8) {
            await new Promise((r) => setTimeout(r, 3000));
        }

        if (!capturedM3u8) {
            console.log(`-- TimStreams: no m3u8 for ${label}`);
            return null;
        }

        let directFetchOk = false;
        try {
            const probe = await fetch(capturedM3u8, {
                headers: {
                    Referer: PLAYER_REFERER,
                    'User-Agent': BROWSER_USER_AGENT,
                },
                redirect: 'follow',
            });
            directFetchOk = probe.ok;
            console.log(
                `-- TimStreams: ${label} → ${capturedM3u8.slice(0, 90)}… (probe ${probe.status})`
            );
        } catch (error) {
            console.log(`-- TimStreams: ${label} probe failed: ${error.message}`);
        }

        return {
            streamUrl: capturedM3u8,
            referer: PLAYER_REFERER,
            embedUrl: shortUrl,
            sourceName: 'TimStreams',
            confirmedAt: new Date().toISOString(),
            directFetchOk,
        };
    } catch (error) {
        if (isBrowserConnectionError(error)) {
            console.log(`-- TimStreams: browser lost while resolving ${label}`);
        } else {
            console.error(`-- TimStreams: resolve error for ${label}: ${error.message}`);
        }
        return null;
    } finally {
        await safeClosePage(page);
    }
}

/**
 * @returns {Promise<Array<{ name: string, url: string, logo?: string, shortUrl: string }>>}
 */
async function fetchAllowlistedChannels() {
    const response = await fetch(CHANNELS_API, {
        headers: {
            'User-Agent': BROWSER_USER_AGENT,
            Accept: 'application/json',
            Referer: SITE_ORIGIN,
        },
    });
    if (!response.ok) {
        throw new Error(`channels API HTTP ${response.status}`);
    }

    const data = await response.json();
    const channels = Array.isArray(data?.channels) ? data.channels : [];
    const allow = new Set(CHANNEL_ALLOWLIST.map((n) => n.toLowerCase()));

    const picked = [];
    for (const channel of channels) {
        const name = (channel?.name || '').trim();
        if (!allow.has(name.toLowerCase())) continue;

        const streams = Array.isArray(channel.streams) ? channel.streams : [];
        const free = streams.find((s) => s?.url && !s.vip) || streams.find((s) => s?.url);
        if (!free?.url) continue;

        picked.push({
            name,
            url: channel.url || name.toLowerCase().replace(/\s+/g, '-'),
            logo: channel.logo || null,
            shortUrl: free.url,
        });
    }

    // Stable order matching the allowlist.
    const order = new Map(CHANNEL_ALLOWLIST.map((n, i) => [n.toLowerCase(), i]));
    picked.sort(
        (a, b) => (order.get(a.name.toLowerCase()) ?? 99) - (order.get(b.name.toLowerCase()) ?? 99)
    );
    return picked;
}

/**
 * Scrape curated TimStreams live-TV channels into the "Other" feed section.
 * @param {import('puppeteer').Browser} browser
 * @param {Map<string, object>} [previousById]
 */
export async function scrapeTimstChannels(browser, previousById = new Map()) {
    if (process.env.SKIP_TIMST === 'true') {
        console.log('\n--- Skipping TimStreams live-TV (SKIP_TIMST=true) ---');
        return [];
    }

    console.log('\n--- Scraping TimStreams live-TV (timst.top) ---');

    let catalog;
    try {
        catalog = await fetchAllowlistedChannels();
    } catch (error) {
        console.error(`TimStreams catalog fetch failed: ${error.message}`);
        return [];
    }

    if (catalog.length === 0) {
        console.log('No allowlisted TimStreams channels found in catalog.');
        return [];
    }

    console.log(`Found ${catalog.length} allowlisted channels. Resolving signed HLS…`);

    const concurrency = Math.min(getEmbedConcurrency(), 3);
    const dateAdded = new Date().toISOString();
    let reusedCount = 0;

    const results = await mapPool(catalog, concurrency, async (channel) => {
        if (!isBrowserConnected(browser)) return null;

        const id = `timst-${channel.url}`;
        const embedUrls = [{ url: channel.shortUrl, sourceName: 'TimStreams' }];

        const previousItem = previousById.get(id);
        if (shouldReuseStreams(previousItem, embedUrls, { currentTitle: channel.name })) {
            const reused = reuseStreamsFromFeedItem(previousItem);
            if (reused?.length) {
                reusedCount += 1;
                console.log(`↻ Reusing TimStreams stream for: ${channel.name}`);
                return {
                    id,
                    name: channel.name,
                    teams: [channel.name, ''],
                    time: '24/7',
                    shortDescription: 'TimStreams live TV',
                    releaseDate: new Date().toISOString(),
                    dateAdded,
                    league: 'Other',
                    poster: channel.logo,
                    streamLinks: reused,
                };
            }
        }

        const resolved = await resolveGrandeMxSignedUrl(browser, channel.shortUrl, channel.name);
        if (!resolved) return null;

        return {
            id,
            name: channel.name,
            teams: [channel.name, ''],
            time: '24/7',
            shortDescription: 'TimStreams live TV',
            releaseDate: new Date().toISOString(),
            dateAdded,
            league: 'Other',
            poster: channel.logo,
            streamLinks: [
                {
                    name: resolved.sourceName,
                    url: resolved.streamUrl,
                    headers: { Referer: resolved.referer },
                    requestHeaders: {},
                    embedUrl: resolved.embedUrl,
                    directFetchOk: Boolean(resolved.directFetchOk),
                    confirmedAt: resolved.confirmedAt,
                },
            ],
        };
    }, { shouldStop: () => !isBrowserConnected(browser) });

    const channels = results.filter(Boolean);
    console.log(
        `✅ TimStreams: ${channels.length}/${catalog.length} channels ready` +
            (reusedCount ? ` (${reusedCount} reused)` : '')
    );
    return channels;
}
