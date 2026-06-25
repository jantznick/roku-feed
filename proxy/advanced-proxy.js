import express from 'express';
import http from 'http';
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

const app = express();
const port = process.env.PORT || 8787;
const proxyHost = process.env.PROXY_HOST || '192.168.1.50:8787';
const debug = process.env.PROXY_DEBUG === 'true';

const PROXY_VERSION = 'embed-first-v14';

// GOAT disguises each MPEG-TS segment as a tiny PNG so it can live on TikTok's
// image CDN. The real TS payload starts right after the PNG's IEND chunk. Strip
// the PNG wrapper so players (VLC, Roku) get clean MPEG-TS they can decode.
const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');

function unwrapGoatSegment(body) {
    if (!Buffer.isBuffer(body) || body.length < 8) {
        return body;
    }
    if (!body.subarray(0, 8).equals(PNG_SIGNATURE)) {
        return body;
    }
    const iendIndex = body.indexOf('IEND');
    if (iendIndex === -1) {
        return body;
    }
    const tsStart = iendIndex + 4 + 4; // "IEND" (4) + CRC (4)
    const payload = body.subarray(tsStart);
    console.log(`  - Unwrapped GOAT PNG segment: ${body.length} -> ${payload.length} bytes`);
    return payload;
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
console.log('  - First manifest hit per embed: Puppeteer opens embed page and captures fresh m3u8');
console.log('  - Feed payload u/r/h are hints only; proxy resolves live from embed (e)');

app.get('/', (req, res) => {
    res.send('Proxy server is running (embed-first stream resolve)');
});

function isManifestUrl(url) {
    return url.endsWith('.m3u8') || url.includes('.m3u8?');
}

function buildRewrittenPayload(url, referer, extraHeaders, embedUrl, directOk) {
    return encodeProxyPayload(url, referer, extraHeaders, embedUrl, directOk);
}

async function fetchUpstream(streamUrl, { embedUrl, referer, extraHeaders, directOk }, isManifestRequest) {
    const browserOptions = { embedUrl, referer, extraHeaders };

    if (directOk) {
        console.log('  - Fetch mode: direct HTTP (d=1)');
        const httpResponse = await fetchViaHttp(streamUrl, referer, extraHeaders, isManifestRequest);
        if (httpResponse.statusCode >= 200 && httpResponse.statusCode < 300) {
            return { response: httpResponse, mode: 'http' };
        }
        console.log(`  - Direct HTTP returned ${httpResponse.statusCode}, falling back to Chromium...`);
    } else {
        console.log('  - Fetch mode: Chromium');
    }

    const browserResponse = await fetchViaBrowser(streamUrl, browserOptions, isManifestRequest);
    return { response: browserResponse, mode: 'chromium' };
}

async function resolvePlaybackContext(embedUrl, streamUrl, feedReferer, feedHeaders, feedDirectOk) {
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

    // Ensure the embed player is open/resolved (gives us referer + headers and
    // keeps the live manifest capture running). After that we always honor the
    // exact URL the client asked for: manifest bodies are served from the live
    // embed-player capture matched by filename (playlist.m3u8 vs mono.m3u8), and
    // segments are absolute CDN URLs. This preserves the embed's own URL
    // hierarchy so live reloads stay consistent instead of flip-flopping between
    // master and media playlists.
    let stream = getCachedStream(embedUrl);
    if (!stream) {
        stream = await getResolvedStream(embedUrl);
    }

    return {
        upstreamUrl: streamUrl,
        referer: stream.referer,
        extraHeaders: stream.requestHeaders,
        directOk: stream.directFetchOk,
        manifestBaseUrl: streamUrl,
        resolvedFromEmbed: false,
    };
}

// Format: /proxy/{BASE64_JSON_PAYLOAD} where payload is { u, r, h?, e?, d? }
app.get('/proxy/:b64Payload', async (req, res) => {
    const { b64Payload } = req.params;
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
        let ctx = await resolvePlaybackContext(embedUrl, streamUrl, referer, extraHeaders, directOk);

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
            },
            isManifestRequest
        ));

        if (response.statusCode >= 300 && isManifestRequest && embedUrl) {
            console.log(`  - Manifest fetch failed (${response.statusCode}), re-resolving from embed...`);
            clearResolvedStream(embedUrl);
            ctx = await resolvePlaybackContext(embedUrl, streamUrl, referer, extraHeaders, directOk);
            ({ response, mode } = await fetchUpstream(
                ctx.upstreamUrl,
                {
                    embedUrl,
                    referer: ctx.referer,
                    extraHeaders: ctx.extraHeaders,
                    directOk: ctx.directOk,
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
            res.status(response.statusCode).send(`Upstream returned ${response.statusCode}`);
            return;
        }

        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');

        if (isManifestRequest) {
            console.log('  - Rewriting manifest segment URLs...');

            const playlist = typeof response.body === 'string'
                ? response.body
                : response.body.toString('utf8');

            if (!playlist.includes('#EXTM3U')) {
                console.error(`  - ERROR: manifest body empty or invalid (${playlist.length} chars)`);
                res.status(502).send('Upstream manifest empty or invalid');
                return;
            }

            const KEY_TAG = '#EXT-X-KEY:';
            const rewrittenLines = [];
            let segmentCount = 0;
            for (const line of playlist.split('\n')) {
                if (line.startsWith(KEY_TAG)) {
                    const uriMatch = line.match(/URI="([^"]+)"/);
                    if (uriMatch?.[1]) {
                        const fullKeyUrl = new URL(uriMatch[1], ctx.manifestBaseUrl).href;
                        const proxiedKeyUrl = `http://${proxyHost}/proxy/${buildRewrittenPayload(
                            fullKeyUrl,
                            ctx.referer,
                            ctx.extraHeaders,
                            embedUrl,
                            ctx.directOk
                        )}`;
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
                    const segmentUrl = new URL(trimmed, ctx.manifestBaseUrl).href;
                    rewrittenLines.push(`http://${proxyHost}/proxy/${buildRewrittenPayload(
                        segmentUrl,
                        ctx.referer,
                        ctx.extraHeaders,
                        embedUrl,
                        ctx.directOk
                    )}`);
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

            console.log(`  - Rewrote ${segmentCount} segment URL(s)`);
            const rewrittenPlaylist = rewrittenLines.join('\n');

            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            logManifestPreview('Sending manifest to client', rewrittenPlaylist);
            res.send(rewrittenPlaylist);
        } else {
            const segmentBody = unwrapGoatSegment(response.body);
            console.log('  - Piping segment to client...');
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
