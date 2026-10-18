/** @returns {boolean} */
export function isBrowserConnectionError(error) {
    const message = error?.message || '';
    return (
        error?.name === 'ConnectionClosedError' ||
        message.includes('Connection closed') ||
        message.includes('Protocol error') ||
        message.includes('Target closed') ||
        message.includes('Session closed')
    );
}

/**
 * puppeteer-extra-plugin-stealth races when many pages are created at once:
 * `evaluateOnNewDocument` runs before the main frame exists, then UA override
 * hits a closed session. Those errors are thrown from plugin async handlers
 * (outside our await chain) and will kill Node unless swallowed.
 * @param {unknown} error
 */
export function isStealthPageRaceError(error) {
    const message = error?.message || String(error || '');
    const name = error?.name || '';
    return (
        message.includes('Requesting main frame too early') ||
        (name === 'TargetCloseError' &&
            (message.includes('Network.setUserAgentOverride') ||
                message.includes('Session closed'))) ||
        message.includes('Protocol error (Network.setUserAgentOverride)')
    );
}

let processGuardsInstalled = false;

/**
 * Keep concurrent embed scrapes from taking down the whole feed run when
 * stealth's onPageCreated races with page close / frame init.
 */
export function installPuppeteerProcessGuards() {
    if (processGuardsInstalled) return;
    processGuardsInstalled = true;

    const swallow = (label, error) => {
        if (!isStealthPageRaceError(error)) return false;
        console.warn(`[puppeteer] ${label} (non-fatal stealth race): ${error?.message || error}`);
        return true;
    };

    process.on('uncaughtException', (error) => {
        if (swallow('uncaughtException', error)) return;
        console.error('Uncaught exception:', error);
        process.exit(1);
    });

    process.on('unhandledRejection', (reason) => {
        if (swallow('unhandledRejection', reason)) return;
        console.error('Unhandled rejection:', reason);
        process.exit(1);
    });
}

/** Serialize browser.newPage() — stealth onPageCreated is not concurrency-safe. */
let pageCreateChain = Promise.resolve();

/**
 * Create a page with a create-mutex + short retry for stealth frame races.
 * @param {import('puppeteer').Browser} browser
 * @param {object} [options] forwarded to browser.newPage
 * @returns {Promise<import('puppeteer').Page>}
 */
export async function safeNewPage(browser, options = undefined) {
    const create = async () => {
        let lastError;
        for (let attempt = 1; attempt <= 3; attempt++) {
            /** @type {import('puppeteer').Page|undefined} */
            let page;
            try {
                page = options === undefined
                    ? await browser.newPage()
                    : await browser.newPage(options);
                // Give stealth evasions a tick to attach before callers navigate.
                await new Promise((r) => setTimeout(r, 25 * attempt));
                if (page.isClosed()) {
                    throw new Error('Page closed immediately after create');
                }
                return page;
            } catch (error) {
                lastError = error;
                if (page) {
                    await safeClosePage(page);
                }
                if (!isStealthPageRaceError(error) && !isBrowserConnectionError(error)) {
                    throw error;
                }
                if (attempt < 3) {
                    console.warn(
                        `[puppeteer] newPage race (attempt ${attempt}/3): ${error.message}`
                    );
                    await new Promise((r) => setTimeout(r, 100 * attempt));
                }
            }
        }
        throw lastError;
    };

    const run = pageCreateChain.then(create, create);
    // Keep the chain alive even if this create fails so later pages still queue.
    pageCreateChain = run.then(
        () => undefined,
        () => undefined
    );
    return run;
}

/** @returns {boolean} */
export function isFrameDetachedError(error) {
    const message = error?.message || '';
    return (
        message.includes('frame was detached') ||
        message.includes('Frame detached') ||
        message.includes('Execution context was destroyed') ||
        message.includes('Cannot find context with specified id')
    );
}

/** Close a Puppeteer page without failing the scraper if the browser already died. */
export async function safeClosePage(page) {
    if (!page || page.isClosed()) {
        return;
    }

    try {
        await page.close();
    } catch (error) {
        if (!isBrowserConnectionError(error)) {
            console.warn(`-- Could not close browser page: ${error.message}`);
        }
    }
}

/** @returns {boolean} */
export function isBrowserConnected(browser) {
    return Boolean(browser && typeof browser.isConnected === 'function' && browser.isConnected());
}
