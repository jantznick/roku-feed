import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeProxyPayload, encodeProxyPayload } from './proxy-payload.js';

const DEFAULT_TTL_MS = 15 * 60 * 1000;

/**
 * TTL for reusing previously resolved stream URLs.
 * Reads STREAM_REUSE_TTL_MS, or STREAM_REUSE_TTL_MINUTES (converted to ms).
 * Default 15 minutes. 0 disables reuse (always rescrape).
 * @returns {number}
 */
export function getStreamReuseTtlMs() {
    const msRaw = process.env.STREAM_REUSE_TTL_MS;
    if (msRaw != null && String(msRaw).trim() !== '') {
        const ms = Number(msRaw);
        if (Number.isFinite(ms) && ms >= 0) {
            return ms;
        }
    }

    const minutesRaw = process.env.STREAM_REUSE_TTL_MINUTES;
    if (minutesRaw != null && String(minutesRaw).trim() !== '') {
        const minutes = Number(minutesRaw);
        if (Number.isFinite(minutes) && minutes >= 0) {
            return minutes * 60 * 1000;
        }
    }

    return DEFAULT_TTL_MS;
}

/**
 * Normalize one embed/stream entry into { embedUrl, name }.
 * Accepts strings, streamLinks ({ embedUrl, name }), or API embeds ({ url, sourceName }).
 * @param {string | { embedUrl?: string, url?: string, name?: string, sourceName?: string }} item
 * @returns {{ embedUrl: string, name: string }}
 */
function normalizeEmbedEntry(item) {
    if (typeof item === 'string') {
        return { embedUrl: item, name: '' };
    }
    if (!item || typeof item !== 'object') {
        return { embedUrl: '', name: '' };
    }
    return {
        // Prefer explicit embedUrl; fall back to url for API embed objects.
        embedUrl: item.embedUrl || item.url || '',
        name: item.name || item.sourceName || '',
    };
}

/**
 * Stable fingerprint from embed URLs (and optional source name).
 * Use this instead of rotating m3u8 URLs for "same sources?" checks.
 * @param {Array<string | object>} streamLinksOrEmbedUrls
 * @returns {string}
 */
export function getEmbedSignature(streamLinksOrEmbedUrls) {
    if (!Array.isArray(streamLinksOrEmbedUrls) || streamLinksOrEmbedUrls.length === 0) {
        return '';
    }

    return streamLinksOrEmbedUrls
        .map(normalizeEmbedEntry)
        .filter((entry) => entry.embedUrl)
        .map((entry) => (entry.name ? `${entry.name}@${entry.embedUrl}` : entry.embedUrl))
        .sort()
        .join('|');
}

/**
 * Parse source name from a feed quality string like `admin (lb16.strmd.st)`.
 * @param {string | undefined} quality
 * @returns {string}
 */
function parseNameFromQuality(quality) {
    if (!quality || typeof quality !== 'string') {
        return 'Stream';
    }
    const match = quality.match(/^(.+?)\s+\([^)]+\)\s*$/);
    if (match) {
        return match[1].trim() || quality;
    }
    return quality;
}

/**
 * Decode a proxied feed video URL via /proxy/:payload when present.
 * Payload is standard base64 and may contain `/`, so do not stop the match at the first slash.
 * @param {string} feedUrl
 * @returns {{ url: string, referer: string, extraHeaders: Record<string, string>, embedUrl: string | null, directOk: boolean } | null}
 */
