import express from 'express';
import fs from 'fs';
import http from 'http';
import path from 'path';
import zlib from 'zlib';
import {
    decodeProxyPayload,
    encodeProxyPayload,
    isHlsMediaUri,
} from '../src/proxy-payload.js';
import { fetchViaBrowser } from './browser-fetch.js';
import { fetchViaHttp } from './http-fetch.js';
import {
    clearResolvedStream,
    getCachedStream,
    getResolvedStream,
} from './stream-session.js';
import {
    ensureRemuxSession,
    getRemuxRoot,
    shutdownAudioRemux,
    touchRemuxSession,
} from './audio-remux.js';

const app = express();
const port = process.env.PORT || 8787;
const proxyHost = process.env.PROXY_HOST || '192.168.1.50:8787';
const debug = process.env.PROXY_DEBUG === 'true';

const PROXY_VERSION = 'embed-first-v35-roku-paths';

function isLoopbackClient(req) {
    const ip = String(req.ip || req.socket?.remoteAddress || '');
    return ip === '127.0.0.1' || ip === '::1' || ip.endsWith('127.0.0.1');
}

/** Roku uses PROXY_HOST; ffmpeg remux inside the container must use 127.0.0.1. */
function rewriteProxyHost(req) {
    if (isLoopbackClient(req)) {
        return `127.0.0.1:${port}`;
    }
    return proxyHost;
}

/** Path after the quality root (/1/high/mono.m3u8 → high/mono.m3u8). */
function qualityPathSuffix(pathname) {
    const match = String(pathname || '').match(/\/\d+\/(.+)$/);
    return match ? match[1] : '';
}

/**
 * Map a stale feed/CDN URL onto the live token/host from embed resolve.
 * fresh master: .../TOKEN/1/playlist.m3u8
 * request:      .../OLD/1/high/mono.m3u8
 * result:       .../TOKEN/1/high/mono.m3u8
 */
