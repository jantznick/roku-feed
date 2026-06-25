import 'dotenv/config';
import fs from 'fs/promises';
import puppeteer from 'puppeteer';
import { getFinalStreamUrl } from './streamed-scraper.js';
import {
    buildFetchHeaders,
    buildProxyUrl,
    decodeProxyPayload,
} from './proxy-payload.js';

const FEED_META_KEYS = new Set(['providerName', 'lastUpdated', 'language', 'scriptDuration']);
const DEFAULT_FEED_PATH = 'dist/feed.json';

function printUsage() {
    console.log(`Usage:
  node src/test-stream.js --list [--from-feed dist/feed.json]
  node src/test-stream.js --from-feed dist/feed.json --index 0
  node src/test-stream.js --embed "https://embedsports.top/embed/..."

Options:
  --from-feed <path>   Feed JSON to read (default: dist/feed.json)
  --index <n>          Stream index from --list (default: 0)
  --list               List all streams in the feed with indices
  --embed <url>        Re-scrape an embed page with Puppeteer (full pipeline test)
  --skip-proxy         Only test direct upstream fetch, not the LAN proxy URL
  --help               Show this help

Examples:
  node src/test-stream.js --list
  node src/test-stream.js --from-feed dist/feed.json --index 2
  node src/test-stream.js --embed "https://embedsports.top/embed/admin/some-id/1"
`);
}

function parseArgs(argv) {
    const options = {
        feedPath: DEFAULT_FEED_PATH,
        index: 0,
        list: false,
        embedUrl: null,
        skipProxy: false,
        help: false,
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        switch (arg) {
            case '--help':
            case '-h':
                options.help = true;
                break;
            case '--list':
                options.list = true;
                break;
            case '--skip-proxy':
                options.skipProxy = true;
                break;
            case '--from-feed':
                options.feedPath = argv[++i];
                break;
            case '--index':
                options.index = Number.parseInt(argv[++i], 10);
                break;
            case '--embed':
                options.embedUrl = argv[++i];
                break;
            default:
                throw new Error(`Unknown argument: ${arg}`);
        }
    }

    return options;
}

async function loadFeed(feedPath) {
    const json = await fs.readFile(feedPath, 'utf8');
    return JSON.parse(json);
}

function collectFeedStreams(feed) {
    const streams = [];

    for (const [league, items] of Object.entries(feed)) {
        if (FEED_META_KEYS.has(league) || !Array.isArray(items)) {
            continue;
        }

        for (const item of items) {
            const videos = item.content?.videos || [];
            videos.forEach((video, videoIndex) => {
                streams.push({
                    league,
                    title: item.title,
                    quality: video.quality,
                    feedUrl: video.url,
                    videoIndex,
                    confirmedAt: video.confirmedAt,
                });
            });
        }
    }

    return streams;
}

