const LEAGUE_STORAGE_KEY = 'rokuFeedViewer.league';

const META_KEYS = new Set(['providerName', 'lastUpdated', 'language', 'scriptDuration']);

const els = {
  reloadBtn: document.getElementById('reloadBtn'),
  feedAge: document.getElementById('feedAge'),
  status: document.getElementById('status'),
  leagueNav: document.getElementById('leagueNav'),
  gameList: document.getElementById('gameList'),
  playerSection: document.getElementById('playerSection'),
  video: document.getElementById('video'),
  nowLeague: document.getElementById('nowLeague'),
  nowTitle: document.getElementById('nowTitle'),
  closePlayerBtn: document.getElementById('closePlayerBtn'),
  qualityRow: document.getElementById('qualityRow'),
};

/** @type {any} */
let feed = null;
/** @type {string[]} */
let leagues = [];
let activeLeague = '';
/** @type {any} */
let hls = null;
/** @type {number | null} */
let feedAgeTimer = null;
/** @type {{ hlsProxyUpstream: string | null, hlsMount: string }} */
let appConfig = {
  hlsProxyUpstream: null,
  hlsMount: '/hls',
};

/**
 * Rewrite LAN proxy URLs to same-origin /hls so HTTPS pages are not blocked by Mixed Content.
 * Works even when /api/feed still returns http://192.168.x.x URLs.
 */
function rewriteToHls(url) {
  if (!url || typeof url !== 'string') return url;

  const mount = appConfig.hlsMount || '/hls';
  const upstream = appConfig.hlsProxyUpstream;

  if (upstream && url.includes(upstream)) {
    return url.split(upstream).join(mount);
  }

  if (upstream) {
    try {
      const host = new URL(upstream).host;
      const escaped = host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const rewritten = url.replace(new RegExp(`https?://${escaped}`, 'gi'), mount);
      if (rewritten !== url) return rewritten;
    } catch {
      // ignore
    }
  }

  // Fallback: foreign-origin URLs whose path is the LAN proxy (/proxy...)
  try {
    const parsed = new URL(url, window.location.href);
    if (parsed.pathname.startsWith('/proxy') && parsed.origin !== window.location.origin) {
      return `${mount}${parsed.pathname}${parsed.search}`;
    }
  } catch {
    // ignore
  }

  return url;
}

function rewriteFeedStreamUrls(data) {
  for (const value of Object.values(data || {})) {
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      const videos = item?.content?.videos;
      if (!Array.isArray(videos)) continue;
      for (const video of videos) {
        if (typeof video.url === 'string') {
          video.url = rewriteToHls(video.url);
        }
      }
    }
  }
}

async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    if (!res.ok) return;
    const payload = await res.json();
    appConfig = {
      hlsProxyUpstream: payload.hlsProxyUpstream || null,
      hlsMount: payload.hlsMount || '/hls',
    };
  } catch {
    // keep defaults — rewriteToHls still maps /proxy paths on foreign hosts
  }
}

function setStatus(message, isError = false) {
  els.status.textContent = message || '';
  els.status.classList.toggle('error', Boolean(isError));
}