function decodeProxiedFeedUrl(feedUrl) {
    if (!feedUrl || typeof feedUrl !== 'string') {
        return null;
    }
    const marker = '/proxy/';
    const idx = feedUrl.indexOf(marker);
    if (idx === -1) {
        return null;
    }
    let b64 = feedUrl.slice(idx + marker.length);
    const q = b64.search(/[?#]/);
    if (q !== -1) {
        b64 = b64.slice(0, q);
    }
    if (!b64) {
        return null;
    }
    try {
        return decodeProxyPayload(b64);
    } catch {
        return null;
    }
}

/**
 * Rebuild reusable streamLinks from a previous feed item's videos[].
 * Prefers decoding proxy payloads (u/r/e/d/h); otherwise treats video.url as direct m3u8.
 * @param {object} previousItem
 * @returns {Array<{ name: string, url: string, headers: { Referer: string }, requestHeaders: object, embedUrl: string | null, directFetchOk: boolean, confirmedAt: string | undefined }>}
 */
export function extractStreamLinksFromFeedItem(previousItem) {
    const videos = previousItem?.content?.videos;
    if (!Array.isArray(videos) || videos.length === 0) {
        return [];
    }

    const streamLinks = [];

    for (const video of videos) {
        if (!video?.url) {
            continue;
        }

        const decoded = decodeProxiedFeedUrl(video.url);
        const name = parseNameFromQuality(video.quality);

        if (decoded?.url) {
            streamLinks.push({
                name,
                url: decoded.url,
                headers: { Referer: decoded.referer },
                requestHeaders: decoded.extraHeaders || {},
                embedUrl: decoded.embedUrl || null,
                directFetchOk: Boolean(decoded.directOk),
                confirmedAt: video.confirmedAt,
            });
            continue;
        }

        // Direct m3u8 (SKIP_PROXY or non-proxied feed URL).
        streamLinks.push({
            name,
            url: video.url,
            headers: { Referer: '' },
            requestHeaders: {},
            embedUrl: null,
            directFetchOk: false,
            confirmedAt: video.confirmedAt,
        });
    }

    return streamLinks;
}

/**
 * True when every video on previousItem has confirmedAt within ttlMs.
 * Missing confirmedAt, empty videos, or ttlMs === 0 → stale (false).
 * @param {object} previousItem
 * @param {{ now?: number, ttlMs?: number }} [options]
 * @returns {boolean}
 */
export function isStreamCacheFresh(previousItem, { now = Date.now(), ttlMs = getStreamReuseTtlMs() } = {}) {
    if (ttlMs === 0) {
        return false;
    }

    const videos = previousItem?.content?.videos;
    if (!Array.isArray(videos) || videos.length === 0) {
        return false;
    }

    return videos.every((video) => {
        if (!video?.confirmedAt) {
            return false;
        }
        const confirmedMs = Date.parse(video.confirmedAt);
        if (!Number.isFinite(confirmedMs)) {
            return false;
        }
        return now - confirmedMs <= ttlMs;
    });
}

/**
 * Collect unique embed URLs from streamLinks / API embed objects / strings.
 * @param {Array<string | object>} items
 * @returns {Set<string>}
 */
export function collectEmbedUrls(items) {
    const urls = new Set();
    if (!Array.isArray(items)) {
        return urls;
    }
    for (const item of items) {
        const { embedUrl } = normalizeEmbedEntry(item);
        if (embedUrl) {
            urls.add(embedUrl);
        }
    }
    return urls;
}

/**
 * Whether the scraper can skip embed→m3u8 resolve and reuse previous streams.
 *
 * Reuse when the cache is fresh and every previously resolved embed is still
 * listed by the live API. Exact signature equality is too strict: a prior run
 * may have kept only the first 5 successful embeds while the API still lists more.
 *
 * @param {object | null | undefined} previousItem
 * @param {Array<string | object>} currentEmbedUrls - strings or { url, sourceName } / streamLinks
 * @param {{ now?: number, ttlMs?: number, currentTitle?: string }} [options]
 * @returns {boolean}
 */
export function shouldReuseStreams(previousItem, currentEmbedUrls, options = {}) {
    if (!previousItem) {
        return false;
    }

    if (options.currentTitle != null && previousItem.title !== options.currentTitle) {
        return false;
    }

    if (!isStreamCacheFresh(previousItem, { now: options.now, ttlMs: options.ttlMs })) {
        return false;
    }

    const previousLinks = extractStreamLinksFromFeedItem(previousItem);
    const previousEmbeds = collectEmbedUrls(previousLinks);
    const currentEmbeds = collectEmbedUrls(currentEmbedUrls || []);

    // Need recoverable embed identity on the previous item (proxy payload `e` or similar).
    if (previousEmbeds.size === 0 || currentEmbeds.size === 0) {
        return false;
    }

    for (const embedUrl of previousEmbeds) {
        if (!currentEmbeds.has(embedUrl)) {
            return false;
        }
    }

    return true;
}

/**
 * Return reusable streamLinks from a previous feed item, or null if none.
 * @param {object} previousItem
 * @returns {Array | null}
 */
export function reuseStreamsFromFeedItem(previousItem) {
    const streamLinks = extractStreamLinksFromFeedItem(previousItem);
    return streamLinks.length > 0 ? streamLinks : null;
}

// ---------------------------------------------------------------------------
// Self-check — run with: node src/stream-reuse.js
// ---------------------------------------------------------------------------
const isDirectRun =
    Boolean(process.argv[1]) &&
    path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

if (isDirectRun) {
    const embedA = 'https://embed.st/embed/admin/game/1';
    const embedB = 'https://embed.st/embed/admin/game/2';
    const m3u8 = 'https://cdn.example/stream/playlist.m3u8?token=abc';
    const payload = encodeProxyPayload(m3u8, 'https://embed.st/', {}, embedA, true);
    const proxyUrl = `http://192.168.1.8:8787/proxy/${payload}`;
    const now = Date.now();
    const confirmedAt = new Date(now - 60_000).toISOString();

    const previousItem = {
        id: 'test-game-2026-06-25',
        title: 'Team A vs Team B',
        embedSignature: getEmbedSignature([{ embedUrl: embedA, name: 'admin' }]),
        content: {
            videos: [
                {
                    url: proxyUrl,
                    quality: 'admin (cdn.example)',
                    videoType: 'HLS',
                    confirmedAt,
                },
            ],
        },
    };

    const links = extractStreamLinksFromFeedItem(previousItem);
    assert.equal(links.length, 1);
    assert.equal(links[0].url, m3u8);
    assert.equal(links[0].embedUrl, embedA);
    assert.equal(links[0].directFetchOk, true);
    assert.equal(links[0].name, 'admin');

    assert.equal(isStreamCacheFresh(previousItem, { now, ttlMs: 15 * 60 * 1000 }), true);
    assert.equal(isStreamCacheFresh(previousItem, { now, ttlMs: 0 }), false);
    assert.equal(
        isStreamCacheFresh(previousItem, { now: now + 20 * 60 * 1000, ttlMs: 15 * 60 * 1000 }),
        false
    );

    // Previous embed still listed (plus an extra) → reuse
    assert.equal(
        shouldReuseStreams(
            previousItem,
            [
                { url: embedA, sourceName: 'admin' },
                { url: embedB, sourceName: 'admin' },
            ],
            { now, currentTitle: 'Team A vs Team B' }
        ),
        true
    );

    // Previous embed gone from API → do not reuse
    assert.equal(
        shouldReuseStreams(
            previousItem,
            [{ url: embedB, sourceName: 'admin' }],
            { now, currentTitle: 'Team A vs Team B' }
        ),
        false
    );

    assert.ok(reuseStreamsFromFeedItem(previousItem));
    console.log('stream-reuse self-check: ok');
}
