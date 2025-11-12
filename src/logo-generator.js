import 'dotenv/config'; // Load environment variables from .env file
import puppeteer from 'puppeteer';
import fs from 'fs/promises';
import path from 'path';
import { uploadFile } from './uploader.js'; // We'll reuse the uploader

const B2_BUCKET_URL = 'https://f004.backblazeb2.com/file/roku-hockey/';
const LOGO_IMAGES_PATH = 'logo-images/';
const OUTPUT_FILENAME = 'channel-header.png';
const LOCAL_OUTPUT_PATH = path.resolve(process.cwd(), 'dist', OUTPUT_FILENAME);
const FINAL_UPLOAD_PATH = OUTPUT_FILENAME; // The S3 Key should just be the filename for the bucket root.


// --- Main Configuration ---
// Add the filenames of the logos you upload to your Backblaze bucket here.
const LOGO_FILENAMES = [
    "soccer.png",
    "basketball.png",
    "hockey.png",
    "football.png",
    "baseball.png",
    "sports.png"
    // Add more filenames as you upload them...
];

async function generateLogo() {
    console.log('--- Starting Logo Generation Script ---');

    // 1. Select two different random logos
    if (LOGO_FILENAMES.length < 2) {
        console.error('❌ Error: At least two logo filenames are needed to generate the dual-logo header. Please add more.');
        return;
    }
    let index1 = Math.floor(Math.random() * LOGO_FILENAMES.length);
    let index2 = Math.floor(Math.random() * LOGO_FILENAMES.length);
    // Ensure the two logos are different
    while (index1 === index2) {
        index2 = Math.floor(Math.random() * LOGO_FILENAMES.length);
    }
    const logoUrl1 = `${B2_BUCKET_URL}${LOGO_IMAGES_PATH}${LOGO_FILENAMES[index1]}`;
    const logoUrl2 = `${B2_BUCKET_URL}${LOGO_IMAGES_PATH}${LOGO_FILENAMES[index2]}`;
    console.log(`✅ Selected logos: ${LOGO_FILENAMES[index1]} and ${LOGO_FILENAMES[index2]}`);

    // 2. Fetch both logo images and convert them to data URIs
    let logoDataUri1, logoDataUri2;
    try {
        const [response1, response2] = await Promise.all([
            fetch(logoUrl1),
            fetch(logoUrl2)
        ]);
        if (!response1.ok || !response2.ok) throw new Error('Failed to fetch one or more logos.');
        
        const [buffer1, buffer2] = await Promise.all([
            response1.arrayBuffer(),
            response2.arrayBuffer()
        ]);

        logoDataUri1 = `data:image/png;base64,${Buffer.from(buffer1).toString('base64')}`;
        logoDataUri2 = `data:image/png;base64,${Buffer.from(buffer2).toString('base64')}`;
        console.log('✅ Successfully fetched and converted both logos to data URIs.');
    } catch (error) {
        console.error(`❌ Failed to fetch logos:`, error.message);
        return;
    }

    // 3. Generate HTML for the image using the data URIs
    const htmlContent = `
        <html>
            <head>
                <style>
                    @import url('https://fonts.googleapis.com/css2?family=Teko:wght@700&display=swap');
                    body {
                        margin: 0;
                        width: 1000px;
                        height: 160px;
                        background-color: transparent;
                        display: flex;
                        align-items: center;
                        font-family: 'Teko', sans-serif;
                        text-transform: uppercase;
                    }
                    .container {
                        display: flex;
                        align-items: center;
                        justify-content: flex-start; /* Left-align content */
                        padding-left: 40px;
                    }
                    .text-container {
                        display: flex;
                        flex-direction: column;
                        align-items: center;
                        line-height: 0.8;
                        margin: 0 30px; /* Margin on both sides of text */
                    }
                    .we-like {
                        font-size: 48px;
                        font-weight: 700;
                        color: #FFFFFF;
                        letter-spacing: 1.5px;
                    }
                    .sports {
                        font-size: 100px;
                        font-weight: 700;
                        color: #FFFFFF;
                        text-shadow: 3px 3px 3px #000000;
                    }
                    .logo {
                        width: 100px;
                        height: 100px;
                        object-fit: contain;
                        filter: grayscale(1) brightness(10);
                    }
                </style>
            </head>
            <body>
                <div class="container">
                    <img src="${logoDataUri1}" class="logo" />
                    <div class="text-container">
                        <div class="we-like">We Like</div>
                        <div class="sports">Sports</div>
                    </div>
                    <img src="${logoDataUri2}" class="logo" />
                </div>
            </body>
        </html>
    `;

    // 4. Use Puppeteer to create the image
    console.log('🚀 Launching Puppeteer to generate image...');
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    await page.setViewport({ width: 1000, height: 160 });
    await page.setContent(htmlContent, { waitUntil: 'networkidle0' });
    
    // Ensure the output directory exists before saving the screenshot.
    await fs.mkdir(path.dirname(LOCAL_OUTPUT_PATH), { recursive: true });

    await page.screenshot({
        path: LOCAL_OUTPUT_PATH,
        omitBackground: true, // Generate a transparent PNG as requested
    });
    await browser.close();
    console.log(`✅ Image successfully generated and saved to ${LOCAL_OUTPUT_PATH}`);

    // 5. Upload the final image
    console.log(`🚀 Uploading ${OUTPUT_FILENAME} to Backblaze B2...`);
    try {
        // The new uploadFile function takes the remote path and local path.
        await uploadFile(LOCAL_OUTPUT_PATH, FINAL_UPLOAD_PATH);
        console.log(`✅ Successfully uploaded to ${B2_BUCKET_URL}${OUTPUT_FILENAME}`);
    } catch (error) {
        console.error('❌ Error uploading file:', error);
    }
    
    console.log('--- Logo Generation Script Finished ---');
}

generateLogo().catch(console.error);
