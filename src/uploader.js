import { S3Client, PutObjectCommand, DeleteObjectsCommand } from "@aws-sdk/client-s3";
import fs from 'fs/promises';
import path from 'path';

const B2_REGION = process.env.B2_REGION;
const B2_ENDPOINT = process.env.B2_ENDPOINT;
const B2_ACCESS_KEY_ID = process.env.B2_ACCESS_KEY_ID;
const B2_SECRET_ACCESS_KEY = process.env.B2_SECRET_ACCESS_KEY;
const B2_BUCKET_NAME = process.env.B2_BUCKET_NAME;

const isDryRun = process.env.DRY_RUN === 'true';

let s3Client;
if (B2_ENDPOINT && B2_REGION && B2_ACCESS_KEY_ID && B2_SECRET_ACCESS_KEY) {
    // Ensure the endpoint has a protocol, which the S3 client expects.
    const endpointUrl = B2_ENDPOINT.startsWith('http') ? B2_ENDPOINT : `https://${B2_ENDPOINT}`;

    s3Client = new S3Client({
        endpoint: endpointUrl,
        region: B2_REGION,
        credentials: {
            accessKeyId: B2_ACCESS_KEY_ID,
            secretAccessKey: B2_SECRET_ACCESS_KEY,
        }
    });
} else {
    console.warn("⚠️ Backblaze B2 credentials are not fully configured. Uploads will be skipped.");
}

/**
 * Uploads all newly generated images to Backblaze B2.
 * @param {Map<string, string>} localImageMap - A map of game names to their local image paths.
 * @returns {Promise<Map<string, string>>} A map of game names to their public B2 URLs.
 */
export async function uploadImages(localImageMap) {
    if (!s3Client) return new Map();
    if (isDryRun) {
        console.log("DRY RUN: Skipping image uploads.");
        // In a dry run, create fake public URLs for feed generation
        const fakePublicUrlMap = new Map();
        for (const [name, localPath] of localImageMap.entries()) {
            const fileName = path.basename(localPath);
            fakePublicUrlMap.set(name, `https://dry-run-bucket.example.com/images/${fileName}`);
        }
        return fakePublicUrlMap;
    }

    console.log(`Uploading ${localImageMap.size} new images to B2...`);
    const publicUrlMap = new Map();

    for (const [name, localPath] of localImageMap.entries()) {
        const fileName = path.basename(localPath);
        const remotePath = `images/${fileName}`;
        
        try {
            const fileContent = await fs.readFile(localPath);
            const command = new PutObjectCommand({
                Bucket: B2_BUCKET_NAME,
                Key: remotePath,
                Body: fileContent,
                ContentType: 'image/png',
            });
            await s3Client.send(command);

            // Construct the public URL
            const publicUrl = `https://${B2_BUCKET_NAME}.${B2_ENDPOINT.replace('https://', '')}/${remotePath}`;
            publicUrlMap.set(name, publicUrl);
            console.log(`  -> Successfully uploaded ${fileName}`);
        } catch (error) {
            console.error(`  -> Error uploading ${fileName}:`, error);
        }
    }
    console.log("✅ Image uploads complete.");
    return publicUrlMap;
}

/**
 * Uploads the generated JSON feed to Backblaze B2.
 * @param {string} feedContent - The JSON string of the feed.
 */
export async function uploadFeed(feedContent) {
    if (!s3Client) return;
    if (isDryRun) {
        console.log("DRY RUN: Skipping feed upload.");
        // Even in a dry run, it's useful to save the feed locally to inspect it.
        await fs.writeFile(path.resolve(process.cwd(), 'dist', 'feed.json'), feedContent);
        console.log("Saved feed to dist/feed.json for inspection.");
        return;
    }

    const feedFilename = process.env.SECRET_FEED_FILENAME;
    if (!feedFilename) {
        console.error("❌ SECRET_FEED_FILENAME is not set. Cannot upload feed.");
        return;
    }

    console.log(`Uploading feed to ${feedFilename}...`);
    try {
        const command = new PutObjectCommand({
            Bucket: B2_BUCKET_NAME,
            Key: feedFilename,
            Body: feedContent,
            ContentType: 'application/json',
        });
        await s3Client.send(command);
        console.log("✅ Feed successfully uploaded.");
    } catch (error) {
        console.error("Error uploading feed:", error);
    }
}

/**
 * Deletes images for removed games from Backblaze B2.
 * @param {any[]} removedGames - An array of game objects that are no longer in the feed.
 */
export async function deleteImages(removedGames) {
    if (!s3Client || removedGames.length === 0) return;
    if (isDryRun) {
        console.log(`DRY RUN: Skipping deletion of ${removedGames.length} old images.`);
        return;
    }

    console.log(`Deleting ${removedGames.length} old images from B2...`);
    const objectsToDelete = removedGames.map(game => ({
        Key: `images/${game.id}.png`
    }));

    try {
        const command = new DeleteObjectsCommand({
            Bucket: B2_BUCKET_NAME,
            Delete: {
                Objects: objectsToDelete,
                Quiet: false,
            },
        });
        const { Deleted } = await s3Client.send(command);
        console.log(`Successfully deleted ${Deleted.length} objects from B2.`);
        if (Deleted && Deleted.length !== removedGames.length) {
            console.warn("Could not delete all requested objects.");
        }
    } catch (error) {
        console.error("Error deleting objects from B2:", error);
    }
}