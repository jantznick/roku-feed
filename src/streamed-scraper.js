import puppeteer from 'puppeteer';
import fs from 'fs/promises';
import path from 'path';

const LIVE_MATCHES_URL = 'https://streamed.pk/api/matches/live';
const STREAM_API_BASE_URL = 'https://streamed.pk/api/stream';
const SAMPLE_DATA_PATH = path.resolve(process.cwd(), 'data', 'streamed-live-sample.json');

// This function is now exported and will be called by index.js
export async function scrapeStreamedGames(browser, sportsCategories) {
    console.log(`\n--- Scraping Streamed.pk for: ${sportsCategories.join(', ')} ---`);
    
    // 1. Get all game data from the API
    const allGames = await getLiveStreams(sportsCategories);
    if (allGames.length === 0) {
        console.log('No streams found for the specified categories on Streamed.pk.');
        return [];
    }

    console.log(`\n--- Processing ${allGames.length} games from Streamed.pk... ---`);
    
    // 2. Deep scrape to find the final m3u8 URLs
    for (const game of allGames) {
        console.log(`\nProcessing game: ${game.title} (Category: ${game.category})`);
        game.finalStreamInfo = [];
        for (const embedUrl of game.embedUrls) {
            // Stop if we have already found 2 valid streams.
            if (game.finalStreamInfo.length >= 2) {
                console.log('-- Found 2 streams. Moving to next game.');
                break;
            }
            const finalInfo = await getFinalStreamUrl(browser, embedUrl);
            if (finalInfo) {
                game.finalStreamInfo.push(finalInfo);
            }
        }
    }

    // 3. Transform the data into the final format for the main feed
    const dateAdded = new Date().toISOString();
    const formattedGames = allGames.map(game => {
        const streamLinks = game.finalStreamInfo.map((info, index) => {
            if (!info) return null;
            return {
                name: `Stream ${index + 1}`,
                url: info.streamUrl,
                headers: {
                    Referer: info.referer
                }
            };
        }).filter(Boolean);
        console.log(streamLinks);

        if (streamLinks.length === 0) return null;

        // The main feed generator needs teams split for the image generator.
        // We'll make a best-effort attempt to split "Team A vs Team B" titles.
        const teams = game.title.includes(' vs ') ? game.title.split(' vs ') : [game.title, ''];


        return {
            // A stable ID is crucial for state management to detect new/removed games.
            id: `${game.title.replace(/\s+/g, '-')}-${new Date(game.date || Date.now()).toISOString().slice(0, 10)}`,
            name: game.title,
            teams: teams,
            time: new Date(game.date || Date.now()).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
            shortDescription: `Live stream of the ${game.title} match.`,
            releaseDate: new Date(game.date || Date.now()).toISOString(),
            dateAdded: dateAdded,
            league: getLeague(game),
            poster: game.poster, // Pass the poster URL through
            streamLinks: streamLinks
        };
    }).filter(Boolean);

    console.log(`✅ Found and processed ${formattedGames.length} games from Streamed.pk.`);
    return formattedGames;
}

function getLeague(game) {
    if (game.category === 'football' && game.title.includes(':')) {
        return game.title.split(':')[0].trim();
    }
    return game.category.toUpperCase();
}

async function getLiveStreams(categories) {
    try {
        const isDebug = process.env.DEBUG === 'true';
        let matches;

        if (isDebug) {
            console.log('DEBUG MODE: Reading from local sample file for Streamed.pk...');
            try {
                const sampleData = await fs.readFile(SAMPLE_DATA_PATH, 'utf8');
                matches = JSON.parse(sampleData);
            } catch (error) {
                console.error(`Error reading sample file at ${SAMPLE_DATA_PATH}. Please ensure the file has been created.`, error);
                return []; // Return empty array if sample file is missing
            }
        } else {
            console.log('Fetching live matches from Streamed.pk...');
            const matchesResponse = await fetch(LIVE_MATCHES_URL);
            if (!matchesResponse.ok) throw new Error(`API returned status ${matchesResponse.status}`);
            matches = await matchesResponse.json();
        }

        const sportGames = matches.filter(match => categories.includes(match.category) && match.sources && match.sources.length > 0);

        if (sportGames.length === 0) {
            return [];
        }

        const categoryCounts = sportGames.reduce((acc, game) => {
            acc[game.category] = (acc[game.category] || 0) + 1;
            return acc;
        }, {});
        console.log('Games found after filtering by category:', categoryCounts);


        console.log(`Found ${sportGames.length} games across specified categories. Fetching initial stream info...`);
        const allGameStreams = [];

        for (const game of sportGames) {
            try {
                const allEmbedUrls = [];
                
                for (const source of game.sources) {
                    try {
                        const streamApiUrl = `${STREAM_API_BASE_URL}/${source.source}/${source.id}`;
                        const streamsResponse = await fetch(streamApiUrl);
                        if (!streamsResponse.ok) {
                            continue;
                        }
                        const streams = await streamsResponse.json();

                        if (streams && streams.length > 0) {
                            const embedUrls = streams.map(stream => stream.embedUrl);
                            allEmbedUrls.push(...embedUrls);
                        }
                    } catch (sourceError) {
                        // Suppress verbose warnings during normal operation
                    }
                }

                if (allEmbedUrls.length > 0) {
                    // Filter out the domain we want to avoid.
                    const filteredEmbedUrls = allEmbedUrls.filter(url => !url.includes('gg.poocloud.in'));

                    allGameStreams.push({
                        title: game.title,
                        category: game.category,
                        embedUrls: filteredEmbedUrls, // Use the filtered list
                        date: game.date,
                        poster: game.poster
                    });
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
                console.log(`[SUCCESS] Intercepted stream manifest: ${url}`);
                page.off('request', requestListener);
                resolve({
                    streamUrl: url,
                    referer: request.headers().referer
                });
            }
        };
        page.on('request', requestListener);
    });

    try {
        await page.goto(embedUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        
        console.log('-- Player page loaded. Looking for play button...');
        const buttonInfo = await findPlayButton(page);
        
        if (buttonInfo && !buttonInfo.isPlaying) {
            console.log('-- Found play button. Clicking it...');
            const { button, frame } = buttonInfo;
            await frame.evaluate(btn => btn.click(), button);
        } else if (buttonInfo && buttonInfo.isPlaying) {
            console.log('-- Video is already playing.');
        } else {
            console.log('-- No play button found. Waiting for stream to load automatically...');
        }

        const streamInfo = await Promise.race([
            streamInfoPromise,
            new Promise(resolve => setTimeout(() => resolve(null), 15000))
        ]);

        return streamInfo;
    } catch (error) {
        // Suppress verbose errors during normal operation
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
                return { button: null, frame: null, isPlaying: true };
            }
        }
        for (const selector of playSelectors) {
            const button = await frame.$(selector);
            if (button) {
                return { button, frame, isPlaying: false };
            }
        }
    }
    return null;
}

