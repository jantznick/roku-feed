/**
 * Capture HLS manifest bodies from Puppeteer response events.
 * Puppeteer 24 removed page.route() — use response.text() with a timeout instead.
 */

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isManifestUrl(url) {
    return url.includes('.m3u8') || url.includes('.mpd');
}

/** Path after the quality root (/1/high/mono.m3u8 → high/mono.m3u8). */
function qualityPathSuffix(pathname) {
    const match = String(pathname || '').match(/\/\d+\/(.+)$/);
    return match ? match[1] : '';
}

function isValidManifestText(text) {
    return text.includes('#EXTM3U') || text.includes('#EXT-X-');
}

function pathnameOf(url) {
    try {
        return new URL(url).pathname;
    } catch {
        return String(url || '').split('?')[0] || '';
    }
}

function mediaSequenceOf(body) {
    const match = String(body || '').match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/);
    return match ? match[1] : '?';
}

/** @type {WeakMap<import('puppeteer').Page, object>} */
const capturesByPage = new WeakMap();

/**
 * @param {import('puppeteer').HTTPResponse} response
 * @param {number} [timeoutMs]
 */
async function tryReadResponseBody(response, timeoutMs = 8000) {
    const read = async (method) => Promise.race([
        method(),
        new Promise((_, reject) => {
            setTimeout(() => reject(new Error('body read timeout')), timeoutMs);
        }),
    ]);

    try {
        const text = await read(() => response.text());
        if (isValidManifestText(text)) {
            return text;
        }
    } catch {
        // Fall through to buffer.
    }

    try {
        const buffer = await read(() => response.buffer());
        const text = buffer.toString('utf8');
        if (isValidManifestText(text)) {
            return text;
        }
    } catch {
        // Unreadable in Puppeteer — caller may use document fallback.
    }

    return null;
}

/**
 * @param {import('puppeteer').Page} page
 * @param {(msg: string) => void} [log]
 */
export async function attachManifestCapture(page, log = () => {}) {
    const existing = capturesByPage.get(page);
    if (existing) {
        return existing;
    }

    /**
     * Pathname → { body, url, seq }. Keying by pathname avoids query-string churn.
     * seq guards against async response.text() races: an older playlist read that
     * finishes late must not overwrite a newer capture (Daddy MEDIA-SEQUENCE freeze).
     * @type {Map<string, { body: string, url: string, seq: number }>}
     */
    const byPath = new Map();
    /** @type {Map<string, number>} */
    const latestSeqByPath = new Map();
    let captureSeq = 0;

    const onResponse = (response) => {
        const url = response.url();
        if (!isManifestUrl(url) || response.status() !== 200) {
            return;
        }

        const path = pathnameOf(url);
        if (!path) {
            return;
        }
        const seq = ++captureSeq;
        latestSeqByPath.set(path, Math.max(latestSeqByPath.get(path) || 0, seq));

        void (async () => {
            const text = await tryReadResponseBody(response);
            if (!text) {
                return;
            }
            // Stale read: a newer capture for this path was already assigned a higher seq.
            if (seq < (latestSeqByPath.get(path) || 0)) {
                return;
            }
            // Another in-flight read with a higher seq finished first.
            const current = byPath.get(path);
            if (current && current.seq > seq) {
                return;
            }

            byPath.set(path, { body: text, url, seq });
            log(
                `  -> Captured ${url.split('/').pop()} (${text.length} chars, ` +
                    `seq=${mediaSequenceOf(text)})`
            );
        })();
    };

    page.on('response', onResponse);

    const capture = {
        getBody(url) {
            return this.getLatestForUrl(url);
        },

        getAnyBody() {
            let best = null;
            for (const entry of byPath.values()) {
                if (!best || entry.seq > best.seq) {
                    best = entry;
                }
            }
            return best?.body || null;
        },

        /** @returns {{ body: string, url: string, seq: number } | null} */
        getLatestEntry(preferredUrl) {
            const preferredPath = pathnameOf(preferredUrl);
            if (preferredPath && byPath.has(preferredPath)) {
                return byPath.get(preferredPath);
            }

            const preferredSuffix = qualityPathSuffix(preferredPath);
            if (!preferredSuffix) {
                return null;
            }
            let best = null;
            for (const [path, entry] of byPath) {
                if (qualityPathSuffix(path) === preferredSuffix) {
                    if (!best || entry.seq > best.seq) {
                        best = entry;
                    }
                }
            }
            return best;
        },

        /**
         * Latest body for a URL. Match same pathname or same quality-root suffix.
         * Never return a different playlist quality (master vs mono) — that caused
         * nested /high/high/ rewrite loops on Roku.
         */
        getLatestForUrl(preferredUrl) {
            return this.getLatestEntry(preferredUrl)?.body || null;
        },

        /** Source URL of the latest capture (includes live query token when present). */
        getLatestSourceUrl(preferredUrl) {
            return this.getLatestEntry(preferredUrl)?.url || null;
        },

        /** @param {string} url @param {number} [timeoutMs] */
        async waitForBody(url, timeoutMs = 12000) {
            const deadline = Date.now() + timeoutMs;
            while (Date.now() < deadline) {
                const matched = this.getLatestForUrl(url);
                if (matched) {
                    return matched;
                }
                await sleep(150);
            }
            return this.getLatestForUrl(url);
        },

        dispose() {
            page.off('response', onResponse);
            capturesByPage.delete(page);
        },
    };

    capturesByPage.set(page, capture);
    return capture;
}

