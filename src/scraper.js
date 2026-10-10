import fs from 'fs/promises';
import path from 'path';
import { safeClosePage, isBrowserConnected } from './puppeteer-utils.js';
import { mapPool, getEmbedConcurrency } from './async-pool.js';
import { resolveStreamFromEmbed } from './embed-resolver.js';

const SCRAPER_URL = "https://onhockey.tv/";
const DEBUG_FILE_PATH = "debug-output.html";
const CF_COOKIE_PATH = path.resolve(process.cwd(), 'data', 'onhockey-cf-cookies.json');

/** Max resolved streams to keep per onhockey game (mirrors Streamed.pk). */
const MAX_STREAMS_PER_GAME = 5;

/**
 * Providers we know how to turn into playable HLS.
 * Preference order is used when capping streams per game (deep scrape is expensive).
 *
 * Status (from browser walks + home-server runs):
 * - mtchor   → matchora.to — works (baseline)
 * - fluidtv  → direct m3u8 in ?channel= — works when present
 * - streamd  → embed.st — works; needs #dontfoid strip + JW/play click
 * - plytvme  → embedsports.me — works only via parent iframe (direct = blocked);
 *              nested dervlin JW player. Headless Chrome often gets dervlin
 *              "Network Error"; visible Chrome / xvfb works.
 * - sportpl  → sportplus.watch game pages — US often geo-blocked ("restrictions
 *              in your country"); fail-fast when blocked, resolve when player exists
 * - brcove / vodcast → Brightcove playback API
 *
 * Common on schedule but not accepted yet: damitv, ddlive, lovecdn, …
 */
const PROVIDER_PREFERENCE = [
    'mtchor',
    'fluidtv',
    'streamd',
    'plytvme',
    'sportpl',
    'brcove',
    'vodcast',
];

const ACCEPTED_PROVIDERS = new Set(PROVIDER_PREFERENCE);

/** Titles onhockey sometimes puts on external links — not useful stream names. */
function cleanStreamName(title, provider) {
    const trimmed = title?.trim();
    if (!trimmed) return provider;
    if (/opens in a new tab/i.test(trimmed)) return provider;
    return trimmed;
}

/**
 * Converts a UTC time string (HH:mm) to CST by subtracting 6 hours.
 * @param {string} utcTime - The time string in "HH:mm" format.
 * @returns {string} The converted time string in "HH:mm" format.
 */
function convertUtcToCst(utcTime) {
    if (!utcTime || utcTime === "N/A") return "N/A";

    const parts = utcTime.split(':');
    if (parts.length !== 2) return utcTime; // Return original if format is unexpected

    let hour = parseInt(parts[0], 10);
    const minute = parts[1];

    if (isNaN(hour)) return utcTime;

    hour -= 6;
    if (hour < 0) {
        hour += 24;
    }

    const newHour = hour.toString().padStart(2, '0');
    return `${newHour}:${minute}`;
}

/**
 * Parses a "gamelinks" div to find stream links, including feed / network labels.
 * Designed to be executed in the browser's context (serialized via .toString()).
 * Keep all constants inline — outer-scope bindings will not exist in page.evaluate.
 */
function extractStreamLinks(gameLinksDiv) {
    if (!gameLinksDiv) return [];

    // Must stay in sync with PROVIDER_PREFERENCE in scraper.js module scope.
    const accepted = new Set([
        'mtchor', 'fluidtv', 'streamd', 'plytvme', 'sportpl', 'brcove', 'vodcast',
    ]);

    const links = [];
    let currentFeedType = 'main';

    gameLinksDiv.childNodes.forEach((node) => {
        if (node.nodeType === Node.TEXT_NODE) {
            const text = node.textContent?.trim().toLowerCase();
            if (!text) return;
            // Legacy home/away labels, plus modern network section labels ("ABC:", "SN:", "russian:")
            if (text.startsWith('home feed')) {
                currentFeedType = 'home';
            } else if (text.startsWith('away feed')) {
                currentFeedType = 'away';
            } else if (text.endsWith(':')) {
                currentFeedType = text.replace(/:$/, '').trim() || 'main';
            }
            return;
        }

        if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'A') {
            const anchor = node;
            const provider = anchor.textContent?.trim().toLowerCase();
            const rawUrl = anchor.getAttribute('href');
            if (!provider || !rawUrl || !accepted.has(provider)) return;

            const title = anchor.getAttribute('title')?.trim();
            const junkTitle = title && /opens in a new tab/i.test(title);
            links.push({
                provider,
                url: rawUrl,
                feedType: currentFeedType,
                name: (!title || junkTitle) ? provider : title,
            });
        }

        // Section labels sometimes wrap in <br>english(int):</br>-style siblings; also
        // catch bare label elements that aren't anchors.
        if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'BR') {
            // no-op; next text node updates feed type
        }
    });

    return links;
}

