import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number.parseInt(process.env.PORT || '8080', 10);
const DEFAULT_FEED_URL = process.env.FEED_URL || '';
const PROXY_REWRITE_FROM = process.env.PROXY_REWRITE_FROM || '';
const PROXY_REWRITE_TO = process.env.PROXY_REWRITE_TO || '';

app.disable('x-powered-by');

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/config', (_req, res) => {
  res.json({
    feedConfigured: Boolean(DEFAULT_FEED_URL),
    proxyRewriteFrom: PROXY_REWRITE_FROM || null,
    proxyRewriteTo: PROXY_REWRITE_TO || null,
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

app.use(express.static(path.join(__dirname, 'public'), {
  extensions: ['html'],
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store');
    }
  },
}));

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Web stream viewer listening on http://0.0.0.0:${PORT}`);
  if (DEFAULT_FEED_URL) {
    console.log(`Default FEED_URL: ${DEFAULT_FEED_URL}`);
  }
});
