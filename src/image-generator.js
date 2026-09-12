import fs from 'fs/promises';
import path from 'path';
import Fuse from 'fuse.js';
import { Vibrant } from "node-vibrant/node";

/**
 * Loads the scraped logo data from the JSON file.
 * @returns {Promise<any[]>} An array of logo data objects.
 */
async function loadLogoData() {
    const filePath = path.resolve(process.cwd(), "dist", "scraped-logo-data.json");
    try {
        const jsonContent = await fs.readFile(filePath, 'utf-8');
        return JSON.parse(jsonContent);
    } catch (error) {
        console.warn("⚠️ Could not load scraped-logo-data.json. NCAA logos will not be available.", error);
        return [];
    }
}

/**
 * Reads an image file and converts it to a Base64 data URL.
 * @param {string} filePath The path to the image file.
 * @returns {Promise<string|null>}
 */
async function imageFileToBase64(filePath) {
    try {
        const file = await fs.readFile(filePath);
        const extension = path.extname(filePath).toLowerCase();
        let mimeType = 'image/png';
        if (extension === '.webp') {
            mimeType = 'image/webp';
        } else if (extension === '.gif') {
            mimeType = 'image/gif';
        }
        return `data:${mimeType};base64,${file.toString('base64')}`;
    } catch (error) {
        console.warn(`⚠️  Could not read image file at ${filePath}. Logo will be missing.`);
        return null;
    }
}

/**
 * Extracts the most vibrant, non-grayscale color from an image file.
 * @param {string} filePath The local path to the image file.
 * @returns {Promise<string|null>} The hex color string or null.
 */
async function getVibrantColor(filePath) {
    try {
        const palette = await Vibrant.from(filePath).getPalette();
        const vibrantSwatch = palette.Vibrant;

        // Ensure the color is not grayscale by checking saturation.
        if (vibrantSwatch && vibrantSwatch.hsl[1] > 0.2) {
            return vibrantSwatch.hex;
        }
        return null;
    } catch (error) {
        console.warn(`Could not extract color from ${filePath}:`, error);
        return null;
    }
}

const gradients = [
    'linear-gradient(45deg, #f0932b, #e84393)',
    'linear-gradient(45deg, #16a085, #f1c40f)',
    'linear-gradient(45deg, #8e44ad, #3498db)',
    'linear-gradient(to right, #00f260, #0575e6)',
    'linear-gradient(45deg, #e74c3c, #2980b9)',
    'linear-gradient(to right, #6a11cb, #2575fc)',
    'linear-gradient(to right, #ec008c, #fc6767)',
    'linear-gradient(to right, #00c9ff, #92fe9d)',
    'linear-gradient(to right, #ff4e50, #f9d423)',
    'linear-gradient(120deg, #d4fc79, #96e6a1)',
    'linear-gradient(120deg, #84fab0, #8fd3f4)',
    'linear-gradient(to top, #30cfd0, #330867)',
    'linear-gradient(to right, #fa709a, #fee140)',
];