export async function scrape247Channels(browser) {
    console.log(`\n--- Scraping for 24/7 Channels ---`);
    const channelMap = {
        'hockey': ['NHL NETWORK'],
        'baseball': ['MLB TV', 'Marquee Sports Network'],
        'basketball': ['TNT', 'NBA TV'],
        'american-football': ['ESPN USA', 'NFL REDZONE', 'NFL NETWORK']
    };
    
    let allChannels = [];

    for (const sport in channelMap) {
        try {
            const response = await fetch(`https://streamed.pk/api/matches/${sport}`);
            if (!response.ok) continue;

            const sportChannels = await response.json();
            const targetTitles = new Set(channelMap[sport]);

            const foundChannels = sportChannels.filter(channel => targetTitles.has(channel.title));
            allChannels.push(...foundChannels);

        } catch (error) {
            console.error(`  -> Failed to fetch channels for ${sport}:`, error.message);
        }
    }

    if (allChannels.length === 0) {
        console.log('No 24/7 channels found.');
        return [];
    }

    console.log(`\n--- Processing ${allChannels.length} found 24/7 channels... ---`);
    
    // Use the existing deep scrape logic to get the final stream URLs
    for (const channel of allChannels) {
        console.log(`\nProcessing channel: ${channel.title}`);
        channel.embedUrls = [];
        for (const source of channel.sources) {
             try {
                const streamApiUrl = `${STREAM_API_BASE_URL}/${source.source}/${source.id}`;
                const streamsResponse = await fetch(streamApiUrl);
                if (!streamsResponse.ok) continue;
                const streams = await streamsResponse.json();
                if (streams && streams.length > 0) {
                    const filteredUrls = streams.map(s => s.embedUrl).filter(url => !url.includes('gg.poocloud.in'));
                    channel.embedUrls.push(...filteredUrls);
                }
            } catch (e) {}
        }
        
        channel.finalStreamInfo = [];
        for (const embedUrl of channel.embedUrls) {
            // Stop if we have already found 2 valid streams.
            if (channel.finalStreamInfo.length >= 2) {
                console.log('-- Found 2 streams for channel. Moving to next channel.');
                break;
            }
            const finalInfo = await getFinalStreamUrl(browser, embedUrl);
            if (finalInfo) {
                channel.finalStreamInfo.push(finalInfo);
            }
        }
    }

    // Format the channels into the standard game object
    const formattedChannels = allChannels.map(channel => {
        const streamLinks = channel.finalStreamInfo.map((info, index) => {
            if (!info) return null;
            return {
                name: `Stream ${index + 1}`,
                url: info.streamUrl,
                headers: { Referer: info.referer }
            };
        }).filter(Boolean);

        if (streamLinks.length === 0) return null;
        
        return {
            id: channel.id, // Use the stable ID from the API
            name: channel.title,
            teams: [channel.title, ''], // For image generation
            time: '24/7',
            shortDescription: 'Live 24/7 Channel',
            releaseDate: new Date().toISOString(),
            dateAdded: new Date().toISOString(),
            league: '24/7 Channels', // Assign to the new league
            poster: channel.poster,
            streamLinks: streamLinks
        };
    }).filter(Boolean);

    console.log(`✅ Found and processed ${formattedChannels.length} 24/7 channels.`);
    return formattedChannels;
}
