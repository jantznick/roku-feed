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
} from './puppeteer-utils.js';

const PLAY_SELECTORS = ['#player .play-button', '.play-btn', '[aria-label="Play"]', '.jw-video.jw-reset'];
const PAUSE_SELECTORS = ['[aria-label="Pause"]', '.vjs-playing'];

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
    for (let attempt = 1; attempt <= 3; attempt++) {
        const buttonInfo = await findPlayButton(page);
        if (!buttonInfo) {
            return false;
        }
        if (buttonInfo.isPlaying) {
            return true;
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
            return true;
        } catch (error) {
            if (isFrameDetachedError(error)) {
                log(`-- Play click failed (frame detached), retry ${attempt}/3...`);
                await new Promise((resolve) => setTimeout(resolve, 1500));
                continue;
            }
            throw error;
        }
    }
    return false;
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
        page = await browser.newPage();
        await page.setCacheEnabled(false);
        await page.setUserAgent(BROWSER_USER_AGENT);

        if (captureManifestBody) {
            attachAdWindowHandler(page, log);
            bodyCapture = await attachManifestCapture(page, log);
        }

        /** @type {Array<{ score: number, status: number, info: object }>} */
        const candidates = [];

        const responseListener = (response) => {
            const url = response.url();
            if (!url.includes('.m3u8') && !url.includes('.mpd')) {
                return;
            }

            const status = response.status();
            const request = response.request();
            const reqHeaders = request.headers();
            const referer = pickReferer(embedUrl, reqHeaders.referer);
            const score = scoreManifestUrl(url);
            const info = {
                streamUrl: url,
                referer,
                requestHeaders: extractPassthroughHeaders(reqHeaders),
                embedUrl,
                sourceName,
                confirmedAt: new Date().toISOString(),
            };

            candidates.push({ score, status, info });
            log(`[${status}] Stream manifest candidate: ${url}`);
        };

        page.on('response', responseListener);

        log(`-- Navigating to embed URL: ${embedUrl} (Source: ${sourceName})`);
        await page.goto(embedUrl, { waitUntil: 'networkidle2', timeout: 30000 });

        log('-- Player page loaded. Looking for play button...');
        const clicked = await clickPlayButton(page, log);
        if (clicked) {
            log('-- Play button clicked (or already playing).');
            await new Promise((resolve) => setTimeout(resolve, 3000));
        } else {
            log('-- No play button found. Waiting for stream to load automatically...');
        }

        const waitDeadline = Date.now() + 15000;
        while (Date.now() < waitDeadline) {
            if (candidates.some((candidate) => candidate.status === 200)) {
                break;
            }
            await new Promise((resolve) => setTimeout(resolve, 300));
        }

        page.off('response', responseListener);

        const best = pickBestCandidate(candidates);
        if (!best || best.status !== 200) {
            log(`-- No successful m3u8 found (${candidates.length} candidate(s))`);
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