function decodeFeedStreamUrl(feedUrl) {
    const proxyMatch = feedUrl.match(/\/proxy\/([^/?#]+)/);
    if (proxyMatch) {
        const decoded = decodeProxyPayload(proxyMatch[1]);
        return {
            ...decoded,
            isProxied: true,
            proxyUrl: feedUrl,
        };
    }

    return {
        url: feedUrl,
        referer: null,
        extraHeaders: {},
        isProxied: false,
        proxyUrl: null,
    };
}

function printStreamList(streams) {
    console.log(`Found ${streams.length} stream(s):\n`);
    streams.forEach((stream, index) => {
        console.log(`[${index}] ${stream.league} — ${stream.title}`);
        console.log(`     ${stream.quality}`);
        console.log(`     confirmed: ${stream.confirmedAt || 'n/a'}`);
        console.log('');
    });
}

async function probeUrl(label, url, headers, timeoutMs = 120000) {
    console.log(`\n--- ${label} ---`);
    console.log(`URL: ${url}`);
    if (label.includes('LAN proxy')) {
        console.log('(First play opens embed in Puppeteer — may take 30-90s before manifest returns)');
    }
    console.log('Headers:', headers);

    try {
        const response = await fetch(url, {
            method: 'GET',
            headers,
            redirect: 'follow',
            signal: AbortSignal.timeout(timeoutMs),
        });

        const contentType = response.headers.get('content-type') || '';
        const isTextResponse = contentType.includes('json')
            || contentType.includes('text')
            || contentType.includes('mpegurl')
            || url.includes('.m3u8')
            || url.includes('/proxy/');

        const bodyText = isTextResponse
            ? await response.text()
            : `(binary, ${response.headers.get('content-length') || 'unknown'} bytes)`;

        const preview = typeof bodyText === 'string' && bodyText.length > 300
            ? bodyText.slice(0, 300)
            : bodyText;

        console.log(`Status: ${response.status} ${response.statusText}`);
        console.log(`Content-Type: ${contentType || 'n/a'}`);
        if (preview) {
            console.log(`Body preview: ${preview}`);
        }

        const isLikelyManifest = url.includes('.m3u8') || url.includes('/proxy/') || contentType.includes('mpegurl');
        const isValidManifest = !isLikelyManifest || (typeof bodyText === 'string' && bodyText.includes('#EXTM3U'));
        return response.ok && isValidManifest;
    } catch (error) {
        if (error.name === 'TimeoutError') {
            console.error(`Request timed out after ${timeoutMs / 1000}s`);
        } else {
            console.error(`Request failed: ${error.message}`);
        }
        return false;
    }
}

async function testFeedStream(stream, { skipProxy }) {
    const decoded = decodeFeedStreamUrl(stream.feedUrl);

    console.log('--- Feed stream ---');
    console.log(`League: ${stream.league}`);
    console.log(`Title: ${stream.title}`);
    console.log(`Quality: ${stream.quality}`);
    console.log(`Confirmed at: ${stream.confirmedAt || 'n/a'}`);
    console.log(`Feed URL: ${stream.feedUrl}`);

    if (decoded.isProxied) {
        console.log('\nDecoded proxy payload (feed hints — proxy resolves fresh m3u8 from embed on play):');
        console.log(`  feed m3u8 (u): ${decoded.url}`);
        console.log(`  referer (r): ${decoded.referer}`);
        console.log(`  embed page (e): ${decoded.embedUrl || '(missing — re-scrape feed)'}`);
        console.log(`  direct HTTP hint (d): ${decoded.directOk ? '1' : '0'}`);
        console.log(`  extra headers: ${JSON.stringify(decoded.extraHeaders)}`);
    } else {
        console.log('\nDirect stream URL (not proxied in feed).');
    }

    const upstreamHeaders = buildFetchHeaders(
        decoded.referer || 'https://embedsports.top/',
        decoded.extraHeaders
    );
    const upstreamOk = await probeUrl('Direct upstream (what proxy should send)', decoded.url, upstreamHeaders);

    let proxyOk = null;
    if (!skipProxy && decoded.proxyUrl) {
        proxyOk = await probeUrl('LAN proxy URL from feed', decoded.proxyUrl, {
            Accept: '*/*',
        });
    }

    console.log('\n--- Summary ---');
    console.log(`Upstream: ${upstreamOk ? 'OK' : 'FAILED'}`);
    if (proxyOk !== null) {
        console.log(`Proxy: ${proxyOk ? 'OK' : 'FAILED'}`);
    }
    if (!upstreamOk) {
        console.log('\nNote: direct Node upstream often returns 403 for strmd CDNs — that is expected.');
        console.log('Only the LAN proxy result matters; it resolves fresh from the embed page (e).');
    }
}

async function testEmbedUrl(embedUrl) {
    const proxyHost = process.env.PROXY_SERVER || `http://${process.env.PROXY_HOST || '192.168.1.50:8787'}`;

    console.log('--- Embed scrape test ---');
    console.log(`URL: ${embedUrl}\n`);

    let browser;
    try {
        browser = await puppeteer.launch({ headless: true });
        const finalStreamInfo = await getFinalStreamUrl(browser, embedUrl);

        if (!finalStreamInfo) {
            console.log('❌ Failed. Could not retrieve final stream info.');
            return;
        }

        console.log('\n--- Scrape result ---');
        console.log('  Stream URL:', finalStreamInfo.streamUrl);
        console.log('  Referer:', finalStreamInfo.referer);
        console.log('  Embed page:', finalStreamInfo.embedUrl);
        console.log('  Extra headers:', finalStreamInfo.requestHeaders || {});

        const proxyUrl = buildProxyUrl(
            finalStreamInfo.streamUrl,
            finalStreamInfo.referer,
            proxyHost,
            finalStreamInfo.requestHeaders,
            finalStreamInfo.embedUrl,
            finalStreamInfo.directFetchOk
        );
        console.log('\nGenerated proxy URL:');
        console.log(proxyUrl);

        const upstreamHeaders = buildFetchHeaders(
            finalStreamInfo.referer,
            finalStreamInfo.requestHeaders
        );
        await probeUrl('Direct upstream (fresh scrape)', finalStreamInfo.streamUrl, upstreamHeaders);
        await probeUrl('LAN proxy URL (fresh scrape)', proxyUrl, { Accept: '*/*' });
    } finally {
        if (browser) {
            await browser.close();
        }
    }
}

async function main() {
    const options = parseArgs(process.argv.slice(2));

    if (options.help) {
        printUsage();
        return;
    }

    if (options.embedUrl) {
        await testEmbedUrl(options.embedUrl);
        return;
    }

    const feed = await loadFeed(options.feedPath);
    const streams = collectFeedStreams(feed);

    if (streams.length === 0) {
        console.error(`No streams found in ${options.feedPath}`);
        process.exit(1);
    }

    if (options.list) {
        printStreamList(streams);
        return;
    }

    if (Number.isNaN(options.index) || options.index < 0 || options.index >= streams.length) {
        console.error(`Invalid --index ${options.index}. Use --list to see valid indices (0-${streams.length - 1}).`);
        process.exit(1);
    }

    await testFeedStream(streams[options.index], { skipProxy: options.skipProxy });
}

main().catch((error) => {
    if (error.message?.startsWith('Unknown argument')) {
        console.error(error.message);
        printUsage();
    } else {
        console.error(error);
    }
    process.exit(1);
});
