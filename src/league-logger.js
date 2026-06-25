import fs from 'fs/promises';
import path from 'path';

const LOG_FILE_PATH = path.resolve(process.cwd(), 'data', 'soccer-leagues.log');
const KNOWN_NON_SOCCER_LEAGUES = new Set([
    'NHL', 'NCAA D1 Mens', 'AHL', 'BASKETBALL', 'AMERICAN-FOOTBALL',
    'BASEBALL', 'HOCKEY', 'MOTOR-SPORTS', '24/7 Channels',
]);

async function getExistingLeagues() {
    try {
        await fs.mkdir(path.dirname(LOG_FILE_PATH), { recursive: true });
        const data = await fs.readFile(LOG_FILE_PATH, 'utf8');
        return new Set(data.split('\n').filter(Boolean));
    } catch (error) {
        if (error.code === 'ENOENT') {
            return new Set(); // File doesn't exist yet
        }
        throw error;
    }
}

export async function logLeagues(allGames) {
    const existingLeagues = await getExistingLeagues();
    const currentSoccerLeagues = new Set();

    allGames.forEach(game => {
        if (!KNOWN_NON_SOCCER_LEAGUES.has(game.league)) {
            currentSoccerLeagues.add(game.league);
        }
    });

    const newLeagues = [];
    currentSoccerLeagues.forEach(league => {
        if (!existingLeagues.has(league)) {
            newLeagues.push(league);
        }
    });

    if (newLeagues.length > 0) {
        console.log(`\n--- Discovered ${newLeagues.length} new soccer leagues ---`);
        newLeagues.sort().forEach(league => console.log(`  -> ${league}`));
        
        await fs.appendFile(LOG_FILE_PATH, newLeagues.sort().join('\n') + '\n');
        console.log(`✅ Appended new leagues to ${LOG_FILE_PATH}`);
    } else {
        console.log('\n--- No new soccer leagues discovered in this run. ---');
    }
}