// Simple, clean HTML template for the poster.
const getPosterHtml = (team1, team2, league, gradient, team1Logo, team2Logo, leagueLogo, streamCount) => `
<!DOCTYPE html>
<html>
<head>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Teko:wght@700&display=swap');
        body {
            margin: 0;
            padding: 20px;
            width: 1280px;
            height: 720px;
            box-sizing: border-box;
            background: ${gradient};
            color: #ffffff;
            font-family: 'Teko', sans-serif;
            display: flex;
            flex-direction: column;
            justify-content: center;
            align-items: center;
            text-align: center;
            text-transform: uppercase;
        }
        .league-logo-container { position: absolute; top: 15px; right: 15px; }
        .league-logo { max-height: 80px; max-width: 120px; }
        .team-container {
            background-color: rgba(0, 0, 0, 0.4);
            padding: 20px;
            border-radius: 15px;
            margin: 10px;
            width: 450px;
            height: 450px;
            display: flex;
            flex-grow: 1;
            flex-direction: column;
            justify-content: center;
            align-items: center;
        }
        .logo { max-height: 200px; max-width: 200px; margin-bottom: 10px; }
        .teams { display: flex; align-items: center; justify-content: center; width: 100%; }
        .team-name { font-size: 80px; line-height: 1.1; text-shadow: 3px 3px 0px rgba(0,0,0,0.2); }
        .vs { font-size: 60px; margin: 20px; color: #f1c40f; }
        .stream-count {
            position: absolute; bottom: 15px; left: 50%;
            transform: translateX(-50%);
            background-color: rgba(0, 0, 0, 0.5);
            color: #eeeeee; padding: 5px 20px;
            border-radius: 8px; font-size: 28px;
            font-family: 'Teko', sans-serif;
        }
    </style>
</head>
<body>
    <div class="league-logo-container">
        ${leagueLogo ? `<img src="${leagueLogo}" class="league-logo">` : ''}
    </div>
    <div class="teams">
        <div class="team-container">
            ${team1Logo ? `<img src="${team1Logo}" class="logo">` : ''}
            <div class="team-name">${team1}</div>
        </div>
        ${team2 && `<div class="vs">at</div>
            <div class="team-container">
                ${team2Logo ? `<img src="${team2Logo}" class="logo">` : ''}
            <div class="team-name">${team2}</div>
        </div>`}
    </div>
    ${streamCount > 0 ? `<div class="stream-count">${streamCount} Live Stream${streamCount > 1 ? 's' : ''}</div>` : ''}
</body>
</html>
`;

/**
 * Generates poster images for each game using Puppeteer.
 * @param {import('puppeteer').Browser} browser - The Puppeteer browser instance.
 * @param {any[]} games - An array of scraped game objects.
 * @returns {Promise<Map<string, string>>} A promise that resolves to a map of game IDs to their image paths.
 */