/**
 * Close ad tabs opened via window.open() when play is clicked.
 * @param {import('puppeteer').Page} page
 * @param {(msg: string) => void} [log]
 */
export function attachAdWindowHandler(page, log = () => {}) {
    page.on('popup', async (popup) => {
        try {
            // Wait briefly so the popup URL settles (often blank at the event).
            await new Promise((r) => setTimeout(r, 500));
            const url = popup.url() || '';
            // Never close player/embed popups — that killed Daddy sessions mid-play
            // when another resolve's ad handler raced the shared browser.
            if (/thedaddy\.li\/stream|ehgembxe\.cfd|\/embed\/|\.m3u8|dembed\.st|matchora/i.test(url)) {
                log(`-- Leaving player popup open (${url.slice(0, 100)})`);
                return;
            }
            log(`-- Ad window opened (${url || '(loading)'}), closing`);
            await popup.close();
        } catch {
            // Popup may already be gone.
        }
    });
}

/**
 * @param {import('puppeteer').Page} page
 */
async function readManifestFromDocument(page) {
    return page.evaluate(() => (
        document.body?.innerText || document.documentElement?.textContent || ''
    ));
}

/**
 * Fetch manifest on a page that already has embed session state.
 * @param {import('puppeteer').Page} page
 * @param {string} url
 * @param {string} referer
 * @param {(msg: string) => void} [log]
 */
export async function fetchManifestOnPage(page, url, referer, log = () => {}) {
    const headers = { Referer: referer };
    try {
        headers.Origin = new URL(referer).origin;
    } catch {
        // Optional
    }
    await page.setExtraHTTPHeaders(headers);

    const capture = await attachManifestCapture(page, log);

    log(`Navigating to manifest: ${url.slice(0, 100)}...`);
    let response;
    try {
        response = await page.goto(url, {
            waitUntil: 'domcontentloaded',
            timeout: 30000,
        });
    } catch (error) {
        throw new Error(`Manifest navigation failed: ${error.message}`);
    }

    const statusCode = response?.status() ?? 0;

    let body = capture.getBody(url);
    if (!body) {
        body = await capture.waitForBody(url, 5000);
    }
    if (!body) {
        body = capture.getAnyBody();
    }
    if (!body) {
        const pageText = await readManifestFromDocument(page);
        if (isValidManifestText(pageText)) {
            body = pageText;
            log(`  -> Read manifest from page document (${body.length} chars)`);
        }
    }

    body = body || '';

    log(`Manifest fetch status ${statusCode}, body ${body.length} chars`);
    if (body.length > 0) {
        log(`Manifest preview: ${body.split('\n').slice(0, 3).join(' | ')}`);
    }

    return {
        statusCode,
        headers: { 'content-type': 'application/vnd.apple.mpegurl' },
        body,
    };
}

/** @deprecated alias */
export const attachManifestRouteCapture = attachManifestCapture;

/**
 * Read the latest manifest the embed player already fetched — no navigation.
 * @param {import('puppeteer').Page} page
 * @param {string} [preferredUrl]
 */
export function getLatestManifestBody(page, preferredUrl = '') {
    const capture = capturesByPage.get(page);
    if (!capture) {
        return null;
    }
    return preferredUrl ? capture.getLatestForUrl(preferredUrl) : capture.getAnyBody();
}

/**
 * Source URL (with live query token) for the latest captured playlist.
 * @param {import('puppeteer').Page} page
 * @param {string} [preferredUrl]
 */
export function getLatestManifestSourceUrl(page, preferredUrl = '') {
    const capture = capturesByPage.get(page);
    if (!capture || !preferredUrl) {
        return null;
    }
    return capture.getLatestSourceUrl?.(preferredUrl) || null;
}

/**
 * Wait for the embed player to produce a manifest body.
 * @param {import('puppeteer').Page} page
 * @param {string} url
 * @param {number} [timeoutMs]
 */
export async function waitForLatestManifestBody(page, url, timeoutMs = 8000) {
    const capture = capturesByPage.get(page);
    if (!capture) {
        return null;
    }
    // Already have manifests but none match this URL → don't stall; caller fetches.
    if (capture.getAnyBody() && !capture.getLatestForUrl(url)) {
        return null;
    }
    await capture.waitForBody(url, timeoutMs);
    return capture.getLatestForUrl(url);
}