/**
 * Rank streams so English / known-good providers are deep-scraped first.
 * @param {{ provider: string, name?: string, feedType?: string }} stream
 */
function streamPreferenceScore(stream) {
    const providerIdx = PROVIDER_PREFERENCE.indexOf(stream.provider);
    const providerScore = providerIdx === -1 ? 100 : providerIdx;

    const label = `${stream.feedType || ''} ${stream.name || ''}`.toLowerCase();
    // Deprioritize clearly non-English sections when capping.
    const nonEnglish =
        /\b(russian|swedish|czech|german|danish|french\(fr\)|polish|spanish|portuguese|dutch|croatian|bulgarian|finnish)\b/.test(
            label
        );
    const englishBoost = nonEnglish ? 50 : 0;

    return providerScore + englishBoost;
}

/**
 * Cap and order stream candidates before expensive deep scrapes.
 * @param {any[]} streams
 */
function prioritizeStreams(streams) {
    return [...streams]
        .sort((a, b) => streamPreferenceScore(a) - streamPreferenceScore(b))
        .slice(0, MAX_STREAMS_PER_GAME);
}

/**
 * Unwrap onhockey link hrefs into a direct embed / m3u8 URL.
 * Handles np_*.php?channel=..., protocol-relative //host/..., and absolute URLs.
 * @param {string} href
 * @returns {string|null}
 */
