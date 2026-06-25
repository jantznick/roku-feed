/** Shared Puppeteer launch options for scraper and proxy. */
export function getPuppeteerLaunchOptions() {
    // Visible browser by default so you can watch embed resolve / ad behavior.
    // Set PROXY_HEADLESS=true in .env for server/CI.
    const headless = process.env.PROXY_HEADLESS === 'true';

    return {
        headless,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            ...(headless ? [] : ['--start-maximized']),
        ],
        defaultViewport: headless ? { width: 1280, height: 720 } : null,
    };
}

export function describePuppeteerMode() {
    return process.env.PROXY_HEADLESS === 'true' ? 'headless' : 'visible';
}
