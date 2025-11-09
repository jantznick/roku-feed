import puppeteer from 'puppeteer';
import fs from 'fs';

const LIVE_MATCHES_URL = 'https://streamed.pk/api/matches/live';
const STREAM_API_BASE_URL = 'https://streamed.pk/api/stream';

async function getLiveStreams(categories) {
    try {
        console.log('Fetching live matches...');
        const matchesResponse = await fetch(LIVE_MATCHES_URL);
        if (!matchesResponse.ok) throw new Error(`API returned status ${matchesResponse.status}`);
        const matches = await matchesResponse.json();

        const sportGames = matches.filter(match => categories.includes(match.category) && match.sources && match.sources.length > 0);

        if (sportGames.length === 0) {
            console.log('No live games for the specified categories with available sources found.');
            return [];
        }

        console.log(`Found ${sportGames.length} games across specified categories. Fetching initial stream info...`);
        const allGameStreams = [];

        for (const game of sportGames) {
            try {
                console.log(`---\nProcessing game: ${game.title}`);
                const allEmbedUrls = [];
                
                // Iterate over ALL sources for a game
                for (const source of game.sources) {
                    console.log(`-- Using source: ${source.source}, ID: ${source.id}`);
                    try {
                        const streamApiUrl = `${STREAM_API_BASE_URL}/${source.source}/${source.id}`;
                        const streamsResponse = await fetch(streamApiUrl);
                        if (!streamsResponse.ok) {
                            console.warn(`---- Stream API for source "${source.source}" returned status ${streamsResponse.status}. Skipping.`);
                            continue;
                        }
                        const streams = await streamsResponse.json();

                        if (streams && streams.length > 0) {
                            const embedUrls = streams.map(stream => stream.embedUrl);
                            allEmbedUrls.push(...embedUrls);
                            console.log(`---- Found ${embedUrls.length} embed URLs from this source.`);
                        }
                    } catch (sourceError) {
                        console.warn(`---- Error processing source "${source.source}": ${sourceError.message}`);
                    }
                }

                if (allEmbedUrls.length > 0) {
                    // Prioritize URLs from the known working domain
                    allEmbedUrls.sort((a, b) => {
                        const aIsPreferred = a.includes('gg.poocloud.in');
                        const bIsPreferred = b.includes('gg.poocloud.in');
                        if (aIsPreferred && !bIsPreferred) return -1;
                        if (!aIsPreferred && bIsPreferred) return 1;
                        return 0;
                    });

                    allGameStreams.push({
                        title: game.title,
                        category: game.category,
                        embedUrls: allEmbedUrls
                    });
                    console.log(`Successfully found a total of ${allEmbedUrls.length} embed URLs for this game. Prioritized 'gg.poocloud.in'.`);
                } else {
                    console.log('No streams found for this game from any source.');
                }
            } catch (gameError) {
                console.error(`Could not process game "${game.title}": ${gameError.message}`);
            }
        }
        
        return allGameStreams;

    } catch (error) {
        console.error('An error occurred while fetching stream data:', error.message);
        return [];
    }
}

