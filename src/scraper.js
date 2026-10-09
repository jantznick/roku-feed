import fs from 'fs/promises';
import { safeClosePage, isBrowserConnected } from './puppeteer-utils.js';
import { mapPool, getEmbedConcurrency } from './async-pool.js';
import { resolveStreamFromEmbed } from './embed-resolver.js';

const SCRAPER_URL = "https://onhockey.tv/";
const DEBUG_FILE_PATH = "debug-output.html";

/** Max resolved streams to keep per onhockey game (mirrors Streamed.pk). */
const MAX_STREAMS_PER_GAME = 5;

/**
 * Providers we know how to turn into playable HLS.
 * onhockey.tv rotated away from fluidtv/brcove toward these labels.
 * Preference order is used when capping streams per game.
 */
const PROVIDER_PREFERENCE = [
    'streamd',  // embed.st — same stack as Streamed.pk
    'plytvme',  // embedsports / buffsports
    'mtchor',   // matchora embeds (reliable HLS)
    'fluidtv',  // direct m3u8 in ?channel=
    'brcove',   // Brightcove
    'vodcast',  // Brightcove-style embeds
    'sportpl',  // sportplus.watch
];

const ACCEPTED_PROVIDERS = new Set(PROVIDER_PREFERENCE);

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
        'streamd', 'plytvme', 'mtchor', 'fluidtv', 'brcove', 'vodcast', 'sportpl',
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
            links.push({
                provider,
                url: rawUrl,
                feedType: currentFeedType,
                name: title || provider,
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

/**
 * Apply stealth-ish defaults before hitting Cloudflare-fronted pages.
 * @param {import('puppeteer').Page} page
 */
async function prepareOnHockeyPage(page) {
    await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9',
    });
    await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
}

/**
 * Wait until the real schedule table is present (not a Cloudflare interstitial).
 * The old schedule_table_eng.php AJAX endpoint now 404s; schedule HTML is inlined
 * in the homepage, but CF challenges still delay #gametable.
 * @param {import('puppeteer').Page} page
 */
async function waitForGameTable(page) {
    await page.waitForFunction(
        () => {
            const title = (document.title || '').toLowerCase();
            if (title.includes('just a moment')) return false;
            return Boolean(document.querySelector('#gametable'));
        },
        { timeout: 90000 }
    );
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
            console.log(`Navigating to ${SCRAPER_URL}...`);
            await prepareOnHockeyPage(page);
            await page.goto(SCRAPER_URL, { waitUntil: "domcontentloaded", timeout: 90000 });
            await waitForGameTable(page);
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
        sourceName: stream.name || stream.provider,
        verbose: true,
    });
    if (!info?.streamUrl) return null;

    return {
        ...stream,
        url: info.streamUrl,
        embedUrl: info.embedUrl || target,
        name: stream.name || stream.provider,
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
    console.log(`Deep scrape complete. Found streams for ${processedGames.length} games.`);
    return processedGames;
}