function unwrapOnHockeyTarget(href) {
    if (!href) return null;

    try {
        const absolute = new URL(href, SCRAPER_URL);
        const channel = absolute.searchParams.get('channel');
        if (channel) {
            if (channel.startsWith('//')) return `https:${channel}`;
            return channel;
        }
        if (href.startsWith('//')) return `https:${href}`;
        return absolute.href;
    } catch {
        if (href.startsWith('//')) return `https:${href}`;
        return href;
    }
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Max times we'll yank the schedule tab back to onhockey if adware hijacks it. */
const MAX_ADWARE_RECOVERIES = 20;

/**
 * True when the URL is still on onhockey (or a harmless transitional URL).
 * Adware campaigns often replace the main frame with mcafee / random click domains.
 * @param {string} url
 */
function isOnHockeyScheduleUrl(url) {
    if (!url || url === 'about:blank' || url.startsWith('chrome-error://')) return true;
    try {
        const { hostname, protocol } = new URL(url);
        if (protocol !== 'http:' && protocol !== 'https:') return true;
        const host = hostname.replace(/^www\./i, '').toLowerCase();
        return host === 'onhockey.tv' || host.endsWith('.onhockey.tv');
    } catch {
        return false;
    }
}

/**
 * Keep the schedule tab on onhockey.tv while the list page loads.
 * onhockey injects adware that (1) replaces the main frame and/or (2) opens junk tabs.
 * Guard is schedule-load only — dispose before deep-scrape embeds open other origins.
 *
 * @param {import('puppeteer').Browser} browser
 * @param {import('puppeteer').Page} page
 */
async function installOnHockeyStayGuard(browser, page) {
    let active = true;
    let recovering = false;
    let redirectCount = 0;

    await page.evaluateOnNewDocument(() => {
        try {
            window.open = () => null;
        } catch {
            // ignore
        }
    });

    const onTargetCreated = async (target) => {
        if (!active || target.type() !== 'page') return;
        try {
            const popup = await target.page();
            if (!popup || popup === page) return;
            const url = (target.url() || popup.url() || '').slice(0, 120);
            console.warn(`  … closing popup during schedule load: ${url || '(blank)'}`);
            await popup.close().catch(() => {});
        } catch {
            // target may already be gone
        }
    };
    browser.on('targetcreated', onTargetCreated);

    async function recoverIfHijacked() {
        if (!active || recovering) return false;
        if (page.isClosed()) return false;

        let url = '';
        try {
            url = page.url();
        } catch {
            return false;
        }
        if (isOnHockeyScheduleUrl(url) || !/^https?:/i.test(url)) return false;

        if (redirectCount >= MAX_ADWARE_RECOVERIES) {
            console.warn(
                `  … adware redirected main frame ${redirectCount} times; giving up recoveries`
            );
            return false;
        }

        recovering = true;
        redirectCount += 1;
        console.warn(
            `  … main frame left onhockey (${url.slice(0, 100)}); returning (#${redirectCount})`
        );
        try {
            await page.goto(SCRAPER_URL, {
                waitUntil: 'domcontentloaded',
                timeout: 90000,
                referer: 'https://www.google.com/',
            });
            await sleep(1000 + Math.random() * 500);
        } catch (error) {
            console.warn(`  … adware recovery navigation failed: ${error.message}`);
        } finally {
            recovering = false;
        }
        return true;
    }

    const onFrameNavigated = (frame) => {
        if (!active || frame !== page.mainFrame()) return;
        // Fire-and-forget; wait loop also polls recoverIfHijacked.
        recoverIfHijacked().catch(() => {});
    };
    page.on('framenavigated', onFrameNavigated);

    return {
        recoverIfHijacked,
        get redirectCount() {
            return redirectCount;
        },
        dispose() {
            active = false;
            // Puppeteer Browser uses EventEmitter-style `.off`; Page may vary by version.
            for (const [emitter, event, handler] of [
                [browser, 'targetcreated', onTargetCreated],
                [page, 'framenavigated', onFrameNavigated],
            ]) {
                try {
                    if (typeof emitter.off === 'function') emitter.off(event, handler);
                    else if (typeof emitter.removeListener === 'function') {
                        emitter.removeListener(event, handler);
                    }
                } catch {
                    // ignore
                }
            }
        },
    };
}

/**
 * Build a desktop Chrome UA that matches the launched browser's version.
 * A stale major (e.g. Chrome/131 on Chrome 154) trips Cloudflare fingerprints.
 * @param {import('puppeteer').Browser} browser
 */
async function chromeUserAgentForBrowser(browser) {
    const version = await browser.version(); // e.g. "Chrome/154.0.8037.92" or "HeadlessChrome/..."
    const full = (version.match(/(\d+\.\d+\.\d+\.\d+)/) || [])[1];
    const major = (version.match(/(\d+)\./) || [])[1] || '154';
    const chromeVer = full || `${major}.0.0.0`;
    return {
        userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVer} Safari/537.36`,
        major,
        fullVersion: chromeVer,
    };
}

/**
 * Apply browser defaults before hitting Cloudflare-fronted pages.
 * Stealth plugin is applied at launch; this aligns UA/client-hints + locale.
 * @param {import('puppeteer').Page} page
 */
async function prepareOnHockeyPage(page) {
    const { userAgent, major, fullVersion } = await chromeUserAgentForBrowser(page.browser());
    await page.setUserAgent(userAgent);
    // Keep Sec-CH-UA* consistent with the UA string (setUserAgent alone often doesn't).
    try {
        const client = await page.createCDPSession();
        await client.send('Network.setUserAgentOverride', {
            userAgent,
            acceptLanguage: 'en-US,en;q=0.9',
            platform: 'Win32',
            userAgentMetadata: {
                brands: [
                    { brand: 'Not:A-Brand', version: '24' },
                    { brand: 'Chromium', version: major },
                    { brand: 'Google Chrome', version: major },
                ],
                fullVersionList: [
                    { brand: 'Not:A-Brand', version: '10.0.0.0' },
                    { brand: 'Chromium', version: fullVersion },
                    { brand: 'Google Chrome', version: fullVersion },
                ],
                fullVersion,
                platform: 'Windows',
                platformVersion: '15.0.0',
                architecture: 'x86',
                model: '',
                mobile: false,
                bitness: '64',
                wow64: false,
            },
        });
    } catch {
        // Older Chromium builds may reject userAgentMetadata — UA string still applied.
    }
    await page.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    });
    try {
        await page.emulateTimezone('America/Chicago');
    } catch {
        // timezone API unavailable in some Chromium builds
    }
}

/**
 * Normalize cookies from disk for page.setCookie (drop expired / unsupported fields).
 * @param {any[]} cookies
 */
function sanitizeCfCookies(cookies) {
    if (!Array.isArray(cookies)) return [];
    const nowSec = Date.now() / 1000;
    return cookies
        .filter((cookie) => {
            if (!cookie?.name || cookie.value == null) return false;
            // Domain required so setCookie works before the first navigation.
            if (!cookie.domain) return false;
            if (typeof cookie.expires === 'number' && cookie.expires > 0 && cookie.expires <= nowSec) {
                return false;
            }
            return true;
        })
        .map((cookie) => {
            const out = {
                name: cookie.name,
                value: cookie.value,
                domain: cookie.domain,
                path: cookie.path || '/',
            };
            if (typeof cookie.expires === 'number' && cookie.expires > 0) out.expires = cookie.expires;
            if (typeof cookie.httpOnly === 'boolean') out.httpOnly = cookie.httpOnly;
            if (typeof cookie.secure === 'boolean') out.secure = cookie.secure;
            if (cookie.sameSite === 'Strict' || cookie.sameSite === 'Lax' || cookie.sameSite === 'None') {
                out.sameSite = cookie.sameSite;
            }
            return out;
        });
}

/**
 * Read saved Cloudflare cookies from disk (expired entries stripped).
 * @returns {Promise<object[]>}
 */
async function readSavedCfCookies() {
    try {
        const raw = await fs.readFile(CF_COOKIE_PATH, 'utf8');
        return sanitizeCfCookies(JSON.parse(raw));
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.warn(`Could not load onhockey cookies: ${error.message}`);
        }
        return [];
    }
}

/**
 * Drop Cloudflare clearance cookies from the page (and optionally from disk).
 * @param {import('puppeteer').Page} page
 * @param {{ unlinkFile?: boolean }} [opts]
 */
async function clearCfCookies(page, { unlinkFile = false } = {}) {
    try {
        const cookies = await page.cookies(SCRAPER_URL);
        for (const cookie of cookies) {
            if (cookie.name === 'cf_clearance' || cookie.name.startsWith('__cf')) {
                await page.deleteCookie(cookie);
            }
        }
    } catch {
        // ignore
    }
    if (unlinkFile) {
        try {
            await fs.unlink(CF_COOKIE_PATH);
        } catch (error) {
            if (error.code !== 'ENOENT') {
                console.warn(`Could not remove saved onhockey cookies: ${error.message}`);
            }
        }
    }
}

/**
 * Persist cookies after a successful schedule load (cf_clearance, etc.).
 * @param {import('puppeteer').Page} page
 */
async function saveCfCookies(page) {
    try {
        const cookies = await page.cookies(SCRAPER_URL);
        if (cookies.length === 0) return;
        await fs.mkdir(path.dirname(CF_COOKIE_PATH), { recursive: true });
        await fs.writeFile(CF_COOKIE_PATH, JSON.stringify(cookies, null, 2), 'utf8');
        const cleared = cookies.some((c) => c.name === 'cf_clearance');
        console.log(
            `Saved ${cookies.length} onhockey cookie(s)` +
                (cleared ? ' (includes cf_clearance)' : '')
        );
    } catch (error) {
        console.warn(`Could not save onhockey cookies: ${error.message}`);
    }
}

/**
 * Snapshot whether we are still on a Cloudflare challenge page.
 * @param {import('puppeteer').Page} page
 */
async function getChallengeState(page) {
    return page.evaluate(() => {
        const title = (document.title || '').toLowerCase();
        const bodyText = (document.body?.innerText || '').slice(0, 500).toLowerCase();
        const hasTable = Boolean(document.querySelector('#gametable'));
        const challengeUi = Boolean(
            document.querySelector(
                '#challenge-form, #cf-challenge-running, .cf-browser-verification, iframe[src*="challenges.cloudflare.com"]'
            )
        );
        const justAMoment =
            title.includes('just a moment') ||
            bodyText.includes('just a moment') ||
            bodyText.includes('checking your browser') ||
            bodyText.includes('verify you are human');
        return { title: document.title || '', hasTable, challengeUi, justAMoment, url: location.href };
    });
}

/**
 * Wait until #gametable appears, giving Cloudflare time to finish its JS challenge.
 * Polls so we can log progress instead of a silent hang.
 * If clearance cookies look stale (still challenged after a while), clears them and
 * reloads once — without a full multi-attempt loop.
 * @param {import('puppeteer').Page} page
 * @param {{ timeoutMs?: number, allowStaleCookieReload?: boolean, stayGuard?: { recoverIfHijacked: () => Promise<boolean>, redirectCount: number } }} [opts]
 */
async function waitForGameTable(
    page,
    { timeoutMs = 120000, allowStaleCookieReload = false, stayGuard = null } = {}
) {
    const deadline = Date.now() + timeoutMs;
    let lastLog = 0;
    let didStaleReload = false;
    const startedAt = Date.now();

    while (Date.now() < deadline) {
        if (stayGuard) {
            await stayGuard.recoverIfHijacked();
        }

        const state = await getChallengeState(page);
        const onOnHockey = isOnHockeyScheduleUrl(state.url || page.url());
        if (state.hasTable && !state.justAMoment && onOnHockey) {
            return state;
        }

        const challenged = state.justAMoment || state.challengeUi;
        const elapsed = Date.now() - startedAt;

        // Stale cf_clearance often sticks on the interstitial; one clean reload beats 3 full retries.
        if (
            allowStaleCookieReload &&
            !didStaleReload &&
            challenged &&
            onOnHockey &&
            elapsed > 20000
        ) {
            didStaleReload = true;
            console.warn(
                '  … Cloudflare still challenging after saved cookies; clearing cf_clearance and reloading once'
            );
            await clearCfCookies(page, { unlinkFile: true });
            await page.reload({
                waitUntil: 'domcontentloaded',
                timeout: 90000,
            });
            await sleep(2000 + Math.random() * 1500);
            continue;
        }

        const now = Date.now();
        if (now - lastLog > 10000) {
            lastLog = now;
            const secs = Math.round(elapsed / 1000);
            const redirects = stayGuard?.redirectCount ? ` adwareRecoveries=${stayGuard.redirectCount}` : '';
            console.log(
                `  … waiting for onhockey schedule (${secs}s)` +
                    ` title="${state.title}" challenge=${challenged}` +
                    ` url=${(state.url || '').slice(0, 60)}${redirects}`
            );
        }

        // Tiny mouse nudge — some CF bots look for input events during the challenge.
        try {
            await page.mouse.move(120 + Math.random() * 40, 160 + Math.random() * 40);
        } catch {
            // ignore
        }

        await sleep(1500);
    }

    const finalState = await getChallengeState(page).catch(() => ({}));
    const redirects = stayGuard?.redirectCount ? ` adwareRecoveries=${stayGuard.redirectCount}` : '';
    throw new Error(
        `Timed out waiting for #gametable` +
            ` (title="${finalState.title || ''}"` +
            ` url="${(finalState.url || page.url() || '').slice(0, 80)}"${redirects})`
    );
}

