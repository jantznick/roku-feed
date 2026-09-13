import express from 'express';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number.parseInt(process.env.PORT || '8080', 10);
const DEFAULT_FEED_URL = process.env.FEED_URL || '';
const PROXY_REWRITE_FROM = process.env.PROXY_REWRITE_FROM || '';
const PROXY_REWRITE_TO = process.env.PROXY_REWRITE_TO || '';
/** LAN HLS proxy origin, e.g. http://192.168.1.50:8787 — required for HTTPS pages (mixed content). */
const HLS_PROXY_UPSTREAM = normalizeUpstream(process.env.HLS_PROXY_UPSTREAM || '');
const HLS_MOUNT = '/hls';

function normalizeUpstream(raw) {
  const value = String(raw || '').trim().replace(/\/$/, '');
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  return `http://${value}`;
}

app.disable('x-powered-by');

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/config', (_req, res) => {
  res.json({
    feedConfigured: Boolean(DEFAULT_FEED_URL),
    proxyRewriteFrom: PROXY_REWRITE_FROM || null,
    proxyRewriteTo: PROXY_REWRITE_TO || null,
    hlsProxyUpstream: HLS_PROXY_UPSTREAM || null,
    // Always advertise the mount so the client can rewrite LAN URLs even if feed rewrite failed.
    hlsMount: HLS_MOUNT,
  });
});

/**
 * Server-side feed fetch avoids browser CORS issues with Backblaze/S3.
 * Feed URL comes only from FEED_URL env (no client override).
 */
app.get('/api/feed', async (_req, res) => {
  const feedUrl = DEFAULT_FEED_URL.trim();
  if (!feedUrl) {
    res.status(500).json({ error: 'FEED_URL is not set on the server' });
    return;
  }

  let parsed;
  try {
    parsed = new URL(feedUrl);
  } catch {
    res.status(400).json({ error: 'Invalid feed url' });
    return;
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    res.status(400).json({ error: 'Feed url must be http(s)' });
    return;
  }

  try {
    const upstream = await fetch(feedUrl, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(30000),
    });
    if (!upstream.ok) {
      res.status(502).json({ error: `Upstream feed returned ${upstream.status}` });
      return;
    }

    const text = await upstream.text();
    let feed;
    try {
      feed = JSON.parse(text);
    } catch {
      res.status(502).json({ error: 'Upstream feed was not valid JSON' });
      return;
    }

    if (PROXY_REWRITE_FROM && PROXY_REWRITE_TO) {
      rewriteProxyHosts(feed, PROXY_REWRITE_FROM, PROXY_REWRITE_TO);
    }
    if (HLS_PROXY_UPSTREAM) {
      rewriteFeedStreamUrls(feed);
    }

    res.setHeader('Cache-Control', 'no-store');
    res.json(feed);
  } catch (error) {
    res.status(502).json({ error: error.message || 'Failed to fetch feed' });
  }
});

function rewriteProxyHosts(feed, fromHost, toHost) {
  for (const value of Object.values(feed)) {
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      const videos = item?.content?.videos;
      if (!Array.isArray(videos)) continue;
      for (const video of videos) {
        if (typeof video.url === 'string' && video.url.includes(fromHost)) {
          video.url = video.url.split(fromHost).join(toHost);
        }
      }
    }
  }
}

function rewriteFeedStreamUrls(feed) {
  for (const value of Object.values(feed)) {
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      const videos = item?.content?.videos;
      if (!Array.isArray(videos)) continue;
      for (const video of videos) {
        if (typeof video.url === 'string') {
          video.url = rewriteHlsUrlsInText(video.url);
        }
      }
    }
  }
}

function rewriteHlsUrlsInText(text) {
  if (!HLS_PROXY_UPSTREAM || !text) return text;
  let out = text.split(HLS_PROXY_UPSTREAM).join(HLS_MOUNT);
  try {
    const host = new URL(HLS_PROXY_UPSTREAM).host;
    const escaped = host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`https?://${escaped}`, 'gi'), HLS_MOUNT);
  } catch {
    // ignore invalid upstream
  }
  return out;
}

function isManifestResponse(contentType, targetUrl) {
  return /mpegurl|m3u8/i.test(contentType || '') || /\.m3u8(\?|$)/i.test(targetUrl);
}

/**
 * Same-origin HTTPS front for the LAN HLS proxy.
 * Prevents Mixed Content when the viewer is served over https://.
 */
app.use('/hls', async (req, res) => {
  if (!HLS_PROXY_UPSTREAM) {
    res.status(503).type('text/plain').send('HLS_PROXY_UPSTREAM is not configured');
    return;
  }

  const pathWithQuery = req.originalUrl.slice(HLS_MOUNT.length) || '/';
  const targetUrl = HLS_PROXY_UPSTREAM + pathWithQuery;

  const headers = {
    Accept: req.headers.accept || '*/*',
    'User-Agent': req.headers['user-agent'] || 'roku-feed-web/1',
  };
  if (req.headers.range) headers.Range = req.headers.range;

  let upstream;
  try {
    upstream = await fetch(targetUrl, {
      method: req.method === 'HEAD' ? 'HEAD' : 'GET',
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(120000),
    });
  } catch (error) {
    res.status(502).type('text/plain').send(error.message || 'HLS upstream fetch failed');
    return;
  }

  const contentType = upstream.headers.get('content-type') || '';
  res.status(upstream.status);

  const passHeaders = ['content-type', 'accept-ranges', 'content-range', 'cache-control'];
  for (const name of passHeaders) {
    const value = upstream.headers.get(name);
    if (value) res.setHeader(name, value);
  }
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'HEAD') {
    const cl = upstream.headers.get('content-length');
    if (cl) res.setHeader('Content-Length', cl);
    res.end();
    return;
  }

  if (isManifestResponse(contentType, targetUrl)) {
    const body = rewriteHlsUrlsInText(await upstream.text());
    res.setHeader('Content-Type', contentType || 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-store');
    res.send(body);
    return;
  }

  const contentLength = upstream.headers.get('content-length');
  if (contentLength) res.setHeader('Content-Length', contentLength);

  if (!upstream.body) {
    res.end();
    return;
  }

  try {
    await pipeline(Readable.fromWeb(upstream.body), res);
  } catch (error) {
    if (!res.headersSent) {
      res.status(502).type('text/plain').send(error.message || 'HLS proxy stream failed');
    } else {
      res.destroy(error);
    }
  }
});

app.use(express.static(path.join(__dirname, 'public'), {
  extensions: ['html'],
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store');
    }
  },
}));

// SPA fallback — never swallow /api or /hls (those must hit the handlers above,
// or return a clear 404 instead of index.html, which breaks HLS debugging).
app.get('*', (req, res) => {
  if (req.path === '/api' || req.path.startsWith('/api/') ||
      req.path === '/hls' || req.path.startsWith('/hls/')) {
    res.status(404).type('text/plain').send(`No handler for ${req.path}`);
    return;
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Web stream viewer listening on http://0.0.0.0:${PORT}`);
  if (DEFAULT_FEED_URL) {
    console.log(`Default FEED_URL: ${DEFAULT_FEED_URL}`);
  }
  if (HLS_PROXY_UPSTREAM) {
    console.log(`HLS proxy: ${HLS_MOUNT} → ${HLS_PROXY_UPSTREAM}`);
  } else {
    console.log('HLS_PROXY_UPSTREAM unset — HTTPS pages will block http:// LAN stream URLs (mixed content)');
  }
});