async function getFinalStreamUrl(browser, embedUrl) {
    console.log(`-- Navigating to embed URL: ${embedUrl}`);
    const page = await browser.newPage();
    await page.setCacheEnabled(false);
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36');

    const streamInfoPromise = new Promise((resolve) => {
        const requestListener = (request) => {
            const url = request.url();
            if (url.includes('.m3u8') || url.includes('.mpd')) {
                console.log(`[SUCCESS] Intercepted stream manifest request: ${url}`);
                const headers = request.headers();
                page.off('request', requestListener);
                resolve({
                    streamUrl: url,
                    referer: headers.referer
                });
            }
        };
        page.on('request', requestListener);
    });

    try {
        await page.goto(embedUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        
        console.log('Player page loaded. Looking for play button...');
        const buttonInfo = await findPlayButton(page);
        
        if (buttonInfo && !buttonInfo.isPlaying) {
            console.log('Found play button. Clicking it...');
            const { button, frame } = buttonInfo;
            await frame.evaluate(btn => btn.click(), button);
        } else if (buttonInfo && buttonInfo.isPlaying) {
            console.log('Video is already playing.');
        } else {
            console.log('No play button found. Waiting for stream to load automatically...');
        }

        const streamInfo = await Promise.race([
            streamInfoPromise,
            new Promise(resolve => setTimeout(() => resolve(null), 15000))
        ]);

        return streamInfo;
    } catch (error) {
        console.error(`Error processing embed ${embedUrl}: ${error.message}`);
        return null;
    } finally {
        if (!page.isClosed()) await page.close();
    }
}

async function findPlayButton(page) {
    const playSelectors = ['#player .play-button', '.play-btn', '[aria-label="Play"]', '.jw-video.jw-reset'];
    const pauseSelectors = ['[aria-label="Pause"]', '.vjs-playing'];

    for (const frame of [page.mainFrame(), ...page.frames()]) {
        for (const selector of pauseSelectors) {
            const button = await frame.$(selector);
            if (button) {
                console.log(`Found pause button with selector: ${selector}. Video is likely playing.`);
                return { button: null, frame: null, isPlaying: true };
            }
        }
        for (const selector of playSelectors) {
            const button = await frame.$(selector);
            if (button) {
                console.log(`Found play button with selector: ${selector}`);
                return { button, frame, isPlaying: false };
            }
        }
    }
    return null;
}

async function main() {
    const sportsCategories = ['golf', 'basketball', 'american-football', 'baseball', 'hockey', 'football'];
    console.log(`Searching for live games in categories: ${sportsCategories.join(', ')}`);

    const allGames = await getLiveStreams(sportsCategories);
    if (allGames.length === 0) {
        console.log('\nCould not extract any streams for the specified categories.');
        return;
    }

    const gamesToProcess = allGames;
    console.log(`\n--- Processing all ${gamesToProcess.length} found games... ---`);
    
    const browser = await puppeteer.launch({ headless: true });

    browser.on('targetcreated', async (target) => {
        if (target.opener()) {
            const newPage = await target.page();
            if (newPage && !newPage.isClosed()) {
                try {
                    await newPage.close();
                } catch (e) { /* Ignore */ }
            }
        }
    });
    
    for (const game of gamesToProcess) {
        console.log(`\nProcessing game: ${game.title} (Category: ${game.category})`);
        game.finalStreamInfo = [];
        for (const embedUrl of game.embedUrls) {
            const finalInfo = await getFinalStreamUrl(browser, embedUrl);
            if (finalInfo) {
                game.finalStreamInfo.push(finalInfo);
                // If we found a preferred stream, we can stop searching for this game.
                if (finalInfo.streamUrl.includes('gg.poocloud.in')) {
                    console.log('-- Found preferred stream domain. Moving to next game.');
                    break;
                }
            }
        }
    }

    await browser.close();

    // Transform the data to match the other scraper's format
    const formattedGames = gamesToProcess.map(game => {
        const streamLinks = game.finalStreamInfo.map((info, index) => {
            if (!info) return null;
            return {
                name: `Stream ${index + 1}`,
                url: info.streamUrl,
                headers: {
                    Referer: info.referer
                }
            };
        }).filter(Boolean); // Remove any null entries

        if (streamLinks.length === 0) return null;

        return {
            name: game.title,
            league: game.category.toUpperCase(),
            streamLinks: streamLinks
        };
    }).filter(Boolean);

    const finalJson = JSON.stringify(formattedGames, null, 2);

    console.log('\n\n--- FINAL RESULTS ---');
    console.log(finalJson);

    try {
        fs.writeFileSync('live_streams.json', finalJson);
        console.log('\n[SUCCESS] Successfully wrote results to live_streams.json');
    } catch (e) {
        console.error('\nError writing results to file:', e.message);
    }
}

main();
