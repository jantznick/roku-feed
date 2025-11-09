import fs from 'fs/promises';
import path from 'path';

const imagesDir = path.resolve(process.cwd(), "dist", "images");

export async function downloadPosters(games) {
    if (!games || games.length === 0) {
        return new Map();
    }
    
    console.log(`\nDownloading ${games.length} official posters...`);
    await fs.mkdir(imagesDir, { recursive: true });

    const imageMap = new Map();
    const downloadPromises = games.map(async game => {
        try {
            // Prepend base URL if the poster URL is relative
            const posterUrl = game.poster.startsWith('/') 
                ? `https://streamed.pk${game.poster}` 
                : game.poster;

            const response = await fetch(posterUrl);
            if (!response.ok) {
                console.warn(`-- Failed to download poster for "${game.name}": Server responded with ${response.status}`);
                return;
            }
            const arrayBuffer = await response.arrayBuffer();
            const imageBuffer = Buffer.from(arrayBuffer);
            const extension = path.extname(new URL(posterUrl).pathname) || '.jpg';
            const imagePath = path.join(imagesDir, `${game.id}${extension}`);

            await fs.writeFile(imagePath, imageBuffer);
            imageMap.set(game.id, imagePath);
            console.log(`  -> Saved poster for ${game.name} to ${imagePath}`);
        } catch (error) {
            console.error(`-- Error downloading poster for "${game.name}":`, error);
        }
    });

    await Promise.all(downloadPromises);
    console.log("✅ All posters downloaded.");
    return imageMap;
}