export async function generateImages(browser, games) {
    const imageMap = new Map();
    const imagesDir = path.resolve(process.cwd(), "dist", "images");

    // Load logo data for fuzzy searching
    const logoDataList = await loadLogoData();
    const fuse = new Fuse(logoDataList, {
        keys: ['teamName'],
        includeScore: true,
        threshold: 0.4,
    });
    
    // Load static league logos
    const nhlLogoB64 = await imageFileToBase64(path.resolve(process.cwd(), "dist", "league-logos", "nhl.png"));
    const ncaaLogoB64 = await imageFileToBase64(path.resolve(process.cwd(), "dist", "league-logos", "ncaa.png"));
    const basketballLogoB64 = await imageFileToBase64(path.resolve(process.cwd(), "dist", "league-logos", "nba.png"));
    const americanFootballLogoB64 = await imageFileToBase64(path.resolve(process.cwd(), "dist", "league-logos", "nfl.png"));
    const baseballLogoB64 = await imageFileToBase64(path.resolve(process.cwd(), "dist", "league-logos", "mlb.png"));
    const golfLogoB64 = await imageFileToBase64(path.resolve(process.cwd(), "dist", "league-logos", "pga.png"));
    const soccerLogoB64 = await imageFileToBase64(path.resolve(process.cwd(), "dist", "league-logos", "soccer.png"));

    // --- Soccer League Specific Logos ---
    const soccerLeagueLogoMap = {
        'Serie A': await imageFileToBase64(path.resolve(process.cwd(), "dist", "league-logos", "serie-a.png")),
        'Saudi Pro League': await imageFileToBase64(path.resolve(process.cwd(), "dist", "league-logos", "saudi-pro-league.png")),
        'EFL Championship': await imageFileToBase64(path.resolve(process.cwd(), "dist", "league-logos", "efl-championship.png")),
        'La Liga': await imageFileToBase64(path.resolve(process.cwd(), "dist", "league-logos", "la-liga.png")),
        'Eredivisie': await imageFileToBase64(path.resolve(process.cwd(), "dist", "league-logos", "eredivisie.png")),
        'Primeira Liga': await imageFileToBase64(path.resolve(process.cwd(), "dist", "league-logos", "primeira-liga.png")),
        'Ligue 1': await imageFileToBase64(path.resolve(process.cwd(), "dist", "league-logos", "ligue-1.png")),
        'Bundesliga': await imageFileToBase64(path.resolve(process.cwd(), "dist", "league-logos", "bundesliga.png")),
        'Super Lig': await imageFileToBase64(path.resolve(process.cwd(), "dist", "league-logos", "super-lig.png")),
        'Belgian Pro League': await imageFileToBase64(path.resolve(process.cwd(), "dist", "league-logos", "belgian-pro-league.jpg")),
        'Scottish Premiership': await imageFileToBase64(path.resolve(process.cwd(), "dist", "league-logos", "scottish-premiership.svg")),
        'Argentine Primera Division': await imageFileToBase64(path.resolve(process.cwd(), "dist", "league-logos", "argentine-primera-division.png")),
        'Brasileirao Serie A': await imageFileToBase64(path.resolve(process.cwd(), "dist", "league-logos", "brasileirao-serie-a.png")),
    };


    // Ensure the output directory exists.
    await fs.mkdir(imagesDir, { recursive: true });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });

    console.log(`Generating ${games.length} new images...`);

    for (const [index, game] of games.entries()) {
        const [team1, team2] = game.teams;
        const imagePath = path.join(imagesDir, `${game.id}.png`);

        let team1LogoPath = null;
        let team2LogoPath = null;

        // Only perform fuzzy search for NCAA logos, as requested.
        if (game.league === 'NCAA') {
            const result1 = fuse.search(team1);
            if (result1.length > 0) {
                // The `localPath` from the JSON already contains 'dist'.
                team1LogoPath = path.resolve(process.cwd(), result1[0].item.localPath);
            }
            const result2 = fuse.search(team2);
            if (result2.length > 0) {
                team2LogoPath = path.resolve(process.cwd(), result2[0].item.localPath);
            }
        }

        const team1LogoB64 = team1LogoPath ? await imageFileToBase64(team1LogoPath) : null;
        const team2LogoB64 = team2LogoPath ? await imageFileToBase64(team2LogoPath) : null;
        
        // --- Dynamic Gradient Generation ---
        const color1 = team1LogoPath ? await getVibrantColor(team1LogoPath) : null;
        const color2 = team2LogoPath ? await getVibrantColor(team2LogoPath) : null;
        
        let gradient;
        if (color1 && color2) {
            gradient = `linear-gradient(45deg, ${color1}, ${color2})`;
        } else {
            gradient = gradients[index % gradients.length];
        }

        let leagueLogoB64 = null;
        switch (game.league) {
            case 'NHL':
            case 'NHL Rookie Camp':
            case 'AHL':
                leagueLogoB64 = nhlLogoB64;
                break;
            case 'NCAA':
            case 'NCAA D1 Mens':
                leagueLogoB64 = ncaaLogoB64;
                break;
            case 'BASKETBALL':
                leagueLogoB64 = basketballLogoB64;
                break;
            case 'AMERICAN-FOOTBALL':
                leagueLogoB64 = americanFootballLogoB64;
                break;
            case 'BASEBALL':
                leagueLogoB64 = baseballLogoB64;
                break;
            case 'GOLF':
                leagueLogoB64 = golfLogoB64;
                break;
            case 'HOCKEY':
                leagueLogoB64 = nhlLogoB64; // Fallback to NHL for now
                break;
            case 'FOOTBALL':
                leagueLogoB64 = soccerLogoB64; // Generic fallback
                break;
            default:
                // Check if it's a specific soccer league
                if (soccerLeagueLogoMap[game.league]) {
                    leagueLogoB64 = soccerLeagueLogoMap[game.league];
                } else {
                    // Fallback for unknown soccer leagues to the generic logo
                    leagueLogoB64 = soccerLogoB64;
                }
                break;
        }

        const htmlContent = getPosterHtml(team1, team2, game.league, gradient, team1LogoB64, team2LogoB64, leagueLogoB64, game.streamLinks.length);

        await page.setContent(htmlContent, { waitUntil: 'domcontentloaded' });
        // Setting `omitBackground: false` is important for puppeteer to render it
        await page.screenshot({ path: imagePath, omitBackground: false });

        imageMap.set(game.id, imagePath);
        console.log(`  -> Saved image for ${game.name} to ${imagePath}`);
    }

    await page.close();
    console.log("✅ All new images generated.");
    return imageMap;
}