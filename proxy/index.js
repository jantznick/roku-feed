const express = require('express');
const http = require('http');
const createHlsProxyMiddleware = require('./node_modules/@warren-bank/hls-proxy/hls-proxy/proxy');

const app = express();
const port = process.env.PORT || 8080;
const proxyHost = '192.168.1.50:8787';

const refererUrl = "https://embedsports.top/";
const origin = new URL(refererUrl).origin;

console.log(`Starting proxy with hardcoded referer: ${refererUrl}`);

const middleware = createHlsProxyMiddleware({
    'host': proxyHost,
    'req-headers': {
        'Referer': refererUrl,
        'Origin': origin,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36'
    },
    'debug_level': 1,
});

app.use('/proxy', middleware.request);

http.createServer(app).listen(port, () => {
    console.log(`HLS Proxy server listening at http://localhost:${port}`);
    console.log(`Rewriting segment URLs to use host: ${proxyHost}`);
});