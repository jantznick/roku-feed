import fs from 'fs';

/** Shared Puppeteer launch options for scraper and proxy. */
export function getPuppeteerLaunchOptions() {
    // Visible by default for local debugging. Headless when:
    // - PROXY_HEADLESS=true (server / Docker), or
    // - running inside a Docker container (no X display).
    const inDocker = fs.existsSync('/.dockerenv');
    const headless = process.env.PROXY_HEADLESS === 'true' || inDocker;

    return {
        headless,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-blink-features=AutomationControlled',
            ...(headless ? [] : ['--start-maximized']),
        ],
        defaultViewport: headless ? { width: 1280, height: 720 } : null,
    };
}

export function describePuppeteerMode() {
    const inDocker = fs.existsSync('/.dockerenv');
    if (process.env.PROXY_HEADLESS === 'true' || inDocker) {
        return inDocker ? 'headless (docker)' : 'headless';
    }
    return 'visible';
}
