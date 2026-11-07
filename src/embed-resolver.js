import {
    attachAdWindowHandler,
    attachManifestCapture,
} from './manifest-capture.js';
import {
    BROWSER_USER_AGENT,
    buildFetchHeaders,
    extractPassthroughHeaders,
    pickReferer,
    scoreManifestUrl,
} from './proxy-payload.js';
import {
    isBrowserConnectionError,
    isFrameDetachedError,
    safeClosePage,
    safeNewPage,
} from './puppeteer-utils.js';

const PLAY_SELECTORS = [
    '#player .play-button',
    '.play-btn',
    '[aria-label="Play"]',
    '.jw-display-icon-container',
    '.jw-icon-display',
    '.jw-video.jw-reset',
    '.vjs-big-play-button',
    'button.vjs-big-play-button',
    '.plyr__control--overlaid',
];
const PAUSE_SELECTORS = ['[aria-label="Pause"]', '.vjs-playing', '.jw-state-playing'];

/** Hosts that serve "Direct access blocked" unless loaded inside a parent iframe. */
function needsIframeParent(embedUrl) {
    return /embedsports\.|buffsports\./i.test(embedUrl);
}

/** TimStreams short links — JW player id is `player`; needs tim-streams.com Referer. */
function isTimStreamsEmbed(embedUrl) {
    return /ehgembxe\.cfd|grandemx\.|tim-streams\.com|timst\./i.test(String(embedUrl || ''));
}

/** Ad-heavy embed hosts rarely reach networkidle2 before the timeout. */
function gotoWaitUntil(embedUrl) {
    if (/embedsports\.|buffsports\.|matchora\.|sportplus\.|dami-tv\.|dervlin\.|taifood-blog\.|thedaddy\.|dembed\.st|ehgembxe\.cfd|grandemx\./i.test(embedUrl)) {
        return 'domcontentloaded';
    }
    return 'networkidle2';
}

function isManifestCandidate(url, contentType = '') {
    const ct = (contentType || '').toLowerCase();
    if (!url) return false;
    // JW player analytics, not media.
    if (/jwpltx\.com|ping\.gif/i.test(url)) return false;
    if (url.includes('.m3u8') || url.includes('.mpd')) return true;
    if (ct.includes('mpegurl') || ct.includes('application/vnd.apple.mpegurl')) return true;
    return false;
}

/** Same wait the TimStreams scraper uses — JW playlist file before CDN fetch. */
async function waitForTimStreamsJwFile(page, log) {
    log('-- TimStreams: waiting for jwplayer("player") playlist…');
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
        }, { timeout: 20000 })
        .then((handle) => handle.jsonValue())
        .catch(() => null);
    if (fromPlayer) {
        log(`-- TimStreams: JW playlist file ${String(fromPlayer).slice(0, 100)}…`);
    } else {
        log('-- TimStreams: JW playlist wait timed out');
    }
    return fromPlayer;
}