/**
 * Load onhockey homepage and wait for #gametable (single attempt + cookie reuse).
 * Installs a short-lived stay-guard so adware cannot replace the main frame / spawn tabs.
 * @param {import('puppeteer').Page} page
 */
async function navigateToOnHockeySchedule(page) {
    const savedCookies = await readSavedCfCookies();
    const hasSavedCookies = savedCookies.length > 0;
    const stayGuard = await installOnHockeyStayGuard(page.browser(), page);

    try {
        if (hasSavedCookies) {
            try {
                await page.setCookie(...savedCookies);
                console.log(
                    `Loaded ${savedCookies.length} saved onhockey cookie(s) from ${path.basename(CF_COOKIE_PATH)}`
                );
            } catch (error) {
                console.warn(`Could not apply saved onhockey cookies: ${error.message}`);
            }
        }

        console.log(`Navigating to ${SCRAPER_URL} (single attempt)...`);
        await page.goto(SCRAPER_URL, {
            waitUntil: 'domcontentloaded',
            timeout: 90000,
            referer: 'https://www.google.com/',
        });
        await stayGuard.recoverIfHijacked();

        // Let the challenge script start before we poll.
        await sleep(2000 + Math.random() * 1500);
        await waitForGameTable(page, {
            timeoutMs: 120000,
            allowStaleCookieReload: hasSavedCookies,
            stayGuard,
        });
        await saveCfCookies(page);
        if (stayGuard.redirectCount > 0) {
            console.log(
                `Schedule loaded after ${stayGuard.redirectCount} adware main-frame recovery(ies).`
            );
        }
    } finally {
        stayGuard.dispose();
    }
}

