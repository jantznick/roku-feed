const FEED_STORAGE_KEY = 'rokuFeedViewer.feedUrl';
const LEAGUE_STORAGE_KEY = 'rokuFeedViewer.league';

const META_KEYS = new Set(['providerName', 'lastUpdated', 'language', 'scriptDuration']);

const els = {
  settingsBtn: document.getElementById('settingsBtn'),
  settingsPanel: document.getElementById('settingsPanel'),
  feedUrlInput: document.getElementById('feedUrlInput'),
  saveFeedBtn: document.getElementById('saveFeedBtn'),
  reloadBtn: document.getElementById('reloadBtn'),
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
let activeGame = null;
/** @type {any} */
let hls = null;

function setStatus(message, isError = false) {
  els.status.textContent = message || '';
  els.status.classList.toggle('error', Boolean(isError));
}

function getStoredFeedUrl() {
  return localStorage.getItem(FEED_STORAGE_KEY) || '';
}

function leagueEntries(data) {
  return Object.keys(data).filter((key) => Array.isArray(data[key]) && !META_KEYS.has(key));
}

async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    if (!res.ok) return;
    const config = await res.json();
    if (!getStoredFeedUrl() && config.defaultFeedUrl) {
      els.feedUrlInput.value = config.defaultFeedUrl;
    }
  } catch {
    // optional
  }
}

async function loadFeed(url) {
  const feedUrl = (url || els.feedUrlInput.value || '').trim();
  if (!feedUrl) {
    els.settingsPanel.classList.remove('hidden');
    setStatus('Set a feed URL to continue.', true);
    return;
  }

  setStatus('Loading feed…');
  els.gameList.innerHTML = '<p class="empty">Loading…</p>';

  try {
    const res = await fetch(`/api/feed?url=${encodeURIComponent(feedUrl)}`);
    const payload = await res.json();
    if (!res.ok) {
      throw new Error(payload.error || `Feed error ${res.status}`);
    }

    feed = payload;
    leagues = leagueEntries(feed);
    localStorage.setItem(FEED_STORAGE_KEY, feedUrl);
    els.feedUrlInput.value = feedUrl;

    const savedLeague = localStorage.getItem(LEAGUE_STORAGE_KEY);
    activeLeague = leagues.includes(savedLeague) ? savedLeague : (leagues[0] || '');

    renderLeagues();
    renderGames();
    setStatus(
      feed.lastUpdated
        ? `Updated ${new Date(feed.lastUpdated).toLocaleString()} · ${leagues.length} leagues`
        : `Loaded ${leagues.length} leagues`
    );
  } catch (error) {
    feed = null;
    leagues = [];
    els.leagueNav.innerHTML = '';
    els.gameList.innerHTML = '<p class="empty">Could not load feed.</p>';
    setStatus(error.message || 'Failed to load feed', true);
    els.settingsPanel.classList.remove('hidden');
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
  activeGame = game;
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

function playUrl(url, label = '') {
  destroyHls();
  const video = els.video;
  video.pause();
  video.removeAttribute('src');
  video.load();

  setStatus(label ? `Playing ${label}` : 'Playing…');

  if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = url;
    video.play().catch(() => {});
    return;
  }

  if (window.Hls?.isSupported()) {
    hls = new window.Hls({
      enableWorker: true,
      lowLatencyMode: true,
    });
    hls.loadSource(url);
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
  activeGame = null;
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

els.settingsBtn.addEventListener('click', () => {
  els.settingsPanel.classList.toggle('hidden');
});

els.saveFeedBtn.addEventListener('click', () => {
  loadFeed(els.feedUrlInput.value);
});

els.reloadBtn.addEventListener('click', () => {
  loadFeed(els.feedUrlInput.value || getStoredFeedUrl());
});

els.closePlayerBtn.addEventListener('click', closePlayer);

els.feedUrlInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    loadFeed(els.feedUrlInput.value);
  }
});

(async function init() {
  await loadConfig();
  const stored = getStoredFeedUrl();
  if (stored) {
    els.feedUrlInput.value = stored;
    els.settingsPanel.classList.add('hidden');
    await loadFeed(stored);
  } else if (els.feedUrlInput.value) {
    els.settingsPanel.classList.add('hidden');
    await loadFeed(els.feedUrlInput.value);
  } else {
    els.settingsPanel.classList.remove('hidden');
    setStatus('Paste your feed URL to start.');
  }
})();
