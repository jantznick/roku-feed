import express from 'express';
import http from 'http';
import { gotScraping } from 'got-scraping';

const app = express();
const port = process.env.PORT || 8787;
const proxyHost = '192.168.1.50:8787';

console.log(`Starting ADVANCED HLS proxy (hardcoded referer)...`);

const referer = 'https://embedsports.top/';
const headers = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:109.0) Gecko/20100101 Firefox/117.0',
    'Referer': referer,
};

console.log(`  - Using hardcoded referer: ${referer}`);

app.get('/', (req, res) => {
    res.send('Proxy server is running');
});

// This proxy will use a hardcoded referer for all requests.
// Format: /proxy/{BASE64_STREAM_URL}
app.get('/proxy/:b64StreamUrl', async (req, res) => {
    const { b64StreamUrl } = req.params;
    const streamUrl = Buffer.from(b64StreamUrl, 'base64').toString('ascii');
    
    const isManifestRequest = streamUrl.endsWith('.m3u8');
    
    console.log(`---\n[${new Date().toISOString()}] New request`);
    console.log(`  - Stream URL: ${streamUrl}`);
    
    try {
        const response = await gotScraping({
            url: streamUrl,
            headers: headers, // Use the globally defined headers
            http2: true,
            responseType: isManifestRequest ? 'text' : 'buffer',
            retry: { limit: 2 },
        });

        // Set CORS headers manually to revert to the previously working state.
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');

        if (isManifestRequest) {
            console.log(`  - Successfully fetched manifest. Rewriting segment URLs...`);
            
            const KEY_TAG = '#EXT-X-KEY:';
            const rewrittenPlaylist = response.body.split('\n').map(line => {
                // Case 1: Handle decryption key URLs
                if (line.startsWith(KEY_TAG)) {
                    const uriMatch = line.match(/URI="([^"]+)"/);
                    if (uriMatch && uriMatch[1]) {
                        const keyUri = uriMatch[1];
                        const fullKeyUrl = new URL(keyUri, streamUrl).href;
                        const b64KeyUrl = Buffer.from(fullKeyUrl).toString('base64');
                        const proxiedKeyUrl = `http://${proxyHost}/proxy/${b64KeyUrl}`;
                        console.log(`  - Rewriting key URL: ${keyUri} -> ${proxiedKeyUrl}`);
                        return line.replace(keyUri, proxiedKeyUrl);
                    }
                }

                // Case 2: Handle segment or sub-playlist URLs
                if (line.trim().length > 0 && !line.startsWith('#')) {
                    const segmentUrl = new URL(line, streamUrl).href;
                    const b64SegmentUrl = Buffer.from(segmentUrl).toString('base64');
                    // The URL now only needs the segment, no referer query is needed.
                    return `http://${proxyHost}/proxy/${b64SegmentUrl}`;
                }
                
                // Case 3: Pass through all other lines
                return line;
            }).join('\n');

            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            res.send(rewrittenPlaylist);

        } else {
            console.log(`  - Successfully fetched segment. Piping to client...`);
            res.setHeader('Content-Type', response.headers['content-type'] || 'video/MP2T');
            res.send(response.body);
        }

    } catch (error) {
        console.error(`  - ERROR processing request:`, error.message);
        if (!res.headersSent) {
            res.status(500).send(`Failed to proxy stream: ${error.message}`);
        }
    }
});


http.createServer(app).listen(port, () => {
    console.log(`Advanced HLS Proxy server listening at http://localhost:${port}`);
});