/**
 * Scrapes the main page to get a list of all available games.
 * @param {puppeteer.Browser} browser The puppeteer browser instance.
 * @returns {Promise<any[]>} A promise that resolves to an array of scraped games.
 */
export async function scrapeMainPage(browser) {
    const page = await browser.newPage();
    const isDebug = process.env.DEBUG === 'true';

    try {
        if (isDebug) {
            console.log("... Running in DEBUG mode ...");
            const fileContent = await fs.readFile(DEBUG_FILE_PATH, 'utf-8');
            await page.setContent(fileContent);
            console.log(`Loaded content from ${DEBUG_FILE_PATH}`);
        } else {
            await prepareOnHockeyPage(page);
            await navigateToOnHockeySchedule(page);
            console.log("Page loaded.");

            // Save the HTML content for debugging purposes
            const htmlContent = await page.content();
            await fs.writeFile('latest-scrape-output.html', htmlContent, 'utf-8');
            console.log("Saved live page content to latest-scrape-output.html");
        }

        const games = await page.evaluate((extractStreamLinksStr) => {
            const evaledExtractStreamLinks = new Function(`return ${extractStreamLinksStr}`)();
            const scrapedGames = [];
            const leaguesToScrape = ["NHL", "NHL Rookie Camp", "NCAA D1 Men", "AHL"];

            /**
             * Dates live in sibling <tbody class="Date"> rows, not inside the league tbody.
             * Walk previous sibling rows first, then previous tbodies.
             */
            function findDateText(row) {
                let previousRow = row.previousElementSibling;
                while (previousRow) {
                    if (previousRow.classList.contains('date')) {
                        return previousRow.querySelector('td:nth-child(2)')?.textContent?.trim() || '';
                    }
                    previousRow = previousRow.previousElementSibling;
                }

                let tbody = row.closest('tbody')?.previousElementSibling;
                while (tbody) {
                    const dateRow = tbody.querySelector('tr.date');
                    if (dateRow) {
                        const text = dateRow.querySelector('td:nth-child(2)')?.textContent?.trim() || '';
                        if (text) return text;
                    }
                    tbody = tbody.previousElementSibling;
                }
                return '';
            }

            leaguesToScrape.forEach((leagueName) => {
                const allTBodies = Array.from(document.querySelectorAll("#content > #gametable > tbody"));
                // A league can appear multiple times (once per date section).
                const leagueTBodies = allTBodies.filter((tbody) => {
                    const header = tbody.querySelector("tr:first-child > td > b");
                    return header && header.textContent?.trim() === leagueName;
                });

                leagueTBodies.forEach((leagueTBody) => {
                    const gameRows = leagueTBody.querySelectorAll("tr.game");

                    gameRows.forEach((row) => {
                        const dateText = findDateText(row);

                        const columns = row.querySelectorAll("td");
                        if (columns.length < 2) return;

                        const time = columns[0].textContent?.trim() || "N/A";
                        const teamsText = columns[1].childNodes[0].textContent?.trim();
                        const baseTeams = teamsText ? teamsText.split(" - ") : [];
                        const gameName = baseTeams.join(" vs ");

                        const gameId = `${gameName}-${dateText}`.replace(/\s+/g, '-').replace(/-$/, '');

                        const dateStringAttempt = `${dateText.split(', ')[1] || dateText} ${new Date().getFullYear()} ${time || '00:00'}:00 UTC`;
                        let releaseDateObj = new Date(dateStringAttempt);

                        if (isNaN(releaseDateObj.getTime())) {
                            console.warn(`-- Failed to parse date for game "${gameName}". Falling back to current time.`);
                            releaseDateObj = new Date();
                        }

                        const gameLinksDiv = row.querySelector(".gamelinks");
                        const streams = evaledExtractStreamLinks(gameLinksDiv);

                        if (streams.length > 0) {
                            let league;
                            if (leagueName.includes('NCAA')) {
                                league = 'NCAA';
                            } else if (leagueName.includes('AHL')) {
                                league = 'AHL';
                            } else if (leagueName.includes('Rookie Camp')) {
                                league = 'NHL Rookie Camp';
                            } else {
                                league = 'NHL';
                            }

                            scrapedGames.push({
                                id: gameId,
                                name: gameName,
                                time,
                                releaseDate: releaseDateObj.toISOString(),
                                league,
                                teams: baseTeams,
                                streamLinks: streams,
                            });
                        }
                    });
                });
            });

            return scrapedGames;
        }, extractStreamLinks.toString());

        const processedGames = games.map((game) => ({
            ...game,
            time: convertUtcToCst(game.time),
            streamLinks: prioritizeStreams(game.streamLinks || []),
        }));

        const providerCounts = {};
        for (const game of processedGames) {
            for (const stream of game.streamLinks) {
                providerCounts[stream.provider] = (providerCounts[stream.provider] || 0) + 1;
            }
        }
        console.log(
            `Found ${processedGames.length} total games on the main page.` +
                (Object.keys(providerCounts).length
                    ? ` Providers: ${JSON.stringify(providerCounts)}`
                    : ' (no accepted stream providers on listed games yet)')
        );
        return processedGames;

    } catch (error) {
        console.error(`An error occurred during main page scraping:`, error);
        try {
            const htmlContent = await page.content();
            await fs.writeFile('latest-scrape-failure.html', htmlContent, 'utf-8');
            console.error('Saved failure HTML to latest-scrape-failure.html');
        } catch {
            // ignore secondary failure
        }
        throw error; // Re-throw to be caught by the main loop
    } finally {
        if (page) await safeClosePage(page);
    }
}

