import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const feedPath = path.join(__dirname, '../dist/feed.json');

async function clear247Channels() {
    try {
        console.log(`Reading feed from: ${feedPath}`);
        const feedContent = await fs.readFile(feedPath, 'utf-8');
        const feed = JSON.parse(feedContent);

        const channelKey = '24/7 Channels';

        if (feed[channelKey]) {
            console.log(`Found "${channelKey}" category. It has ${feed[channelKey].length} item(s).`);
            feed[channelKey] = [];
            console.log(`Successfully cleared all items from "${channelKey}".`);
        } else {
            console.log(`"${channelKey}" category not found. Creating it as an empty array.`);
            feed[channelKey] = [];
        }

        const updatedFeedJson = JSON.stringify(feed, null, 2);
        await fs.writeFile(feedPath, updatedFeedJson, 'utf-8');

        console.log(`Successfully updated and saved feed.json.`);

    } catch (error) {
        if (error.code === 'ENOENT') {
            console.error(`Error: The feed file was not found at ${feedPath}. Please ensure the main script has run at least once.`);
        } else {
            console.error('An unexpected error occurred:', error);
        }
        process.exit(1);
    }
}

clear247Channels();
