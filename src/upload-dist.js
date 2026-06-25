import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { uploadFeed, uploadImages } from './uploader.js';

const FEED_PATH = path.resolve(process.cwd(), 'dist', 'feed.json');
const IMAGES_DIR = path.resolve(process.cwd(), 'dist', 'images');

async function uploadLocalImages() {
    let files;
    try {
        files = await fs.readdir(IMAGES_DIR);
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log('No dist/images directory found; skipping image upload.');
            return;
        }
        throw error;
    }

    const imageMap = new Map();
    for (const fileName of files) {
        const localPath = path.join(IMAGES_DIR, fileName);
        const stat = await fs.stat(localPath);
        if (!stat.isFile()) continue;
        imageMap.set(fileName, localPath);
    }

    if (imageMap.size === 0) {
        console.log('No images in dist/images to upload.');
        return;
    }

    await uploadImages(imageMap);
}

async function main() {
    const includeImages = process.argv.includes('--images');

    if (process.env.DRY_RUN === 'true') {
        console.error('DRY_RUN=true in .env — uploads are disabled.');
        console.error('Run: DRY_RUN=false npm run upload');
        process.exit(1);
    }

    const feedJson = await fs.readFile(FEED_PATH, 'utf8');
    console.log(`Uploading ${FEED_PATH}...`);
    await uploadFeed(feedJson);

    if (includeImages) {
        console.log('Uploading images from dist/images...');
        await uploadLocalImages();
    }

    console.log('Done.');
}

main().catch((error) => {
    console.error('Upload failed:', error);
    process.exit(1);
});