/**
 * True for HLS playlist URLs, including those with query strings.
 * @param {string} url
 */
function isM3u8Url(url) {
    try {
        return new URL(url).pathname.includes('.m3u8');
    } catch {
        return url.includes('.m3u8');
    }
}

/**
 * Prefer a master playlist over a bitrate variant when both appear.
 * @param {string} url
 */
function isLikelyMasterPlaylist(url) {
    try {
        const path = new URL(url).pathname;
        // Brightcove NHL club streams use .../live.m3u8 for the master
        if (/\/live\.m3u8$/i.test(path)) return true;
        // Variant paths often include bitrate tokens like _4000K_ or /4000/
        if (/_\d+k_/i.test(path) || /\/\d{3,5}k?\//i.test(path)) return false;
        return path.endsWith('.m3u8');
    } catch {
        return false;
    }
}

/**
 * Picks the best HLS source from a Brightcove playback API payload.
 * @param {any} payload
 * @returns {string|null}
 */
function pickBrightcoveHlsUrl(payload) {
    const sources = Array.isArray(payload?.sources) ? payload.sources : [];
    const hlsSources = sources
        .map((source) => source?.src)
        .filter((src) => typeof src === 'string' && isM3u8Url(src));
    if (hlsSources.length === 0) return null;
    return hlsSources.find((src) => isLikelyMasterPlaylist(src)) || hlsSources[0];
}

/**
 * Navigates to an embed page (vodcast, Brightcove/brcove, etc.) and
 * resolves the real .m3u8 URL via network interception and/or Brightcove playback API.
 */
async function getEmbedStreamUrl(browser, embedUrl, label = 'embed') {
    console.log(`  -> Deep scraping ${label} URL: ${embedUrl}`);
    const page = await browser.newPage();
    let streamUrl = null;
    let resolveStreamUrl;

    const streamUrlPromise = new Promise((resolve) => {
        resolveStreamUrl = resolve;
    });

    const considerUrl = (candidate, via) => {
        if (!candidate || !isM3u8Url(candidate)) return;
        if (!streamUrl || (isLikelyMasterPlaylist(candidate) && !isLikelyMasterPlaylist(streamUrl))) {
            console.log(`  --> Found .m3u8 stream via ${via}: ${candidate}`);
            streamUrl = candidate;
        }
        if (isLikelyMasterPlaylist(candidate)) {
            resolveStreamUrl(streamUrl);
        }
    };

    page.on('request', (request) => {
        considerUrl(request.url(), 'request');
    });

    page.on('response', async (response) => {
        const responseUrl = response.url();
        if (responseUrl.includes('edge.api.brightcove.com/playback/')) {
            try {
                const payload = await response.json();
                considerUrl(pickBrightcoveHlsUrl(payload), 'brightcove-playback-api');
            } catch {
                // Prefight / empty body — ignore
            }
        }
    });

    try {
        await page.goto(embedUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

        // Brightcove NHL embeds often have autoplay disabled — click play if present.
        try {
            await page.waitForSelector('.vjs-big-play-button, button.vjs-big-play-button', {
                timeout: 5000,
            });
            await page.click('.vjs-big-play-button, button.vjs-big-play-button');
            console.log(`  --> Clicked Brightcove play button`);
        } catch {
            // Not every embed shows a play button; continue waiting for network events.
        }

        await Promise.race([
            streamUrlPromise,
            new Promise((resolve) => setTimeout(resolve, 20000)),
        ]);
    } catch (error) {
        console.error(`  -> Error deep scraping ${embedUrl}:`, error.message);
    } finally {
        await safeClosePage(page);
    }

    return streamUrl;
}

/**
 * Resolve one onhockey stream link to a playable HLS entry (with optional referer).
 * @param {import('puppeteer').Browser} browser
 * @param {{ provider: string, url: string, name?: string, feedType?: string }} stream
 */
async function resolveOnHockeyStream(browser, stream) {
    const target = unwrapOnHockeyTarget(stream.url);
    if (!target) return null;

    // Direct HLS (classic fluidtv): channel=https://.../master.m3u8
    if (isM3u8Url(target)) {
        console.log(`  -> Direct m3u8 from ${stream.provider}: ${target}`);
        return {
            ...stream,
            url: target,
            embedUrl: stream.url,
            name: stream.name || stream.provider,
        };
    }

    // Brightcove still needs the dedicated playback-API path.
    if (stream.provider === 'vodcast' || stream.provider === 'brcove') {
        const finalUrl = await getEmbedStreamUrl(browser, target, stream.provider);
        if (!finalUrl) return null;
        return {
            ...stream,
            url: finalUrl,
            embedUrl: target,
            name: stream.name || stream.provider,
        };
    }

    // Everyone else: same embed interceptor used by Streamed.pk (captures Referer).
    if (!ACCEPTED_PROVIDERS.has(stream.provider)) {
        return null;
    }

    const info = await resolveStreamFromEmbed(browser, target, {
        sourceName: cleanStreamName(stream.name, stream.provider),
        verbose: true,
    });
    if (!info?.streamUrl) {
        console.log(`  -> No m3u8 from ${stream.provider} (${target.slice(0, 80)})`);
        return null;
    }

    return {
        ...stream,
        url: info.streamUrl,
        embedUrl: info.embedUrl || target,
        name: cleanStreamName(stream.name, stream.provider),
        headers: info.referer ? { Referer: info.referer } : undefined,
        requestHeaders: info.requestHeaders || {},
        directFetchOk: Boolean(info.directFetchOk),
        confirmedAt: info.confirmedAt,
    };
}

/**
 * Takes a list of games and performs a "deep scrape" to find the actual stream URLs.
 * Games are processed with bounded concurrency (EMBED_CONCURRENCY); streams within
 * a game stay sequential.
 * @param {puppeteer.Browser} browser The Puppeteer browser instance.
 * @param {any[]} games The games to deep scrape.
 * @returns {Promise<any[]>} A promise that resolves to the list of games with updated stream links.
 */
export async function deepScrapeGames(browser, games) {
    const concurrency = getEmbedConcurrency();
    console.log(
        `Performing deep scrape for ${games.length} new games (concurrency=${concurrency})...`
    );

    const results = await mapPool(
        games,
        concurrency,
        async (game) => {
            if (!isBrowserConnected(browser)) {
                return null;
            }

            const processedStreamLinks = [];
            const candidates = prioritizeStreams(game.streamLinks || []);

            for (const stream of candidates) {
                if (!isBrowserConnected(browser)) {
                    break;
                }
                if (processedStreamLinks.length >= MAX_STREAMS_PER_GAME) {
                    break;
                }

                try {
                    const resolved = await resolveOnHockeyStream(browser, stream);
                    if (resolved) {
                        processedStreamLinks.push(resolved);
                    }
                } catch (error) {
                    console.error(
                        `  -> Failed resolving ${stream.provider} for ${game.name}: ${error.message}`
                    );
                }
            }

            if (processedStreamLinks.length === 0) {
                return null;
            }
            return { ...game, streamLinks: processedStreamLinks };
        },
        { shouldStop: () => !isBrowserConnected(browser) }
    );

    const processedGames = results.filter(Boolean);
    const resolvedProviders = {};
    for (const game of processedGames) {
        for (const stream of game.streamLinks || []) {
            resolvedProviders[stream.provider] =
                (resolvedProviders[stream.provider] || 0) + 1;
        }
    }
    console.log(
        `Deep scrape complete. Found streams for ${processedGames.length}/${games.length} games` +
            (Object.keys(resolvedProviders).length
                ? ` (resolved: ${JSON.stringify(resolvedProviders)})`
                : '')
    );
    return processedGames;
}
