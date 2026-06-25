import puppeteer from 'puppeteer';
import {
    fetchManifestOnPage,
    getLatestManifestBody,
    waitForLatestManifestBody,
} from '../src/manifest-capture.js';
import { getPuppeteerLaunchOptions, describePuppeteerMode } from '../src/puppeteer-config.js';
import { BROWSER_USER_AGENT } from '../src/proxy-payload.js';
import { isBrowserConnected } from '../src/puppeteer-utils.js';
import { getEmbedPage } from './embed-pages.js';

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

async function applyRequestHeaders(page, referer) {
    const headers = { Referer: referer };
    try {
        headers.Origin = new URL(referer).origin;
    } catch {
        // Optional
    }
    await page.setExtraHTTPHeaders(headers);
}

/**
 * Manifests: CDP capture via page navigation (in-page fetch blocked by CORS on strmd).
 * Segments: page.goto + buffer.
 */
async function fetchOnPage(page, url, referer, isText) {
    if (isText) {
        return fetchManifestOnPage(page, url, referer, logStep);
    }

    await applyRequestHeaders(page, referer);

    logStep(`Navigating to fetch segment: ${url.slice(0, 100)}...`);

    let response;
    try {
        response = await page.goto(url, {
            waitUntil: isText ? 'networkidle2' : 'load',
            timeout: isText ? NAV_TIMEOUT_MS : NAV_TIMEOUT_MS * 2,
        });
    } catch (error) {
        logStep(`Navigation error: ${error.message}`);
        throw new Error(`Browser navigation failed for ${url}: ${error.message}`);
    }

    if (!response) {
        throw new Error(`page.goto returned no response for ${url}`);
    }

    const statusCode = response.status();
    logStep(`Segment upstream status ${statusCode}`);

    const body = await Promise.race([
        response.buffer(),
        new Promise((_, reject) => {
            setTimeout(() => reject(new Error('segment body read timeout')), 15000);
        }),
    ]);

    logStep(`Read ${body.byteLength} bytes from upstream`);

    return {
        statusCode,
        headers: response.headers(),
        body,
    };
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
    browserLaunchPromise = puppeteer.launch(getPuppeteerLaunchOptions());

    browser = await browserLaunchPromise;
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

    if (!browserLaunchPromise) {
        return launchBrowser();
    }

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

    for (let i = 0; i < PAGE_POOL_SIZE; i++) {
        const page = await activeBrowser.newPage();
        await page.setUserAgent(BROWSER_USER_AGENT);
        await page.setCacheEnabled(false);

        if (cookies.length > 0) {
            await page.setCookie(...cookies);
        }

        pages.push(page);
    }

    if (cookies.length > 0) {
        logStep(`Applied ${cookies.length} cookie(s) for segment fetch (no embed navigation)`);
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

    if (sessions.size === 0 && isBrowserConnected(browser)) {
        await browser.close().catch(() => {});
        browser = null;
        browserLaunchPromise = null;
        void clearStreamCache();
        logStep('Closed idle browser');
    } else if (sessions.size > 0) {
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
        try {
            headers.Origin = new URL(referer).origin;
        } catch {
            // Optional
        }
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
            return null;
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

    if (isText && embedAlive) {
        let body = getLatestManifestBody(embedPage, url);
        if (!body) {
            body = await waitForLatestManifestBody(embedPage, url, 8000);
        }
        if (body) {
            logStep(`Serving live manifest from embed player (${body.length} chars)`);
            return {
                statusCode: 200,
                headers: { 'content-type': 'application/vnd.apple.mpegurl' },
                body,
            };
        }
        logStep('No live manifest on embed page yet; falling back to navigation');
        return fetchManifestOnPage(embedPage, url, referer, logStep);
    }

    if (!isText) {
        const direct = await tryDirectSegmentFetch(url, referer, extraHeaders);
        if (direct) {
            return direct;
        }
        logStep('Direct segment fetch failed; falling back to browser tab');
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
}

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
        void shutdownBrowserFetch().finally(() => process.exit(0));
    });
}
