import {
    fetchManifestOnPage,
    getCapturedSegment,
    getLatestManifestEntry,
    getLatestManifestSourceUrl,
    waitForCapturedSegment,
    waitForLatestManifestBody,
    waitForNewerManifestEntry,
} from '../src/manifest-capture.js';
import { launchBrowser as launchStealthBrowser, describePuppeteerMode } from '../src/puppeteer-config.js';
import { BROWSER_USER_AGENT } from '../src/proxy-payload.js';
import { isBrowserConnected } from '../src/puppeteer-utils.js';
import {
    getEmbedPage,
    getIdleEmbedUrls,
    hasOpenEmbedPages,
    touchEmbedPage,
} from './embed-pages.js';

async function clearStreamCache() {
    const { clearAllResolvedStreams } = await import('./stream-session.js');
    clearAllResolvedStreams();
}

const IDLE_TIMEOUT_MS = Number.parseInt(process.env.PROXY_BROWSER_IDLE_MS || '', 10) || 10 * 60 * 1000;
const NAV_TIMEOUT_MS = Number.parseInt(process.env.PROXY_NAV_TIMEOUT_MS || '', 10) || 30000;
const PAGE_POOL_SIZE = Number.parseInt(process.env.PROXY_PAGE_POOL_SIZE || '', 10) || 1;
const debug = process.env.PROXY_DEBUG === 'true';

/** @type {import('puppeteer').Browser | null} */
let browser = null;
/** @type {Promise<import('puppeteer').Browser> | null} */
let browserLaunchPromise = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let idleTimer = null;

/** @type {Map<string, BrowserSession>} */
const sessions = new Map();
/** @type {Map<string, number>} last MEDIA-SEQUENCE served per embed|path */
const lastServedMediaSeq = new Map();

function logStep(message) {
    console.log(`[browser-fetch] ${message}`);
}

function logDebug(message) {
    if (debug) {
        console.log(`[browser-fetch] ${message}`);
    }
}

function parseCookieHeader(cookieHeader, baseUrl) {
    if (!cookieHeader?.trim()) {
        return [];
    }

    let domain;
    try {
        domain = new URL(baseUrl).hostname;
    } catch {
        return [];
    }

    return cookieHeader.split(';').map((chunk) => {
        const trimmed = chunk.trim();
        const eq = trimmed.indexOf('=');
        if (eq <= 0) {
            return null;
        }
        return {
            name: trimmed.slice(0, eq),
            value: trimmed.slice(eq + 1),
            domain,
            path: '/',
        };
    }).filter(Boolean);
}

/** @type {Map<string, Promise<void>>} */
const embedSegmentLocks = new Map();

/**
 * Serialize segment fetches that share a page so we don't stomp concurrent evaluate/CDP calls.
 * @template T
 * @param {string} key
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withPageLock(key, fn) {
    const previous = embedSegmentLocks.get(key) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => {
        release = resolve;
    });
    const chain = previous.catch(() => {}).then(() => gate);
    embedSegmentLocks.set(key, chain);
    await previous.catch(() => {});
    try {
        return await fn();
    } finally {
        release();
        if (embedSegmentLocks.get(key) === chain) {
            embedSegmentLocks.delete(key);
        }
    }
}

function originOf(url) {
    try {
        return new URL(url).origin;
    } catch {
        return '';
    }
}

/**
 * The frame whose origin matches the player referer (Daddy plays inside a
 * dembed.st iframe; fetching from the thedaddy.li top frame is CORS-blocked
 * and CDP from it sends the wrong Origin/Referer).
 * @param {import('puppeteer').Page} page
 * @param {string} [playerOrigin]
 */
function findPlayerFrame(page, playerOrigin) {
    if (!playerOrigin) {
        return page.mainFrame();
    }
    return page.frames().find((frame) => originOf(frame.url()) === playerOrigin)
        || page.mainFrame();
}

/**
 * Fetch a segment via in-page fetch() on an embed-origin page (real cookies + Origin).
 * page.goto(.ts) aborts; blank tabs lack the embed Origin and fail CORS/auth.
 * @param {import('puppeteer').Page} page
 * @param {string} url
 * @param {string} [playerOrigin]
 */