function rebaseOntoFreshMaster(requestUrl, freshMasterUrl) {
    try {
        const req = new URL(requestUrl);
        const fresh = new URL(freshMasterUrl);
        const suffix = qualityPathSuffix(req.pathname);
        const freshRoot = fresh.pathname.match(/^(.*\/\d+)\//);
        if (!suffix || !freshRoot) {
            return null;
        }
        // Entry / master itself → keep the resolved master URL.
        if (suffix === 'playlist.m3u8' || suffix.endsWith('/playlist.m3u8')) {
            return fresh.href;
        }
        fresh.pathname = `${freshRoot[1]}/${suffix}`;
        fresh.search = '';
        return fresh.href;
    } catch {
        return null;
    }
}

function masterVariantSuffixes(masterBody) {
    const suffixes = new Set();
    for (const line of String(masterBody || '').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) {
            continue;
        }
        suffixes.add(trimmed.replace(/^\.\//, ''));
    }
    return suffixes;
}

// GOAT disguises each MPEG-TS segment as a PNG/WebP so it can live on TikTok's
// image CDN. Classic Streamed GOAT appended TS after PNG IEND. Newer Daddy /
// tiktokx objects are full PNGs with the TS payload embedded — trailing-after-
// IEND is empty (logs showed "4239018 -> 0 bytes"), so we also scan for a
// sustained MPEG-TS sync run. Never return an empty buffer to Roku.
const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');
const RIFF_MAGIC = Buffer.from('RIFF');
const WEBP_MAGIC = Buffer.from('WEBP');
const MPEG_TS_PACKET_SIZE = 188;
const MPEG_TS_SYNC = 0x47;

/**
 * Find the longest sustained MPEG-TS sync run (0x47 every 188 bytes).
 * @returns {Buffer|null}
 */
function findMpegTsPayload(body, { minPackets = 6, searchLimit = Infinity } = {}) {
    if (!Buffer.isBuffer(body) || body.length < MPEG_TS_PACKET_SIZE * minPackets) {
        return null;
    }
    const limit = Math.min(body.length, searchLimit);
    let best = null;
    for (let i = 0; i < limit; i++) {
        if (body[i] !== MPEG_TS_SYNC) {
            continue;
        }
        let packets = 0;
        let offset = i;
        while (
            offset + MPEG_TS_PACKET_SIZE <= body.length &&
            body[offset] === MPEG_TS_SYNC
        ) {
            packets++;
            offset += MPEG_TS_PACKET_SIZE;
        }
        if (packets >= minPackets && (!best || packets > best.packets)) {
            best = { start: i, packets };
        }
        if (packets > 0) {
            i = offset - 1;
        }
    }
    if (!best) {
        return null;
    }
    return body.subarray(
        best.start,
        best.start + best.packets * MPEG_TS_PACKET_SIZE
    );
}

/** Concatenate PNG IDAT chunk payloads and inflate — Daddy/tiktokx may hide TS there. */
function inflatePngIdat(body) {
    if (!Buffer.isBuffer(body) || body.length < 24 || !body.subarray(0, 8).equals(PNG_SIGNATURE)) {
        return null;
    }
    const idatParts = [];
    let offset = 8;
    while (offset + 8 <= body.length) {
        const length = body.readUInt32BE(offset);
        const type = body.subarray(offset + 4, offset + 8).toString('ascii');
        const dataStart = offset + 8;
        const dataEnd = dataStart + length;
        if (dataEnd + 4 > body.length) {
            break;
        }
        if (type === 'IDAT') {
            idatParts.push(body.subarray(dataStart, dataEnd));
        }
        if (type === 'IEND') {
            break;
        }
        offset = dataEnd + 4; // skip CRC
    }
    if (idatParts.length === 0) {
        return null;
    }
    try {
        return zlib.inflateSync(Buffer.concat(idatParts));
    } catch {
        try {
            return zlib.inflateRawSync(Buffer.concat(idatParts));
        } catch {
            return null;
        }
    }
}

function unwrapGoatSegment(body) {
    if (!Buffer.isBuffer(body) || body.length < 8) {
        return body;
    }
    if (!body.subarray(0, 8).equals(PNG_SIGNATURE)) {
        return body;
    }

    // Classic GOAT: tiny PNG header, real TS immediately after IEND+CRC.
    const iendIndex = body.indexOf('IEND');
    if (iendIndex !== -1) {
        const tsStart = iendIndex + 4 + 4; // "IEND" (4) + CRC (4)
        if (tsStart < body.length) {
            const trailing = body.subarray(tsStart);
            const trailingTs = findMpegTsPayload(trailing, { minPackets: 3 });
            if (trailingTs) {
                console.log(
                    `  - Unwrapped GOAT PNG segment: ${body.length} -> ${trailingTs.length} bytes`
                );
                return trailingTs;
            }
        }
    }

    // Raw scan (TS appended/embedded uncompressed).
    const scanned = findMpegTsPayload(body, { minPackets: 6 });
    if (scanned) {
        console.log(
            `  - Unwrapped GOAT PNG via TS sync scan: ${body.length} -> ${scanned.length} bytes`
        );
        return scanned;
    }

    // Daddy tiktokx: full PNG with MPEG-TS inside zlib-compressed IDAT.
    const inflated = inflatePngIdat(body);
    if (inflated) {
        const fromIdat = findMpegTsPayload(inflated, { minPackets: 6 });
        if (fromIdat) {
            console.log(
                `  - Unwrapped GOAT PNG via inflated IDAT: ${body.length} -> ${fromIdat.length} bytes`
            );
            return fromIdat;
        }
    }

    console.log(
        `  - PNG segment had no MPEG-TS payload; passing through (${body.length} bytes)`
    );
    return body;
}

/**
 * TimStreams / junksonus segments arrive as a fake WebP (RIFF…WEBP) whose payload
 * is raw MPEG-TS. Find a sustained 0x47 sync run (188-byte packets) and return it.
 * Does not modify PNG GOAT handling — call after unwrapGoatSegment when unchanged.
 */
function unwrapWebpTsSegment(body) {
    if (!Buffer.isBuffer(body) || body.length < 16) {
        return body;
    }
    if (!body.subarray(0, 4).equals(RIFF_MAGIC) || !body.subarray(8, 12).equals(WEBP_MAGIC)) {
        return body;
    }

    const scanned = findMpegTsPayload(body, {
        minPackets: 3,
        searchLimit: Math.min(body.length, 64 * 1024),
    });
    if (scanned) {
        console.log(
            `  - Unwrapped WebP-TS segment: ${body.length} -> ${scanned.length} bytes`
        );
        return scanned;
    }

    console.log('  - WebP segment had no sustained MPEG-TS sync run; passing through');
    return body;
}

/** PNG GOAT first (Streamed/Daddy), then WebP-TS (TimStreams); otherwise passthrough. */
function unwrapDisguisedSegment(body) {
    const afterPng = unwrapGoatSegment(body);
    if (afterPng !== body) {
        return afterPng;
    }
    return unwrapWebpTsSegment(body);
}

/**
 * Express 5 named wildcard (`*b64Payload`) may return a string or path-segment array.
 * Standard base64 payloads can contain `/`, so re-join segments.
 * Remux/ffmpeg may append .ts/.m3u8 so the HLS demuxer accepts proxied URLs —
 * strip those fake extensions before base64 decode.
 */
function extractB64Payload(param) {
    let raw = '';
    if (Array.isArray(param)) {
        raw = param.join('/');
    } else if (typeof param === 'string') {
        raw = param.replace(/^\//, '');
    }
    return raw.replace(/\.(ts|m3u8|m4s|aac|mp4)$/i, '');
}

function previewBody(body, maxLines = 6) {
    const text = typeof body === 'string' ? body : body.toString('utf8');
    const lines = text.split('\n').filter((line) => line.trim().length > 0).slice(0, maxLines);
    return { text, lines, totalChars: text.length, totalLines: text.split('\n').length };
}

function logManifestPreview(label, body) {
    const { lines, totalChars, totalLines } = previewBody(body);
    console.log(`  - ${label}: ${totalChars} chars, ${totalLines} lines`);
    for (const line of lines) {
        console.log(`      ${line}`);
    }
    if (totalLines > lines.length) {
        console.log(`      ... (${totalLines - lines.length} more lines)`);
    }
}

console.log(`Starting ADVANCED HLS proxy (${PROXY_VERSION})...`);
console.log(`  - Chromium mode: ${process.env.PROXY_HEADLESS === 'true' ? 'headless' : 'visible (set PROXY_HEADLESS=true for headless)'}`);
console.log(`  - Rewriting segment URLs to host: ${proxyHost}`);
console.log('  - /proxy d=1: HTTP first (TimStreams); Chromium fallback; WebP/PNG unwrap');
console.log('  - /proxy else: embed-first Chromium (Streamed / Daddy); live playlist + unwrap');
console.log('  - /remux/{payload}: optional ffmpeg AAC-LC (feed uses /proxy)');

app.get('/', (req, res) => {
    res.send('Proxy server is running (embed-first stream resolve)');
});

// Remux live HLS (HE-AAC → AAC-LC). Same payload as /proxy/{b64}.
// Serve the playlist inline (absolute segment URLs) — Roku HLS is flaky on 302.
app.get('/remux/*b64Payload', async (req, res) => {
    const b64Payload = extractB64Payload(req.params.b64Payload);
    if (!b64Payload) {
        res.status(400).send('Missing remux payload');
        return;
    }
    console.log(`---\n[${new Date().toISOString()}] Remux request`);
    console.log(`  - Payload length: ${b64Payload.length}`);
    try {
        const session = await ensureRemuxSession(b64Payload);
        const playlistPath = path.join(session.dir, 'index.m3u8');
        const playlist = fs.readFileSync(playlistPath, 'utf8');
        const base = `http://${proxyHost}/remux-live/${session.id}/`;
        const rewritten = playlist.split('\n').map((line) => {
            const trimmed = line.trim();
            if (trimmed.length > 0 && !trimmed.startsWith('#') && !/^https?:\/\//i.test(trimmed)) {
                return base + trimmed.replace(/^\.\//, '');
            }
            return line;
        }).join('\n');
        console.log(`  - Serving remux playlist (${session.id})`);
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.send(rewritten);
    } catch (error) {
        console.error(`  - Remux failed: ${error.message}`);
        if (!res.headersSent) {
            res.status(502).send(`Remux failed: ${error.message}`);
        }
    }
});

app.use('/remux-live', (req, res, next) => {
    const id = String(req.path || '').split('/').filter(Boolean)[0] || '';
    if (id) {
        touchRemuxSession(id);
    }
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    next();
}, express.static(getRemuxRoot()));

function isManifestUrl(url) {
    return url.endsWith('.m3u8') || url.includes('.m3u8?');
}

/** Matchora / Streamed GOAT segments live on TikTok image CDN; Node fetch often throws. */
function isDisguisedCdnSegment(url) {
    return /tiktokcdn\.|ttam-origin\.image|\.image\?/i.test(String(url || ''));
}

function buildRewrittenPayload(url, referer, extraHeaders, embedUrl, directOk) {
    return encodeProxyPayload(url, referer, extraHeaders, embedUrl, directOk);
}

async function fetchUpstream(
    streamUrl,
    { embedUrl, referer, extraHeaders, directOk, skipChromiumFallback = false },
    isManifestRequest
) {
    const browserOptions = { embedUrl, referer, extraHeaders };

    // GOAT TikTok .image segments: skip doomed Node fetch when we have an embed tab.
    if (
        directOk &&
        !isManifestRequest &&
        embedUrl &&
        isDisguisedCdnSegment(streamUrl)
    ) {
        console.log('  - Fetch mode: Chromium (disguised CDN segment; skip d=1 HTTP)');
        const browserResponse = await fetchViaBrowser(
            streamUrl,
            browserOptions,
            isManifestRequest
        );
        return { response: browserResponse, mode: 'chromium' };
    }

    if (directOk) {
        // Manifests usually work with minimal HTTP. TikTok / GOAT segment URLs often
        // 403 — or throw "fetch failed" (DNS/TLS/reset) — from the proxy host.
        // Fall back to the open embed tab (cookies/UA) then unwrap. Previously only
        // HTTP status failures fell back, so network throws aborted the Roku play.
        console.log('  - Fetch mode: direct HTTP (d=1, minimal headers)');
        let httpResponse = null;
        let httpError = null;
        try {
            httpResponse = await fetchViaHttp(
                streamUrl,
                referer,
                extraHeaders,
                isManifestRequest,
                { minimal: true }
            );
        } catch (err) {
            httpError = err;
            console.log(`  - Direct HTTP threw: ${err.message}`);
        }

        if (httpResponse && httpResponse.statusCode >= 200 && httpResponse.statusCode < 300) {
            return { response: httpResponse, mode: 'http' };
        }

        // Dead signed manifests (410/404/403): Chromium page.goto of the same URL
        // is useless and thrashs the shared browser while other plays resolve.
        // Return the HTTP failure so the caller can forceEmbed-resolve instead.
        if (
            isManifestRequest &&
            httpResponse &&
            (httpResponse.statusCode === 410
                || httpResponse.statusCode === 404
                || httpResponse.statusCode === 403)
        ) {
            console.log(
                `  - Direct HTTP ${httpResponse.statusCode} (dead signed URL); ` +
                    'skipping Chromium of the same URL'
            );
            return { response: httpResponse, mode: 'http' };
        }

        if (embedUrl && !skipChromiumFallback) {
            const reason = httpError
                ? `threw (${httpError.message})`
                : `status ${httpResponse.statusCode}`;
            console.log(
                `  - Direct HTTP ${reason}; falling back to Chromium` +
                    `${isManifestRequest ? ' for manifest' : ' for segment'}`
            );
            const browserResponse = await fetchViaBrowser(
                streamUrl,
                browserOptions,
                isManifestRequest
            );
            return { response: browserResponse, mode: 'chromium' };
        }

        if (skipChromiumFallback) {
            console.log('  - Skipping Chromium fallback (embed resolve already failed)');
        }

        if (httpError) {
            throw httpError;
        }
        return { response: httpResponse, mode: 'http' };
    }

    console.log('  - Fetch mode: Chromium');
    const browserResponse = await fetchViaBrowser(streamUrl, browserOptions, isManifestRequest);
    return { response: browserResponse, mode: 'chromium' };
}

async function resolvePlaybackContext(
    embedUrl,
    streamUrl,
    feedReferer,
    feedHeaders,
    feedDirectOk,
    { isManifest = false, forceEmbed = false } = {}
) {
    if (!embedUrl) {
        return {
            upstreamUrl: streamUrl,
            referer: feedReferer,
            extraHeaders: feedHeaders,
            directOk: feedDirectOk,
            manifestBaseUrl: streamUrl,
            resolvedFromEmbed: false,
        };
    }

    // d=1 (TimStreams / some Streamed): always resolve from the embed at play
    // time. Feed tokens expire (410); the embed `e` field is source of truth.
    if (feedDirectOk) {
        let stream = getCachedStream(embedUrl);
        if (!stream || forceEmbed) {
            console.log(
                forceEmbed
                    ? '  - d=1: re-resolving embed after failed manifest'
                    : '  - d=1: awaiting embed for fresh signed m3u8'
            );
            try {
                stream = await getResolvedStream(embedUrl, { force: forceEmbed });
            } catch (err) {
                console.error(
                    `  - Embed resolve failed (${err.message}); feed URL HTTP only`
                );
                return {
                    upstreamUrl: streamUrl,
                    referer: feedReferer,
                    extraHeaders: feedHeaders,
                    directOk: true,
                    manifestBaseUrl: streamUrl,
                    resolvedFromEmbed: false,
                    skipChromiumFallback: true,
                };
            }
        }
        const freshUrl = stream.streamUrl || streamUrl;
        const useFresh = isManifest && Boolean(stream.streamUrl);
        return {
            upstreamUrl: useFresh ? freshUrl : streamUrl,
            referer: stream.referer || feedReferer,
            extraHeaders: {},
            directOk: true,
            manifestBaseUrl: useFresh ? freshUrl : streamUrl,
            resolvedFromEmbed: useFresh && stream.streamUrl !== streamUrl,
        };
    }

    // Streamed / Daddy / India embeds: keep the player open/resolved. Always
    // honor forceEmbed after a dead feed URL — previously only TimStreams did.
    let stream = getCachedStream(embedUrl);
    if (!stream || forceEmbed) {
        try {
            stream = await getResolvedStream(embedUrl, { force: forceEmbed });
        } catch (err) {
            console.error(
                `  - Embed resolve failed (${err.message}); feed URL HTTP only (no Chromium thrash)`
            );
            // directOk true + dead URL used to Chromium-navigate the 403 m3u8 and
            // starve other plays. HTTP-only fallback; caller returns upstream error.
            return {
                upstreamUrl: streamUrl,
                referer: feedReferer,
                extraHeaders: feedHeaders,
                directOk: true,
                manifestBaseUrl: streamUrl,
                resolvedFromEmbed: false,
                skipChromiumFallback: true,
            };
        }
    }

    let upstreamUrl = streamUrl;
    let manifestBaseUrl = streamUrl;
    let resolvedFromEmbed = false;

    if (isManifest && stream.streamUrl) {
        const masterBody = stream.manifestBody || '';
        const isMaster = masterBody.includes('#EXT-X-STREAM-INF');
        if (isMaster) {
            let reqSuffix = '';
            try {
                reqSuffix = qualityPathSuffix(new URL(streamUrl).pathname);
            } catch {
                reqSuffix = '';
            }
            const variants = masterVariantSuffixes(masterBody);
            if (!reqSuffix || reqSuffix === 'playlist.m3u8' || !variants.has(reqSuffix)) {
                upstreamUrl = stream.streamUrl;
                manifestBaseUrl = stream.streamUrl;
                resolvedFromEmbed = stream.streamUrl !== streamUrl;
                if (resolvedFromEmbed) {
                    console.log(`  - Streamed: serving live master (${stream.streamUrl.slice(0, 80)}...)`);
                }
            } else {
                const rebased = rebaseOntoFreshMaster(streamUrl, stream.streamUrl);
                if (rebased) {
                    upstreamUrl = rebased;
                    manifestBaseUrl = rebased;
                    resolvedFromEmbed = rebased !== streamUrl;
                    if (resolvedFromEmbed) {
                        console.log(`  - Streamed: rebased variant → ${rebased.slice(0, 100)}...`);
                    }
                }
            }
        } else if (stream.streamUrl !== streamUrl) {
            upstreamUrl = stream.streamUrl;
            manifestBaseUrl = stream.streamUrl;
            resolvedFromEmbed = true;
        }
    }

    return {
        upstreamUrl,
        referer: stream.referer,
        extraHeaders: stream.requestHeaders,
        directOk: stream.directFetchOk,
        manifestBaseUrl,
        resolvedFromEmbed,
    };
}

// Format: /proxy/{BASE64_JSON_PAYLOAD} where payload is { u, r, h?, e?, d? }
// Use a named wildcard so standard base64 `/` inside the payload is not truncated
// by Express's single-segment `:param` matcher (TimStreams TikTok segment rewrites).
app.get('/proxy/*b64Payload', async (req, res) => {
    const b64Payload = extractB64Payload(req.params.b64Payload);
    if (!b64Payload) {
        res.status(400).send('Missing proxy payload');
        return;
    }
    const { url: streamUrl, referer, extraHeaders, embedUrl, directOk } = decodeProxyPayload(b64Payload);
    const isManifestRequest = isManifestUrl(streamUrl);

    console.log(`---\n[${new Date().toISOString()}] New request`);
    console.log(`  - Client IP: ${req.ip}`);
    console.log(`  - Request URL (from feed/rewrite): ${streamUrl}`);
    console.log(`  - Request type: ${isManifestRequest ? 'manifest' : 'segment/key'}`);
    console.log(`  - Embed page (e): ${embedUrl || '(missing — re-scrape feed)'}`);

    if (!isManifestRequest && !isHlsMediaUri(streamUrl)) {
        console.log(`  - Rejecting non-HLS media URL (not a segment): ${streamUrl.slice(0, 100)}`);
        res.status(404).send('Not an HLS media URL');
        return;
    }

    try {
        let ctx = await resolvePlaybackContext(
            embedUrl,
            streamUrl,
            referer,
            extraHeaders,
            directOk,
            { isManifest: isManifestRequest }
        );

        if (ctx.resolvedFromEmbed) {
            console.log(`  - Ignoring feed m3u8; using fresh resolve: ${ctx.upstreamUrl}`);
        }

        let response;
        let mode;

        ({ response, mode } = await fetchUpstream(
            ctx.upstreamUrl,
            {
                embedUrl,
                referer: ctx.referer,
                extraHeaders: ctx.extraHeaders,
                directOk: ctx.directOk,
                skipChromiumFallback: ctx.skipChromiumFallback,
            },
            isManifestRequest
        ));

        if (response.statusCode >= 300 && isManifestRequest && embedUrl) {
            console.log(
                `  - Manifest fetch failed (${response.statusCode}), ` +
                    'awaiting fresh embed resolve...'
            );
            clearResolvedStream(embedUrl);
            ctx = await resolvePlaybackContext(
                embedUrl,
                streamUrl,
                referer,
                extraHeaders,
                directOk,
                { isManifest: true, forceEmbed: true }
            );
            if (ctx.resolvedFromEmbed) {
                console.log(`  - Fresh embed m3u8: ${ctx.upstreamUrl.slice(0, 100)}...`);
            }
            ({ response, mode } = await fetchUpstream(
                ctx.upstreamUrl,
                {
                    embedUrl,
                    referer: ctx.referer,
                    extraHeaders: ctx.extraHeaders,
                    directOk: ctx.directOk,
                    skipChromiumFallback: ctx.skipChromiumFallback,
                },
                isManifestRequest
            ));
        }

        console.log(`  - Received response with status ${response.statusCode} (${mode}).`);

        if (response.statusCode < 200 || response.statusCode >= 300) {
            const bodyPreview = typeof response.body === 'string'
                ? response.body.slice(0, 200)
                : '';
            console.error(`  - Upstream rejected the request (${response.statusCode}).`);
            if (debug && bodyPreview) {
                console.error(`  - Response preview: ${bodyPreview}`);
            }
            if (
                response.statusCode === 403 &&
                !isManifestRequest &&
                directOk &&
                embedUrl
            ) {
                console.log('  - Clearing d=1 embed cache after segment 403');
                clearResolvedStream(embedUrl);
            }
            res.status(response.statusCode).send(`Upstream returned ${response.statusCode}`);
            return;
        }

        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');

        if (isManifestRequest) {
            const playlist = typeof response.body === 'string'
                ? response.body
                : response.body.toString('utf8');

            if (!playlist.includes('#EXTM3U')) {
                console.error(`  - ERROR: manifest body empty or invalid (${playlist.length} chars)`);
                res.status(502).send('Upstream manifest empty or invalid');
                return;
            }

            const segmentHost = rewriteProxyHost(req);
            const loopback = isLoopbackClient(req);
            // Keep segment proxy URLs short:
            // - remux/ffmpeg (loopback): no headers + fake .ts suffix
            // - embed session present: omit cookies/headers from the URL — the
            //   open tab (and resolve cache) already carry them. Daddy was
            //   baking ~555B cookies into every segment URL (~1KB paths) and
            //   clients fetched the playlist but never requested segments.
            const rewriteHeaders = (loopback || embedUrl) ? {} : ctx.extraHeaders;
            const mediaSuffix = loopback ? '.ts' : '';
            console.log(
                `  - Rewriting manifest segment URLs through /proxy (${segmentHost}`
                + `${loopback ? ', remux-loopback+ts' : ''}`
                + `${embedUrl && !loopback ? ', slim-no-headers' : ''})...`
            );

            // Prefer the live capture URL (Daddy ?t= tokens) as rewrite base so
            // relative segment paths resolve against the playlist that produced them.
            let rewriteBase = response.sourceUrl || ctx.manifestBaseUrl || streamUrl;
            if (playlist.includes('#EXT-X-STREAM-INF') && embedUrl) {
                const cached = getCachedStream(embedUrl);
                if (cached?.streamUrl) {
                    rewriteBase = cached.streamUrl;
                    console.log(`  - Master rewrite base: ${rewriteBase.slice(0, 100)}...`);
                }
            }
            const seq = (playlist.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/) || [])[1] || '?';
            console.log(`  - Playlist MEDIA-SEQUENCE=${seq}`);

            const KEY_TAG = '#EXT-X-KEY:';
            const rewrittenLines = [];
            let segmentCount = 0;
            for (const line of playlist.split('\n')) {
                if (line.startsWith(KEY_TAG)) {
                    const uriMatch = line.match(/URI="([^"]+)"/);
                    if (uriMatch?.[1]) {
                        const fullKeyUrl = new URL(uriMatch[1], rewriteBase).href;
                        const proxiedKeyUrl = `http://${segmentHost}/proxy/${buildRewrittenPayload(
                            fullKeyUrl,
                            ctx.referer,
                            rewriteHeaders,
                            embedUrl,
                            ctx.directOk
                        )}${mediaSuffix}`;
                        rewrittenLines.push(line.replace(uriMatch[1], proxiedKeyUrl));
                        continue;
                    }
                }

                const trimmed = line.trim();
                if (trimmed.length > 0 && !trimmed.startsWith('#')) {
                    if (!isHlsMediaUri(trimmed)) {
                        console.log(`  - Skipping unrecognized line: ${trimmed.slice(0, 80)}`);
                        continue;
                    }
                    const segmentUrl = new URL(trimmed, rewriteBase).href;
                    rewrittenLines.push(`http://${segmentHost}/proxy/${buildRewrittenPayload(
                        segmentUrl,
                        ctx.referer,
                        rewriteHeaders,
                        embedUrl,
                        ctx.directOk
                    )}${mediaSuffix}`);
                    segmentCount++;
                    continue;
                }

                rewrittenLines.push(line);
            }

            if (segmentCount === 0) {
                console.error('  - ERROR: manifest has no segment URLs after rewrite');
                res.status(502).send('Manifest has no segments');
                return;
            }

            const rewrittenPlaylist = rewrittenLines.join('\n');
            const firstSeg = rewrittenLines.find((line) => {
                const t = line.trim();
                return t.length > 0 && !t.startsWith('#');
            });
            console.log(
                `  - Rewrote ${segmentCount} segment URL(s)` +
                    (firstSeg ? `; first len=${firstSeg.length}` : '')
            );

            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            logManifestPreview('Sending manifest to client', rewrittenPlaylist);
            res.send(rewrittenPlaylist);
        } else {
            const rawBody = Buffer.isBuffer(response.body)
                ? response.body
                : Buffer.from(response.body || '');
            const segmentBody = unwrapDisguisedSegment(rawBody);
            if (!segmentBody || segmentBody.length === 0) {
                console.error(
                    `  - ERROR: unwrapped segment empty (upstream ${rawBody.length} bytes)`
                );
                res.status(502).send('Unwrapped segment empty');
                return;
            }
            if (
                segmentBody.length === rawBody.length &&
                rawBody.subarray(0, 8).equals(PNG_SIGNATURE)
            ) {
                console.error(
                    `  - ERROR: PNG segment had no MPEG-TS payload (${rawBody.length} bytes)`
                );
                res.status(502).send('PNG segment had no MPEG-TS payload');
                return;
            }
            console.log(
                `  - Piping segment to client (${segmentBody.length} bytes)...`
            );
            res.setHeader('Content-Type', 'video/MP2T');
            res.send(segmentBody);
        }
    } catch (error) {
        console.error(`  - ERROR processing request:`, error.message);
        if (debug) {
            console.error(error);
        }
        if (!res.headersSent) {
            res.status(500).send(`Failed to proxy stream: ${error.message}`);
        }
    }
});

http.createServer(app).listen(port, () => {
    console.log(`Advanced HLS Proxy server listening at http://localhost:${port}`);
});

// SIGINT/SIGTERM cleanup (including remux ffmpeg) lives in browser-fetch.js.
