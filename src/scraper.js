import puppeteer from 'puppeteer';
import fs from 'fs/promises';
import { safeClosePage } from './puppeteer-utils.js';

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

            if ((provider === 'fluidtv') && rawUrl) {
                // Pass the raw URL and the determined feed type
                links.push({ provider, url: rawUrl, feedType: currentFeedType });
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
            await page.goto(SCRAPER_URL, { waitUntil: "networkidle2", timeout: 60000 });
            console.log("Page loaded.");
            
            // Save the HTML content for debugging purposes
            const htmlContent = await page.content();
            await fs.writeFile('latest-scrape-output.html', htmlContent, 'utf-8');
            console.log("Saved live page content to latest-scrape-output.html");
        }

        const games = await page.evaluate((extractStreamLinksStr) => {
            const evaledExtractStreamLinks = new Function(`return ${extractStreamLinksStr}`)();
            const scrapedGames = [];
            const leaguesToScrape = ["NHL", "NCAA D1 Men", "AHL"];

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
                        scrapedGames.push({
                            id: gameId,
                            name: gameName,
                            time,
                            releaseDate: releaseDateObj.toISOString(),
                            league: leagueName.includes('NCAA') ? 'NCAA' : leagueName.includes('AHL') ? 'AHL' : 'NHL',
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
 * For vodcast links, this function navigates to the embed page
 * and intercepts network requests to find the real .m3u8 stream URL.
 */
async function getVodcastStreamUrl(browser, embedUrl) {
    console.log(`  -> Deep scraping vodcast URL: ${embedUrl}`);
    const page = await browser.newPage();
    let streamUrl = null;

    const streamUrlPromise = new Promise((resolve) => {
        page.on('request', request => {
            if (request.url().endsWith('.m3u8')) {
                console.log(`  --> Found .m3u8 stream: ${request.url()}`);
                streamUrl = request.url();
                resolve(streamUrl);
            }
        });
    });

    try {
        await page.goto(embedUrl, { waitUntil: 'networkidle2', timeout: 20000 });
        // Wait for either the stream URL to be found or a timeout
        await Promise.race([
            streamUrlPromise,
            new Promise(resolve => setTimeout(resolve, 20000)) // 20-second timeout
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
 * @param {puppeteer.Browser} browser The Puppeteer browser instance.
 * @param {any[]} games The games to deep scrape.
 * @returns {Promise<any[]>} A promise that resolves to the list of games with updated stream links.
 */
export async function deepScrapeGames(browser, games) {
    console.log(`Performing deep scrape for ${games.length} new games...`);
    const processedGames = [];

    for (const game of games) {
        const processedStreamLinks = [];
        for (const stream of game.streamLinks) {
            let finalUrl = null;
            // Create a full URL to handle relative paths
            const absoluteUrl = new URL(stream.url, SCRAPER_URL).href;

            if (stream.provider === 'fluidtv') {
                const urlParams = new URLSearchParams(new URL(absoluteUrl).search);
                finalUrl = urlParams.get('channel') || '';
            } else if (stream.provider === 'vodcast') {
                const urlParams = new URLSearchParams(new URL(absoluteUrl).search);
                const channel = urlParams.get('channel');
                let embedUrl;
                if (channel) {
                    // Handle URLs that are protocol-relative (e.g., //voodc.com/...)
                    embedUrl = channel.startsWith('//') ? `https:${channel}` : channel;
                    finalUrl = await getVodcastStreamUrl(browser, embedUrl);
                }
            }
            
            if (finalUrl) {
                processedStreamLinks.push({ ...stream, url: finalUrl });
            }
        }

        if (processedStreamLinks.length > 0) {
            processedGames.push({ ...game, streamLinks: processedStreamLinks });
        }
    }
    console.log(`Deep scrape complete. Found streams for ${processedGames.length} games.`);
    return processedGames;
}