async function userAgentForBrowser(browser) {
    try {
        const version = await browser.version();
        const full = (version.match(/(\d+\.\d+\.\d+\.\d+)/) || [])[1];
        if (full) {
            return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${full} Safari/537.36`;
        }
    } catch {
        // fall through
    }
    return BROWSER_USER_AGENT;
}

/** Invisible overlays (e.g. embed.st #dontfoid) steal clicks from the real play control. */
async function stripClickBlockers(page) {
    for (const frame of page.frames()) {
        try {
            await frame.evaluate(() => {
                document
                    .querySelectorAll('#dontfoid, [id*="dontfo"], .ad-overlay, .adsbox')
                    .forEach((el) => el.remove());
            });
        } catch {
            // cross-origin / detached
        }
    }
}

/** Pull HLS file from JW Player playlist APIs across frames (plytvme/dervlin, embed.st, TimStreams). */
async function extractJwPlaylistFile(page) {
    for (const frame of page.frames()) {
        try {
            const file = await frame.evaluate(() => {
                try {
                    if (typeof window.jwplayer !== 'function') return null;
                    // TimStreams ehgembxe uses jwplayer('player'); others use the default id.
                    const candidates = [];
                    for (const id of ['player', undefined]) {
                        try {
                            const player = id ? window.jwplayer(id) : window.jwplayer();
                            if (player) candidates.push(player);
                        } catch {
                            // ignore missing id
                        }
                    }
                    for (const player of candidates) {
                        try {
                            player.play?.(true);
                        } catch {
                            // ignore
                        }
                        const item = player.getPlaylistItem?.() || player.getPlaylist?.()?.[0];
                        const file = item?.file || item?.sources?.[0]?.file || null;
                        if (file && typeof file === 'string' && /^https?:\/\//i.test(file)) {
                            return file;
                        }
                    }
                    return null;
                } catch {
                    return null;
                }
            });
            if (file && typeof file === 'string' && /^https?:\/\//i.test(file)) {
                return file;
            }
        } catch {
            // ignore
        }
    }
    return null;
}

/** Last-resort nudge when no explicit play control exists. */
async function nudgePlayer(page) {
    try {
        await page.evaluate(() => {
            const video = document.querySelector('video');
            if (video) {
                try {
                    video.muted = true;
                    const playResult = video.play();
                    if (playResult?.catch) playResult.catch(() => {});
                } catch {
                    // ignore autoplay rejection
                }
            }
            document.querySelector('#player, .player, .video-js, .jwplayer')?.click?.();
        });
    } catch {
        // ignore
    }
    try {
        const viewport = page.viewport() || { width: 1280, height: 720 };
        await page.mouse.click(Math.floor(viewport.width / 2), Math.floor(viewport.height / 2));
    } catch {
        // ignore
    }
}

async function queryInFrame(frame, selector) {
    try {
        if (frame.detached) {
            return null;
        }
        return await frame.$(selector);
    } catch (error) {
        if (isFrameDetachedError(error)) {
            return null;
        }
        throw error;
    }
}

async function findPlayButton(page) {
    for (const frame of [page.mainFrame(), ...page.frames()]) {
        for (const selector of PAUSE_SELECTORS) {
            const button = await queryInFrame(frame, selector);
            if (button) {
                return { button: null, frame: null, isPlaying: true };
            }
        }
        for (const selector of PLAY_SELECTORS) {
            const button = await queryInFrame(frame, selector);
            if (button) {
                return { button, frame, isPlaying: false };
            }
        }
    }
    return null;
}

async function clickPlayButton(page, log) {
    await stripClickBlockers(page);

    for (let attempt = 1; attempt <= 3; attempt++) {
        const buttonInfo = await findPlayButton(page);
        if (!buttonInfo) {
            // JW may exist without a matching selector — try the API directly.
            const jwFile = await extractJwPlaylistFile(page);
            if (jwFile) {
                log('-- JW player playlist found without play-button selector');
                return { clicked: true, jwFile };
            }
            return { clicked: false, jwFile: null };
        }
        if (buttonInfo.isPlaying) {
            const jwFile = await extractJwPlaylistFile(page);
            return { clicked: true, jwFile };
        }

        try {
            const { button, frame } = buttonInfo;
            if (frame && button) {
                await frame.evaluate((btn) => btn.click(), button);
            } else {
                for (const selector of PLAY_SELECTORS) {
                    const clicked = await page.click(selector).then(() => true).catch(() => false);
                    if (clicked) {
                        break;
                    }
                }
            }
            const jwFile = await extractJwPlaylistFile(page);
            return { clicked: true, jwFile };
        } catch (error) {
            if (isFrameDetachedError(error)) {
                log(`-- Play click failed (frame detached), retry ${attempt}/3...`);
                await new Promise((resolve) => setTimeout(resolve, 1500));
                continue;
            }
            throw error;
        }
    }
    return { clicked: false, jwFile: null };
}

function pickBestCandidate(candidates) {
    if (candidates.length === 0) {
        return null;
    }
    return [...candidates].sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (b.status === 200 && a.status !== 200) return 1;
        if (a.status === 200 && b.status !== 200) return -1;
        return 0;
    })[0];
}

async function runNodeReplayCheck(streamInfo, log) {
    const headers = buildFetchHeaders(streamInfo.referer, streamInfo.requestHeaders);
    try {
        const response = await fetch(streamInfo.streamUrl, { headers, redirect: 'follow' });
        log(`  -> Node replay check: ${response.status} ${response.statusText}`);
        return response.ok;
    } catch (error) {
        log(`  -> Node replay check failed: ${error.message}`);
        return false;
    }
}

/**
 * Load embedsports/buffsports inside a parent document.
 * Direct page.goto() returns "Direct access blocked".
 * @param {import('puppeteer').Page} page
 * @param {string} embedUrl
 */
async function loadInIframeParent(page, embedUrl) {
    const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>embed parent</title></head>
<body style="margin:0;background:#000">
<iframe id="emb" src="${embedUrl}" width="1280" height="720"
  allowfullscreen allow="autoplay; fullscreen; encrypted-media"
  referrerpolicy="no-referrer-when-downgrade"></iframe>
</body></html>`;
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    // Nested dervlin JW player needs a few seconds to bootstrap CSRF + playlist.
    await new Promise((resolve) => setTimeout(resolve, 4000));
}

/**
 * Same embed flow as streamed-scraper — intercept m3u8 from the player.
 * @param {import('puppeteer').Browser} browser
 * @param {string} embedUrl
 * @param {{ sourceName?: string, verbose?: boolean, checkNodeReplay?: boolean, captureManifestBody?: boolean, keepPageOpen?: boolean }} [options]
 */
export async function resolveStreamFromEmbed(browser, embedUrl, options = {}) {
    const {
        sourceName = 'embed',
        verbose = true,
        checkNodeReplay = false,
        captureManifestBody = false,
        keepPageOpen = false,
    } = options;
    const log = verbose ? (...args) => console.log(...args) : () => {};

    let page;
    let bodyCapture = null;

    try {
        page = await safeNewPage(browser);
        await page.setCacheEnabled(false);
        await page.setUserAgent(await userAgentForBrowser(browser));

        const timStreams = isTimStreamsEmbed(embedUrl);
        if (timStreams) {
            // Scraper sets tim-streams.com Referer; without it ehgembxe often
            // never boots JW and the proxy saw 0 m3u8 candidates.
            await page.setExtraHTTPHeaders({
                'Accept-Language': 'en-US,en;q=0.9',
                Referer: 'https://tim-streams.com/',
            });
        } else if (/taifood-blog/i.test(embedUrl)) {
            await page.setExtraHTTPHeaders({
                'Accept-Language': 'en-US,en;q=0.9',
                Referer: 'https://ppv.st/',
            });
        } else {
            try {
                await page.setExtraHTTPHeaders({
                    'Accept-Language': 'en-US,en;q=0.9',
                    Referer: `${new URL(embedUrl).origin}/`,
                });
            } catch {
                // malformed embed
            }
        }

        if (captureManifestBody || timStreams) {
            attachAdWindowHandler(page, log);
        }
        if (captureManifestBody) {
            bodyCapture = await attachManifestCapture(page, log);
        }

        /** @type {Array<{ score: number, status: number, info: object }>} */
        const candidates = [];

        const pushCandidate = (url, status, requestHeaders = {}, refererOverride = null) => {
            if (!url || !isManifestCandidate(url)) return;
            const referer = pickReferer(embedUrl, refererOverride || requestHeaders.referer);
            const score = scoreManifestUrl(url);
            const info = {
                streamUrl: url,
                referer,
                requestHeaders: extractPassthroughHeaders(requestHeaders),
                embedUrl,
                sourceName,
                confirmedAt: new Date().toISOString(),
            };
            candidates.push({ score, status, info });
            log(`[${status}] Stream manifest candidate: ${url}`);
        };

        // Capture on request too — TimStreams scraper does this; response-only
        // misses playlists that abort or 410 from datacenter while still useful.
        const requestListener = (request) => {
            pushCandidate(request.url(), 200, request.headers(), request.headers().referer);
        };
        const responseListener = (response) => {
            const url = response.url();
            const contentType = response.headers()['content-type'] || '';
            if (!isManifestCandidate(url, contentType)) {
                return;
            }

            const status = response.status();
            const request = response.request();
            const reqHeaders = request.headers();
            pushCandidate(url, status, reqHeaders, reqHeaders.referer);
        };

        page.on('request', requestListener);
        page.on('response', responseListener);

        const useIframeParent = needsIframeParent(embedUrl);
        if (useIframeParent) {
            log(`-- Loading embed inside iframe parent: ${embedUrl} (Source: ${sourceName})`);
            await loadInIframeParent(page, embedUrl);
        } else {
            const waitUntil = gotoWaitUntil(embedUrl);
            log(`-- Navigating to embed URL: ${embedUrl} (Source: ${sourceName})`);
            await page.goto(embedUrl, { waitUntil, timeout: 45000 });
        }

        // Sportplus geo-block — fail fast instead of waiting for a phantom player.
        const restricted = await page.evaluate(() =>
            /not available due to restrictions in your country/i.test(document.body?.innerText || '')
        );
        if (restricted) {
            log('-- Sportplus geo-blocked in this region; skipping');
            return null;
        }

        if (timStreams) {
            const jwFile = await waitForTimStreamsJwFile(page, log);
            if (jwFile) {
                pushCandidate(jwFile, 200, {}, 'https://ehgembxe.cfd/');
            }
        }

        log('-- Player page loaded. Looking for play button...');
        const { clicked, jwFile } = await clickPlayButton(page, log);
        if (jwFile) {
            pushCandidate(jwFile, 200, {}, `${new URL(embedUrl).origin}/`);
        }
        if (clicked) {
            log('-- Play button clicked (or already playing).');
            await new Promise((resolve) => setTimeout(resolve, 3000));
        } else {
            log('-- No play button found. Nudging player / waiting for stream...');
            await nudgePlayer(page);
            await stripClickBlockers(page);
            const lateJw = await extractJwPlaylistFile(page);
            if (lateJw) {
                pushCandidate(lateJw, 200, {}, `${new URL(embedUrl).origin}/`);
            }
        }

        const waitDeadline = Date.now() + (timStreams ? 8000 : 20000);
        while (Date.now() < waitDeadline) {
            // TimStreams: JW file is enough even when CDN returns 410 from this host.
            if (timStreams && candidates.length > 0) {
                break;
            }
            if (candidates.some((candidate) => candidate.status === 200)) {
                break;
            }
            // Nested plytvme/dervlin playlist can appear late.
            const lateJw = await extractJwPlaylistFile(page);
            if (lateJw) {
                pushCandidate(lateJw, 200, {}, `${new URL(embedUrl).origin}/`);
                break;
            }
            await new Promise((resolve) => setTimeout(resolve, 400));
        }

        // taifood / matchora: player often starts after the click loop; block on
        // one network m3u8 before giving up (0 candidates was common in headless).
        if (candidates.length === 0 && !timStreams) {
            log('-- No candidates yet; waiting for late m3u8 network response…');
            try {
                const lateRes = await page.waitForResponse(
                    (res) => isManifestCandidate(res.url(), res.headers()['content-type'] || ''),
                    { timeout: 15000 }
                );
                pushCandidate(
                    lateRes.url(),
                    lateRes.status(),
                    lateRes.request().headers(),
                    lateRes.request().headers().referer
                );
            } catch {
                log('-- Late m3u8 wait timed out');
            }
        }

        page.off('request', requestListener);
        page.off('response', responseListener);

        // TimStreams: prefer any captured signed URL even if the CDN 410'd from
        // this host — the LAN proxy fetches it later with a home IP.
        const best = timStreams
            ? (pickBestCandidate(candidates.filter((c) => c.status === 200))
                || pickBestCandidate(candidates)
                || (candidates.length ? candidates.sort((a, b) => b.score - a.score)[0] : null))
            : pickBestCandidate(candidates);
        if (!best || (!timStreams && best.status !== 200)) {
            const dervlinError = await page.evaluate(() => {
                for (const frame of [...document.querySelectorAll('iframe')]) {
                    // can't read cross-origin; just note presence
                }
                return /Network Error|Direct access blocked/i.test(document.body?.innerText || '');
            }).catch(() => false);
            log(
                `-- No successful m3u8 found (${candidates.length} candidate(s))` +
                    (useIframeParent
                        ? ' — plytvme needs a real Chrome display in some environments (headless may hit dervlin Network Error)'
                        : '') +
                    (dervlinError ? ' [blocked/error text on page]' : '')
            );
            return null;
        }

        const { info } = best;

        try {
            const cookies = await page.cookies();
            if (cookies.length > 0) {
                info.requestHeaders.cookie = cookies
                    .map((cookie) => `${cookie.name}=${cookie.value}`)
                    .join('; ');
                log(`  -> Captured ${cookies.length} browser cookie(s)`);
            }
        } catch {
            // Page may already be closing.
        }

        if (bodyCapture) {
            let manifestBody = await bodyCapture.waitForBody(info.streamUrl, 10000);
            if (!manifestBody) {
                manifestBody = bodyCapture.getAnyBody();
            }
            if (manifestBody) {
                info.manifestBody = manifestBody;
                const preview = manifestBody.split('\n').slice(0, 3).join(' | ');
                log(`  -> Manifest ready (${manifestBody.length} chars): ${preview}`);
            } else {
                log('  -> m3u8 URL found; body not captured yet (proxy will fetch on same page)');
            }
        }

        log(`[SUCCESS] Selected stream manifest: ${info.streamUrl}`);

        if (checkNodeReplay) {
            info.directFetchOk = await runNodeReplayCheck(info, log);
        }

        if (keepPageOpen) {
            info.embedPage = page;
            page = null;
        }

        return info;
    } catch (error) {
        if (isBrowserConnectionError(error)) {
            log(`-- Browser connection lost while resolving embed (${sourceName})`);
        } else if (isFrameDetachedError(error)) {
            log(`-- Embed page navigated away or frame lost (${sourceName})`);
        } else if (verbose) {
            console.error(`-- Embed resolve error: ${error.message}`);
        }
        return null;
    } finally {
        if (!keepPageOpen) {
            await safeClosePage(page);
        }
    }
}