async function fetchSegmentInPage(page, url, playerOrigin = '') {
    const frame = findPlayerFrame(page, playerOrigin);
    logStep(
        `In-page segment fetch (${originOf(frame.url()) || 'main'}): ${url.slice(0, 100)}...`
    );

    const result = await frame.evaluate(async (segmentUrl) => {
        try {
            const response = await fetch(segmentUrl, {
                credentials: 'include',
                cache: 'no-store',
                redirect: 'follow',
            });
            if (!response.ok) {
                return { ok: false, status: response.status, error: `HTTP ${response.status}` };
            }
            const buffer = await response.arrayBuffer();
            const blob = new Blob([buffer]);
            const dataUrl = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(String(reader.result || ''));
                reader.onerror = () => reject(reader.error || new Error('FileReader failed'));
                reader.readAsDataURL(blob);
            });
            const comma = dataUrl.indexOf(',');
            return {
                ok: true,
                status: response.status,
                contentType: response.headers.get('content-type') || 'video/MP2T',
                base64: comma >= 0 ? dataUrl.slice(comma + 1) : '',
            };
        } catch (error) {
            return { ok: false, status: 0, error: error?.message || String(error) };
        }
    }, url);

    if (!result?.ok) {
        throw new Error(result?.error || 'in-page segment fetch failed');
    }

    const body = Buffer.from(result.base64, 'base64');
    logStep(`In-page segment fetch OK (${body.length} bytes)`);
    return {
        statusCode: result.status,
        headers: { 'content-type': result.contentType },
        body,
    };
}

/**
 * CDP fallback when page.evaluate(fetch) is CORS-blocked but the browser can still load the URL.
 * @param {import('puppeteer').Page} page
 * @param {string} url
 */
async function fetchSegmentViaCdp(page, url, playerOrigin = '') {
    logStep(`CDP segment fetch: ${url.slice(0, 100)}...`);
    const client = await page.createCDPSession();

    try {
        const { frameTree } = await client.send('Page.getFrameTree');
        let frameId = frameTree?.frame?.id;
        if (playerOrigin) {
            const stack = [frameTree];
            while (stack.length) {
                const node = stack.pop();
                if (originOf(node?.frame?.url) === playerOrigin) {
                    frameId = node.frame.id;
                    break;
                }
                stack.push(...(node?.childFrames || []));
            }
        }
        if (!frameId) {
            throw new Error('CDP frame id missing');
        }

        const { resource } = await client.send('Network.loadNetworkResource', {
            frameId,
            url,
            options: {
                disableCache: true,
                includeCredentials: true,
            },
        });

        if (!resource?.success) {
            throw new Error(resource?.netErrorName || resource?.netError || 'CDP loadNetworkResource failed');
        }
        if (resource.httpStatusCode && resource.httpStatusCode >= 400) {
            throw new Error(`CDP HTTP ${resource.httpStatusCode}`);
        }
        if (!resource.stream) {
            throw new Error('CDP resource missing stream handle');
        }

        const chunks = [];
        for (;;) {
            const read = await client.send('IO.read', {
                handle: resource.stream,
                size: 1024 * 1024,
            });
            if (read.data) {
                chunks.push(Buffer.from(read.data, read.base64Encoded ? 'base64' : 'utf8'));
            }
            if (read.eof) {
                break;
            }
        }
        await client.send('IO.close', { handle: resource.stream }).catch(() => {});

        const body = Buffer.concat(chunks);
        logStep(`CDP segment fetch OK (${body.length} bytes)`);
        return {
            statusCode: resource.httpStatusCode || 200,
            headers: { 'content-type': 'video/MP2T' },
            body,
        };
    } finally {
        await client.detach().catch(() => {});
    }
}

/**
 * Prefer in-page fetch on an embed-origin tab; fall back to CDP.
 * @param {import('puppeteer').Page} page
 * @param {string} url
 * @param {string} [lockKey]
 * @param {string} [playerOrigin] origin of the frame that plays the stream
 */
async function fetchSegmentFromBrowserPage(page, url, lockKey = 'page', playerOrigin = '') {
    return withPageLock(lockKey, async () => {
        try {
            return await fetchSegmentInPage(page, url, playerOrigin);
        } catch (inPageError) {
            logStep(`In-page segment fetch failed (${inPageError.message}); trying CDP`);
            return fetchSegmentViaCdp(page, url, playerOrigin);
        }
    });
}

