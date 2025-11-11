import puppeteer from 'puppeteer';
import { getFinalStreamUrl } from './streamed-scraper.js';

// --- Test Configuration ---
// Paste the embed URL you want to test here.
const testEmbedUrl = 'https://embedsports.top/embed/delta/live_nba_bulls-spurs-live-streaming-423814032/1';
const proxyHost = 'http://192.168.1.50:8787'; // For local testing
// --------------------------

async function testStream() {
    console.log(`--- Testing Embed URL ---`);
    console.log(`URL: ${testEmbedUrl}\n`);
    
    let browser;
    try {
        console.log('Launching browser...');
        browser = await puppeteer.launch({ headless: true });

        console.log('Calling getFinalStreamUrl...');
        const finalStreamInfo = await getFinalStreamUrl(browser, testEmbedUrl);

        console.log('\n--- Test Result ---');
        if (finalStreamInfo) {
            console.log('✅ Success! Found final stream info:');
            console.log('  -> Stream URL:', finalStreamInfo.streamUrl);
            console.log('  -> Referer:', finalStreamInfo.referer);
            
            // Generate and log the proxy URL
            const b64StreamUrl = Buffer.from(finalStreamInfo.streamUrl).toString('base64');
            const proxyUrl = `${proxyHost}/proxy/${b64StreamUrl}`;
            console.log('\n✅ Generated Proxy URL:');
            console.log(proxyUrl);

        } else {
            console.log('❌ Failed. Could not retrieve final stream info.');
        }
        console.log('------------------');

    } catch (error) {
        console.error('\n--- An error occurred during the test ---');
        console.error(error);
        console.log('-----------------------------------------');
    } finally {
        if (browser) {
            await browser.close();
            console.log('\nBrowser closed.');
        }
    }
}

testStream();
