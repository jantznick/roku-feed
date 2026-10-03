import puppeteer from 'puppeteer';
import fs from 'fs/promises';
import { safeClosePage, isBrowserConnected } from './puppeteer-utils.js';
import { mapPool, getEmbedConcurrency } from './async-pool.js';

const SCRAPER_URL = "https://onhockey.tv/";
const DEBUG_FILE_PATH = "debug-output.html";

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
 * Parses a "gamelinks" div to find stream links, including their feed type (home/away).
 * This is a direct port of the logic from the old, working script.
 * This is designed to be executed in the browser's context.
 */
function extractStreamLinks(gameLinksDiv) {
    if (!gameLinksDiv) return [];

    const links = [];
    let currentFeedType = 'main'; // Default feed type

    // Iterate over all child nodes to correctly identify text nodes like "home feed:"
    gameLinksDiv.childNodes.forEach(node => {
        // If the node is a text node, check if it indicates a feed type
        if (node.nodeType === Node.TEXT_NODE) {
            const text = node.textContent?.trim().toLowerCase();
            if (text?.startsWith('home feed')) {
                currentFeedType = 'home';
            } else if (text?.startsWith('away feed')) {
                currentFeedType = 'away';
            }
        }

        // If the node is an element, check if it's a stream link
        if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'A') {
            const anchor = node;
            const provider = anchor.textContent?.trim().toLowerCase();
            const rawUrl = anchor.getAttribute('href');

            if ((provider === 'fluidtv' || provider === 'vodcast' || provider === 'brcove') && rawUrl) {
                // Pass the raw URL and the determined feed type
                links.push({
                    provider,
                    url: rawUrl,
                    feedType: currentFeedType,
                    name: provider,
                });
            }
        }
    });

    return links;
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
            // domcontentloaded + explicit wait: networkidle2 often finishes on Cloudflare's
            // interstitial before #gametable exists.
            await page.setUserAgent(
                'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            );
            await page.goto(SCRAPER_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
            await page.waitForSelector('#gametable', { timeout: 60000 });
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

            leaguesToScrape.forEach(leagueName => {
                const allTBodies = Array.from(document.querySelectorAll("#content > #gametable > tbody"));
                const leagueTBody = allTBodies.find(tbody => {
                    const header = tbody.querySelector("tr:first-child > td > b");
                    return header && header.textContent?.trim() === leagueName;
                });

                if (!leagueTBody) return;

                const gameRows = leagueTBody.querySelectorAll("tr.game");

                gameRows.forEach((row) => {
                    // Find the game's date by looking for the nearest preceding date row
                    let dateText = '';
                    let previousRow = row.previousElementSibling;
                    while (previousRow) {
                        if (previousRow.classList.contains('date')) {
                            dateText = previousRow.querySelector('td:nth-child(2)').textContent.trim();
                            break;
                        }
                        previousRow = previousRow.previousElementSibling;
                    }

                    const columns = row.querySelectorAll("td");
                    if (columns.length < 2) return;

                    const time = columns[0].textContent?.trim() || "N/A";
                    const teamsText = columns[1].childNodes[0].textContent?.trim();
                    const baseTeams = teamsText ? teamsText.split(" - ") : [];
                    const gameName = baseTeams.join(" vs ");

                    // Create a more robust unique ID using the game name and date
                    const gameId = `${gameName}-${dateText}`.replace(/\s+/g, '-').replace(/-$/, '');

                    const dateStringAttempt = `${dateText.split(', ')[1]} ${new Date().getFullYear()} ${time || '00:00'}:00 UTC`;
                    let releaseDateObj = new Date(dateStringAttempt);

                    // Final validation. If parsing fails for any reason, use now as a fallback.
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
                            streamLinks: streams
                        });
                    }
                });
            });

            return scrapedGames;
        }, extractStreamLinks.toString());

        // Convert all game times from UTC to CST before returning
        const processedGames = games.map(game => ({
            ...game,
            time: convertUtcToCst(game.time)
        }));

        console.log(`Found ${processedGames.length} total games on the main page.`);
        return processedGames;

    } catch (error) {
        console.error(`An error occurred during main page scraping:`, error);
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
            for (const stream of game.streamLinks) {
                if (!isBrowserConnected(browser)) {
                    break;
                }

                let finalUrl = null;
                const absoluteUrl = new URL(stream.url, SCRAPER_URL).href;

                if (stream.provider === 'fluidtv') {
                    const urlParams = new URLSearchParams(new URL(absoluteUrl).search);
                    finalUrl = urlParams.get('channel') || '';
                } else if (stream.provider === 'vodcast' || stream.provider === 'brcove') {
                    const urlParams = new URLSearchParams(new URL(absoluteUrl).search);
                    const channel = urlParams.get('channel');
                    if (channel) {
                        const embedUrl = channel.startsWith('//') ? `https:${channel}` : channel;
                        finalUrl = await getEmbedStreamUrl(browser, embedUrl, stream.provider);
                    }
                }

                if (finalUrl) {
                    processedStreamLinks.push({
                        ...stream,
                        url: finalUrl,
                        name: stream.name || stream.provider,
                    });
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