/**
 * Manifests: CDP capture via page navigation (in-page fetch blocked by CORS on strmd).
 * Segments: in-page fetch / CDP on an embed-origin page — never page.goto(.ts).
 */
async function fetchOnPage(page, url, referer, isText) {
    if (isText) {
        return fetchManifestOnPage(page, url, referer, logStep);
    }

    return fetchSegmentFromBrowserPage(page, url, `session:${page.url()}`);
}

class BrowserSession {
    /** @param {import('puppeteer').Page[]} pages */
    constructor(pages, embedUrl, referer) {
        this.pages = pages;
        this.embedUrl = embedUrl;
        this.referer = referer;
        this.lastUsed = Date.now();
        this.nextPage = 0;
        /** @type {boolean[]} */
        this.busy = pages.map(() => false);
    }

    touch() {
        this.lastUsed = Date.now();
        scheduleIdleCleanup();
    }

    async acquirePageIndex() {
        while (true) {
            for (let i = 0; i < this.pages.length; i++) {
                if (!this.busy[i] && !this.pages[i].isClosed()) {
                    this.busy[i] = true;
                    return i;
                }
            }
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
    }

    releasePageIndex(index) {
        this.busy[index] = false;
    }

    /**
     * @param {string} url
     * @param {boolean} isText
     */
    async fetch(url, isText) {
        this.touch();
        const pageIndex = await this.acquirePageIndex();
        const page = this.pages[pageIndex];

        try {
            if (page.isClosed()) {
                throw new Error('Browser session page was closed');
            }

            logStep(`Fetching ${isText ? 'manifest' : 'segment'}: ${url.slice(0, 100)}...`);
            const result = await fetchOnPage(page, url, this.referer, isText);
            logStep(`Upstream status ${result.statusCode} for ${new URL(url).pathname.split('/').slice(-2).join('/')}`);
            return result;
        } finally {
            this.releasePageIndex(pageIndex);
        }
    }

    async close() {
        await Promise.all(this.pages.map((page) => {
            if (!page.isClosed()) {
                return page.close().catch(() => {});
            }
            return undefined;
        }));
    }
}

async function launchBrowser() {
    const mode = describePuppeteerMode();
    logStep(`Launching Chromium (${mode})...`);
    try {
        browser = await launchStealthBrowser();
    } catch (err) {
        // A rejected launch promise used to stick forever and 500 every stream
        browser = null;
        browserLaunchPromise = null;
        logStep(`Chromium launch failed: ${err.message}`);
        throw err;
    }

    browser.on('disconnected', () => {
        browser = null;
        browserLaunchPromise = null;
        sessions.clear();
        void clearStreamCache();
        logStep('Browser disconnected');
    });

    logStep('Chromium ready');
    return browser;
}

async function getBrowser() {
    if (isBrowserConnected(browser)) {
        return browser;
    }

    if (browserLaunchPromise) {
        return browserLaunchPromise;
    }

    browserLaunchPromise = launchBrowser().finally(() => {
        // Only clear when this attempt finished without leaving a live browser;
        // success keeps the handle on `browser`, failure must allow retry.
        if (!isBrowserConnected(browser)) {
            browserLaunchPromise = null;
        }
    });
    return browserLaunchPromise;
}

export { getBrowser };

function sessionKey(embedUrl, referer) {
    return embedUrl || referer || 'default';
}

async function warmupPage(page, embedUrl, referer) {
    const warmupUrl = embedUrl || referer;
    if (!warmupUrl) {
        return;
    }

    await page.goto(warmupUrl, {
        waitUntil: 'domcontentloaded',
        timeout: NAV_TIMEOUT_MS,
    });
}

async function createSessionPages(activeBrowser, embedUrl, referer, extraHeaders = {}) {
    const cookieBase = embedUrl || referer;
    const cookies = parseCookieHeader(extraHeaders.cookie, cookieBase);
    const pages = [];
    const warmupUrl = embedUrl || referer;

    for (let i = 0; i < PAGE_POOL_SIZE; i++) {
        const page = await activeBrowser.newPage();
        await page.setUserAgent(BROWSER_USER_AGENT);
        await page.setCacheEnabled(false);

        if (cookies.length > 0) {
            await page.setCookie(...cookies);
        }

        // Must load embed origin so in-page segment fetch() sends the right Origin.
        if (warmupUrl) {
            await warmupPage(page, embedUrl, referer);
        }

        pages.push(page);
    }

    if (warmupUrl) {
        logStep(`Warmed ${pages.length} session page(s) on embed origin for segment fetch`);
    } else if (cookies.length > 0) {
        logStep(`Applied ${cookies.length} cookie(s) for segment fetch (no embed URL to warm)`);
    }

    return pages;
}

/**
 * @param {string} embedUrl
 * @param {string} referer
 * @param {Record<string, string>} extraHeaders
 * @returns {Promise<BrowserSession>}
 */
async function getSession(embedUrl, referer, extraHeaders = {}) {
    const key = sessionKey(embedUrl, referer);
    const existing = sessions.get(key);

    if (existing?.pages?.[0] && !existing.pages[0].isClosed()) {
        existing.touch();
        logDebug(`Reusing session ${key}`);
        return existing;
    }

    const activeBrowser = await getBrowser();
    const pages = await createSessionPages(activeBrowser, embedUrl, referer, extraHeaders);
    const session = new BrowserSession(pages, embedUrl, referer);
    sessions.set(key, session);
    scheduleIdleCleanup();
    return session;
}

function scheduleIdleCleanup() {
    if (idleTimer) {
        clearTimeout(idleTimer);
    }

    idleTimer = setTimeout(() => {
        void closeIdleSessions();
    }, IDLE_TIMEOUT_MS);
}

async function closeIdleSessions() {
    const now = Date.now();
    const closeTasks = [];

    for (const [key, session] of sessions.entries()) {
        if (now - session.lastUsed >= IDLE_TIMEOUT_MS) {
            closeTasks.push((async () => {
                await session.close();
                sessions.delete(key);
            })());
        }
    }

    await Promise.all(closeTasks);

    // Age out idle embed player tabs (Daddy/Streamed live capture). Do NOT close
    // the whole browser while any embed is still in use — that used to wipe
    // mid-play sessions whenever BrowserSession pool went empty.
    const idleEmbeds = getIdleEmbedUrls(IDLE_TIMEOUT_MS);
    if (idleEmbeds.length > 0) {
        const { clearResolvedStream } = await import('./stream-session.js');
        for (const embedUrl of idleEmbeds) {
            clearResolvedStream(embedUrl);
            logStep(`Closed idle embed tab: ${embedUrl.slice(0, 80)}`);
        }
    }

    const embedsOpen = hasOpenEmbedPages();
    if (sessions.size === 0 && !embedsOpen && isBrowserConnected(browser)) {
        await browser.close().catch(() => {});
        browser = null;
        browserLaunchPromise = null;
        void clearStreamCache();
        logStep('Closed idle browser');
    } else if (sessions.size > 0 || embedsOpen) {
        scheduleIdleCleanup();
    }
}

/**
 * Segments are plain CDN URLs (tiktokcdn, strmd .ts, etc.). Fetch the bytes
 * directly with the embed referer — no browser tab needed.
 */
async function tryDirectSegmentFetch(url, referer, extraHeaders = {}) {
    const headers = { 'User-Agent': BROWSER_USER_AGENT };
    if (referer) {
        headers.Referer = referer;
        // No Origin — Daddy/wedd48c and TikTok often 403 when Origin is set.
    }
    if (extraHeaders.cookie) {
        headers.Cookie = extraHeaders.cookie;
    }

    try {
        const response = await fetch(url, {
            headers,
            redirect: 'follow',
            signal: AbortSignal.timeout(20000),
        });
        if (!response.ok) {
            logStep(`Direct segment fetch HTTP ${response.status}`);
            return { failedStatus: response.status };
        }
        const body = Buffer.from(await response.arrayBuffer());
        logStep(`Direct segment fetch OK (${body.length} bytes)`);
        return {
            statusCode: response.status,
            headers: { 'content-type': response.headers.get('content-type') || 'video/MP2T' },
            body,
        };
    } catch (error) {
        logStep(`Direct segment fetch failed: ${error.message}`);
        return null;
    }
}

export async function fetchViaBrowser(url, { embedUrl, referer, extraHeaders = {} }, isText) {
    const embedPage = embedUrl ? getEmbedPage(embedUrl) : null;
    const embedAlive = embedPage && !embedPage.isClosed();
    if (embedAlive && embedUrl) {
        touchEmbedPage(embedUrl);
        scheduleIdleCleanup();
    }

    if (isText && embedAlive) {
        // Trust the player's own playlist downloads (they keep advancing). Do NOT
        // CDP re-fetch index.m3u8?t=… — that 404s and we used to kill the tab with
        // a fake 410 while captures n=2,3,4 were still landing fine.
        let entry = getLatestManifestEntry(embedPage, url);
        if (!entry) {
            await waitForLatestManifestBody(embedPage, url, 2500);
            entry = getLatestManifestEntry(embedPage, url);
        }
        if (entry?.body) {
            const serveKey = `${embedUrl}|${url.split('?')[0]}`;
            const lastSeq = lastServedMediaSeq.get(serveKey) || 0;
            let mediaSeq = Number(
                (entry.body.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/) || [])[1] || 0
            );
            if (mediaSeq > 0 && mediaSeq <= lastSeq) {
                const newer = await waitForNewerManifestEntry(
                    embedPage,
                    url,
                    mediaSeq,
                    2500
                );
                if (newer?.body) {
                    entry = newer;
                    mediaSeq = Number(
                        (entry.body.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/) || [])[1] || mediaSeq
                    );
                }
            }
            if (mediaSeq > 0) {
                lastServedMediaSeq.set(serveKey, mediaSeq);
            }
            const sourceUrl = entry.url || getLatestManifestSourceUrl(embedPage, url) || url;
            logStep(
                `Serving player-captured manifest (${entry.body.length} chars, seq=${mediaSeq || '?'})`
            );
            return {
                statusCode: 200,
                headers: { 'content-type': 'application/vnd.apple.mpegurl' },
                body: entry.body,
                sourceUrl,
            };
        }
        // Never page.goto() the embed tab — that kills the player session and
        // used to fall back to the wrong (master) playlist for every mono.m3u8.
        logStep('No matching manifest on embed page; fetching via session tab');
    }

    if (!isText) {
        if (embedAlive) {
            const sniffed = () => {
                const body = getCapturedSegment(embedPage, url);
                if (!body?.length) {
                    return null;
                }
                logStep(`Serving player-sniffed segment (${body.length} bytes)`);
                return { statusCode: 200, headers: { 'content-type': 'video/MP2T' }, body };
            };
            const hit = sniffed();
            if (hit) {
                return hit;
            }

            // Fetch from the frame that plays the stream (Daddy: dembed.st iframe),
            // not the outer page — that is CORS-blocked and sends the wrong Origin.
            const playerOrigin = originOf(referer);
            try {
                return await fetchSegmentFromBrowserPage(
                    embedPage,
                    url,
                    `embed:${embedUrl}`,
                    playerOrigin
                );
            } catch (embedError) {
                logStep(`Player-frame segment fetch failed (${embedError.message})`);
            }

            const late = await waitForCapturedSegment(embedPage, url, 1500);
            if (late?.length) {
                logStep(`Serving late player-sniffed segment (${late.length} bytes)`);
                return { statusCode: 200, headers: { 'content-type': 'video/MP2T' }, body: late };
            }
        }

        const direct = await tryDirectSegmentFetch(url, referer, extraHeaders);
        if (direct && !direct.failedStatus) {
            return direct;
        }
        if (embedAlive) {
            // The session tab is on the same wrong origin — don't burn another
            // round of fetches; let Roku move on to the next segment/poll.
            return {
                statusCode: direct?.failedStatus || 502,
                headers: {},
                body: '',
            };
        }
        logStep('Direct segment fetch failed; falling back to session tab');
    }

    const session = await getSession(embedUrl, referer, extraHeaders);
    return session.fetch(url, isText);
}

export async function resetBrowserSessions() {
    for (const session of sessions.values()) {
        await session.close();
    }
    sessions.clear();

    if (isBrowserConnected(browser)) {
        await browser.close().catch(() => {});
    }

    browser = null;
    browserLaunchPromise = null;
}

export async function shutdownBrowserFetch() {
    if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
    }
    await resetBrowserSessions();
    try {
        const { shutdownAudioRemux } = await import('./audio-remux.js');
        await shutdownAudioRemux();
    } catch {
        // Remux module optional during partial boots.
    }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
        void shutdownBrowserFetch().finally(() => process.exit(0));
    });
}