function formatFeedAge(iso) {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'Feed updated: unknown time';

  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60) return 'Feed updated just now';

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `Feed updated ${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    return `Feed updated ${hours} hour${hours === 1 ? '' : 's'} ago`;
  }

  const days = Math.floor(hours / 24);
  return `Feed updated ${days} day${days === 1 ? '' : 's'} ago`;
}

function updateFeedAge() {
  if (!feed?.lastUpdated) {
    els.feedAge.textContent = feed ? 'Feed updated: unknown time' : 'Feed not loaded';
    return;
  }
  els.feedAge.textContent = formatFeedAge(feed.lastUpdated);
  els.feedAge.title = new Date(feed.lastUpdated).toLocaleString();
}

function startFeedAgeTimer() {
  if (feedAgeTimer) clearInterval(feedAgeTimer);
  updateFeedAge();
  feedAgeTimer = window.setInterval(updateFeedAge, 30000);
}

function leagueEntries(data) {
  return Object.keys(data).filter((key) => Array.isArray(data[key]) && !META_KEYS.has(key));
}

async function loadFeed() {
  setStatus('Loading feed…');
  els.reloadBtn.disabled = true;
  els.gameList.innerHTML = '<p class="empty">Loading…</p>';

  try {
    const res = await fetch('/api/feed');
    const payload = await res.json();
    if (!res.ok) {
      throw new Error(payload.error || `Feed error ${res.status}`);
    }

    feed = payload;
    rewriteFeedStreamUrls(feed);
    leagues = leagueEntries(feed);

    const savedLeague = localStorage.getItem(LEAGUE_STORAGE_KEY);
    activeLeague = leagues.includes(savedLeague) ? savedLeague : (leagues[0] || '');

    renderLeagues();
    renderGames();
    startFeedAgeTimer();
    setStatus(`${leagues.length} league${leagues.length === 1 ? '' : 's'} loaded`);
  } catch (error) {
    feed = null;
    leagues = [];
    els.leagueNav.innerHTML = '';
    els.gameList.innerHTML = '<p class="empty">Could not load feed.</p>';
    updateFeedAge();
    setStatus(error.message || 'Failed to load feed. Is FEED_URL set?', true);
  } finally {
    els.reloadBtn.disabled = false;
  }
}

function renderLeagues() {
  els.leagueNav.innerHTML = '';
  for (const league of leagues) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = `${league} (${feed[league].length})`;
    btn.classList.toggle('active', league === activeLeague);
    btn.addEventListener('click', () => {
      activeLeague = league;
      localStorage.setItem(LEAGUE_STORAGE_KEY, league);
      renderLeagues();
      renderGames();
    });
    els.leagueNav.appendChild(btn);
  }
}

function renderGames() {
  els.gameList.innerHTML = '';
  const games = feed?.[activeLeague] || [];
  if (!games.length) {
    els.gameList.innerHTML = '<p class="empty">No games in this league.</p>';
    return;
  }

  for (const game of games) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'game-card';
    const streams = game?.content?.videos?.length || 0;
    btn.innerHTML = `
      <img src="${escapeAttr(game.thumbnail || '')}" alt="" loading="lazy" />
      <div>
        <h3>${escapeHtml(game.title || 'Untitled')}</h3>
        <p>${escapeHtml(game.shortDescription || game.startTime || '')} · ${streams} stream${streams === 1 ? '' : 's'}</p>
      </div>
    `;
    btn.addEventListener('click', () => openGame(game, activeLeague));
    els.gameList.appendChild(btn);
  }
}

function openGame(game, league) {
  els.playerSection.classList.remove('hidden');
  els.nowLeague.textContent = league;
  els.nowTitle.textContent = game.title || 'Stream';
  renderQualities(game);
  const first = game?.content?.videos?.[0];
  if (first) {
    playUrl(first.url, first.quality);
  } else {
    setStatus('No streams on this game.', true);
  }
  els.playerSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderQualities(game) {
  els.qualityRow.innerHTML = '';
  const videos = game?.content?.videos || [];
  videos.forEach((video, index) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = video.quality || `Stream ${index + 1}`;
    btn.addEventListener('click', () => {
      [...els.qualityRow.querySelectorAll('button')].forEach((el) => el.classList.remove('active'));
      btn.classList.add('active');
      playUrl(video.url, video.quality);
    });
    if (index === 0) btn.classList.add('active');
    els.qualityRow.appendChild(btn);
  });
}

function destroyHls() {
  if (hls) {
    hls.destroy();
    hls = null;
  }
}

function createHlsPlayer() {
  const BaseLoader = window.Hls.DefaultConfig.loader;
  class RewritingLoader extends BaseLoader {
    load(context, config, callbacks) {
      if (context?.url) {
        context.url = rewriteToHls(context.url);
      }
      super.load(context, config, callbacks);
    }
  }

  return new window.Hls({
    enableWorker: true,
    lowLatencyMode: true,
    loader: RewritingLoader,
  });
}

function playUrl(url, label = '') {
  destroyHls();
  const video = els.video;
  video.pause();
  video.removeAttribute('src');
  video.load();

  const playableUrl = rewriteToHls(url);
  setStatus(label ? `Playing ${label}` : 'Playing…');

  if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = playableUrl;
    video.play().catch(() => {});
    return;
  }

  if (window.Hls?.isSupported()) {
    hls = createHlsPlayer();
    hls.loadSource(playableUrl);
    hls.attachMedia(video);
    hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
      video.play().catch(() => {});
    });
    hls.on(window.Hls.Events.ERROR, (_event, data) => {
      if (data?.fatal) {
        setStatus(`Playback error: ${data.type} / ${data.details}`, true);
      }
    });
    return;
  }

  setStatus('HLS is not supported in this browser.', true);
}

function closePlayer() {
  destroyHls();
  els.video.pause();
  els.video.removeAttribute('src');
  els.video.load();
  els.playerSection.classList.add('hidden');
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll("'", '&#39;');
}

els.reloadBtn.addEventListener('click', () => {
  loadFeed();
});

els.closePlayerBtn.addEventListener('click', closePlayer);

(async () => {
  await loadConfig();
  await loadFeed();
})();
