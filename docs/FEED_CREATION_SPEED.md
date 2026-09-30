# Feed creation speed — research notes

Research against the current scraper → B2 JSON pipeline (`src/index.js`), with an eye on the configurable-feeds / multi-publisher direction (`backend/`, `docs/CONFIGURABLE_FEEDS.md`).

**Goal of this doc:** evaluate five speed ideas without implementing them yet — where each fits, what it changes, risks, and how it overlaps with a future DB-driven catalog.

---

## Current process (baseline)

```
Launch Chromium
  → load previous feed (B2 or dist/feed.json)
  → scrape onhockey.tv list          [optional via SKIP_ONHOCKEY]
  → scrape Streamed.pk live matches
       GET /api/matches/live  (fast)
       GET /api/stream/...    (fast)
       Puppeteer resolve every embed → m3u8  (slow, sequential)
  → scrape 24/7 channels (same embed resolve)
  → compareGames(previous, current)  ← after Streamed already deep-resolved
  → deepScrapeGames for onhockey new+updated only
  → posters / B2 image upload
  → assemble full JSON → write dist/feed.json → upload B2
```

### Where time goes

| Phase | Cost today | Notes |
|-------|------------|--------|
| Streamed API list + stream metadata | Low | HTTP only |
| **Embed → m3u8 resolve** | **Dominant** | ~3–15s per embed; max 5 embeds/game; **fully serial** in `streamed-scraper.js` |
| onhockey deep scrape | High when enabled | Serial; only for new/updated (good) |
| Image gen / upload | Low–medium | Often skipped when posters exist |
| Assemble + B2 feed upload | Low | Single JSON object |

Sample dry run in `feed_creation.txt`: **~43–64s for only 3 live games** (~10 embeds), with `SKIP_ONHOCKEY=true`. Almost all wall time is sequential “Navigating to embed URL…”.

### Important asymmetry

- **onhockey:** cheap list scrape first → `compareGames` → expensive deep scrape **only for new/updated**.
- **Streamed / 24/7:** expensive Puppeteer resolve happens **before** `compareGames`, so “unchanged” never saves embed work for those sources.

### Why “unchanged” rarely helps Streamed today

`getStreamSignature()` fingerprints **raw m3u8 URLs**. Streamed CDN hosts (`strmd.st`, signed query tokens, etc.) rotate every run, so the same game is almost always marked **updated** (`0 unchanged, 3 to update` in the sample log). Diffing on URL equality cannot skip re-resolve.

Clients (Roku `MainLoaderTask`, Expo pull-to-refresh) load the **whole** feed URL once per refresh. There is no mid-run partial consume of B2.

---

## Idea 1 — Prioritize sports or teams

### Intent

Focus scrape work on preferred sports/teams so the feed appears faster (or finishes faster when the live slate is large).

### How it fits today

Selection is **hardcoded**, not preference-driven:

| Knob | Location | Effect |
|------|----------|--------|
| `sportsCategories` | `src/index.js` | Which Streamed categories to keep |
| `leaguesToScrape` | `src/scraper.js` | onhockey leagues |
| `channelMap` | `src/streamed-scraper.js` | 24/7 titles |
| `PRIORITY_TEAMS_BY_LEAGUE` | `src/index.js` | **Display sort only** — does not skip scrape |
| Expo `favoriteTeams` | RN settings types | **Not used** by the scraper |

### Ways to implement (keep existing mechanism)

1. **Env / config filter (smallest change)**  
   e.g. `SPORTS_CATEGORIES=hockey,baseball` and `PRIORITY_TEAMS=Chicago Cubs,...`. Filter the live match list **before** embed resolve. Same pipeline; less work.

2. **Two-phase priority pass**  
   - Pass A: resolve priority sports/teams first → optional early publish (see ideas 3/4).  
   - Pass B: fill in the rest.  
   Keeps one feed; changes *ordering of work*, not the product shape.

3. **User/account preferences (overlaps DB future)**  
   Store preferred sports/teams in Postgres (near `User.feedUrl`) and have the scraper (or a per-user feed builder) honor them. Bigger product change; aligns with multi-publisher / personalized catalogs later.

### Process change

```
GET live matches
  → filter / rank by sport & team config   ← NEW
  → resolve embeds (priority first or only)
  → rest of pipeline unchanged
```

### Impact

- **High leverage when many games are live** (football + soccer nights): linear savings on embed count.
- **Low leverage when only a few games are live** (sample run: 3 games) — prioritizing doesn’t shrink much.
- Does not fix URL-rotation “always update” behavior by itself.

### Risks / product notes

- Narrow filters can empty the grid for other sports.
- Priority-as-sort (current) ≠ priority-as-scrape-budget; naming should be clear in config.
- Personalized per-user scrapes multiply cost unless you share one global scrape and filter at serve time (idea 4 / DB path).

### Fit with DB-driven future

**Strong overlap if personalization is the end state:** scrape everything once (or once per shared slate), store games in DB, serve filtered views per user. Short-term env filters are still useful and throwaway-cheap.

---

## Idea 2 — Don’t rescrape feed URLs for games already on the feed

### Intent

Reuse streams already in the last feed so Puppeteer isn’t paid again for the same match.

### How it fits today

The *intent* already exists in comments (`compareGames`: unchanged left as-is), but Streamed undermines it:

1. Deep-resolve runs **before** the diff.
2. Diff keys off **rotating m3u8 URLs**, so games almost never stay “unchanged.”
3. onhockey already skips deep scrape for unchanged — the pattern to copy.

### What “don’t rescrape” should mean

Skip **embed resolution**, not “assume CDN URLs live forever.”

Recommended stale model:

| Signal | Use |
|--------|-----|
| Stable game `id` still in live API | Still on the slate |
| `confirmedAt` / age TTL (e.g. 10–30 min) | Re-resolve when stale |
| Embed identity (`embed.st/.../admin/.../1`) or Streamed source+id | Detect new sources without comparing m3u8 |
| Cheap HEAD/GET of existing m3u8 (optional) | Refresh only if dead |

Pseudo-flow for Streamed (mirrors onhockey):

```
GET /api/matches/live (+ /api/stream for embed list)   # cheap
compare to previous feed by game id + embed set + TTL
  → new / new embeds / TTL expired  → Puppeteer resolve
  → still live + fresh confirmedAt  → reuse previous videos[] (+ streamSignature)
assemble / publish
```

### Process change

Move Streamed’s expensive loop to **after** a cheap identity/TTL diff — same architectural order as onhockey `deepScrapeGames`.

May need to store in the feed (or a side cache):

- `confirmedAt` (already on videos)
- embed URL or source key (today mainly inside proxy payload / not first-class on items)
- optionally `expiresAt` guess from signed URL query params when present

### Impact

- **Largest single win for cron frequency** if most games persist across ticks (every 5–15 min).
- Sample run would go from ~10 resolves → often **0** if TTL allows reuse.
- Must still re-resolve when tokens die; TTL too long → more dead links in the feed.

### Risks

- Stale signed URLs → playback failures until next successful resolve.
- Proxy/LAN URLs in the feed encode the old upstream; reuse is fine if upstream still works.
- `streamSignature` should eventually fingerprint **embed/source identity**, not raw CDN URL, or “unchanged” stays meaningless.

### Fit with DB-driven future

**Natural overlap.** A `streams` / `game_sources` table with `last_confirmed_at`, `embed_url`, `m3u8_url` is exactly this cache. Doing TTL reuse in the scraper now is a stepping stone; migrating the cache into Postgres later is straightforward.

---

## Idea 3 — Don’t wait for the whole run to update the feed

### Intent

Clients see new/priority games before the full scrape finishes.

### How it fits today

Publication is **atomic at the end**: one `dist/feed.json` write + one B2 `uploadFeed()`. Clients fetch that whole object. No progress API.

### Options that keep the current mechanism

1. **Checkpoint upload (simplest)**  
   After priority games (or after each N games) are resolved: merge into the in-memory feed → upload B2 again → continue.  
   Same URL, same format; clients that refresh mid-run see a partial-but-valid feed.

2. **Two-file / staging feed**  
   Publish `feed-partial.json` early; swap/rename to primary when done. Clients need a URL change or the uploader overwrites the secret name only at checkpoints (same as 1).

3. **True streaming API**  
   Push rows as they’re ready (idea 4). Not possible with static B2 alone without polling the same URL.

### Process change

```
... resolve batch of games ...
  → merge into feed object
  → uploadFeed() checkpoint          ← NEW (optional, rate-limited)
... continue ...
  → final uploadFeed()
```

### Impact

- Improves **time-to-first-useful-content**, not total CPU time.
- Pairs well with idea 1 (priority pass) and idea 5 (parallel resolve).
- Roku/Expo only benefit if the user/app **reloads** during the run (no background poll today on Roku grid).

### Risks

- Mid-run feed may briefly omit non-priority sports or still list games that will be removed later in the same run.
- More B2 writes; need crash-safety (never upload corrupt JSON).
- Concurrent scraper runs could race on the same object key.

### Fit with DB-driven future

Checkpointing static JSON is a **stopgap**. A DB/API naturally supports “rows appear as they’re scraped” without rewriting a whole blob. If idea 4 is near-term, heavy investment in multi-upload checkpointing may not pay off beyond one priority checkpoint.

---

## Idea 4 — Key-protected cloud API + DB instead of CDN static feed

### Intent

Host feed details in a DB; clients hit a small authenticated API instead of (or in addition to) the B2 JSON file.

### How it fits today

| Layer | Today |
|-------|--------|
| Catalog | Static JSON on Backblaze B2 |
| Backend Postgres | Users, `feedUrl` **pointer**, devices, auth — **not** games |
| Clients | `fetch(feedUrl)` expecting Roku-shaped JSON |

Configurable feeds already taught clients: **resolve a URL from the API, then fetch the catalog**. Idea 4 moves the **catalog itself** behind an API.

### Sketch

```
Scraper (home / cron)
  → upsert games/streams into cloud DB
  → (optional) still mirror full JSON to B2 for fallback

Clients
  → GET /feed  (or /feed.json) with API key / device bearer / session
  → same JSON shape as today (least client churn)
```

Auth options that match existing pieces:

- Reuse **device bearer** / user session (already in `backend/`) for linked clients.
- Separate **scraper write key** (`Authorization: Bearer …`) for upsert-only from cron.
- Public read with unguessable path is closer to today’s secret B2 filename; a real key is stricter.

### Process change

Scraper’s final step becomes **upsert + optional B2 mirror**, not “only upload blob.”

Serving becomes:

```
GET /feed → assemble JSON from DB (or cache) → same schema as generateFeedShell + league arrays
```

Incremental updates (idea 3) fall out for free: each upsert is immediately readable.

### Impact

- Enables ideas 1 (per-user filter at read), 2 (DB as stream cache), 3 (live rows).
- Aligns with README “multi-publisher” / DB-driven direction more than any other idea.
- Adds ops: hosting, migrations, auth, backups, latency vs CDN edge cache.

### Risks / costs

- Bigger jump than scraper-only tweaks; touches backend + possibly all clients’ default URLs.
- Roku needs a reachable HTTPS API (`apiBaseUrl` already exists for pairing — catalog could share origin).
- Must keep **response shape** identical if you want zero player changes.
- Write path from home scraper → cloud DB needs reliable auth and idempotent upserts.
- CDN caching of API responses needs short TTL or purge-on-write so “live” stays live.

### Fit with DB-driven future

**This is the overlapping work.** Doing a minimal “FeedItem / Stream row + GET /feed” now is likely the first vertical slice of that migration. Prefer designing tables for games/streams/publishers rather than one opaque JSON blob column — but a blob column is a valid transitional step (`FeedSnapshot` updated by scraper).

**Pragmatic phasing:**

1. Keep B2; speed the scraper (ideas 1, 2, 5).  
2. Add DB upsert + `GET /feed` that returns the same JSON; point `DEFAULT_FEED_URL` / user `feedUrl` at the API.  
3. Drop B2 as source of truth when comfortable (keep as backup mirror if desired).

---

## Idea 5 — Multiple threads / parallelism for feed creation

### Intent

Resolve many embeds/games at once to cut wall-clock time.

### How it fits today

- One shared Puppeteer **browser**.
- Streamed: nested `for game / for embed` — **serial**.
- onhockey deep scrape: serial.
- Image generation: serial screenshots on one page.
- Only real parallelism today: `Promise.all([generateImages, downloadPosters])` and parallel poster HTTP downloads.

Node won’t help with true threads for this; **concurrent async workers** (multiple pages or browsers) will.

### Ways to implement

1. **Bounded page pool** (recommended first)  
   e.g. 3–5 concurrent `resolveStreamFromEmbed` calls on one browser (`p-limit`). Biggest win for Streamed nights.

2. **Multiple browsers**  
   More isolation if one page crashes the browser; higher RAM (Chromium × N).

3. **Parallelize independent sources**  
   onhockey list vs Streamed list can overlap; deep scrapes can share the pool.

4. **Parallel image upload**  
   Minor compared to embeds.

### Process change

```
for embed of embeds:
  await resolve...          →   await Promise.all(pool.map(...)) with limit
```

No client or feed-format change.

### Impact

- Near-linear speedup until CPU/RAM or remote rate limits.
- Example: 10 serial embeds × ~5s ≈ 50s → limit 4 ≈ ~15s (plus overhead).
- Complements idea 2 (less work) and idea 1 (priority queue into the pool).

### Risks

- Too much concurrency → site blocks, browser OOM, flaky `networkidle2`.
- Shared browser: one bad page can still take down the process; need careful `isBrowserConnected` handling (already present).
- Logging becomes interleaved; keep game/embed IDs in log lines.

### Fit with DB-driven future

Orthogonal and **safe to do now**. Parallel workers still feed whatever sink you use (B2 or DB). No wasted work if the catalog moves to Postgres.

---

## Cross-cutting: overlap with DB-driven / multi-publisher migration

What “DB-driven dynamic” likely means here (not fully designed in-repo yet):

| Today | Direction |
|-------|-----------|
| Scraper writes one public JSON blob | Scraper writes structured rows (publisher = sports) |
| Clients fetch B2 URL | Clients fetch API (auth already partially exists) |
| One global catalog | Optional per-user / per-publisher views |
| Backend stores only `feedUrl` | Backend stores catalog + still may expose URL-shaped JSON |

| Idea | Speeds current B2 path? | Overlaps DB migration? | Suggested timing |
|------|-------------------------|------------------------|------------------|
| **1 Priority sports/teams** | Yes (when slate is large) | Medium (prefs in DB later) | **Do soon** as env/config filter; defer per-user prefs |
| **2 Skip rescrape / TTL reuse** | **Yes — largest cron win** | **High** (stream cache → tables) | **Do soon** in scraper; design signatures for later DB |
| **3 Checkpoint / partial publish** | Improves perceived latency | High (DB makes this natural) | Light checkpoint OK; don’t overbuild if API is next |
| **4 Cloud API + DB** | Indirect (architecture) | **This is the migration** | Plan as next platform slice; unlocks 1+3 cleanly |
| **5 Parallel embed workers** | **Yes — largest single-run win** | None (compatible) | **Do soon**, independent |

### Suggested sequencing (keep existing mechanism, accelerate it)

```
Near-term (scraper-only, low product risk)
  5) Concurrent embed resolve (page pool)
  2) Cheap Streamed diff + TTL reuse before Puppeteer
  1) Config filters / priority resolve order

Optional bridge
  3) One priority checkpoint upload mid-run

Platform
  4) Upsert to Postgres + key/bearer GET /feed
     (reuse backend auth; keep JSON schema; B2 as mirror)
```

Doing **2 + 5** first attacks the measured bottleneck (sequential Puppeteer + re-resolve every cron) without requiring clients or hosting changes. Idea **4** is the right place to invest if the field is going DB-dynamic anyway — especially if you want incremental visibility and personalized sports/teams without re-scraping per user.

---

## Open design questions (when implementing)

1. **TTL for stream reuse** — how long until a “working” m3u8 is assumed stale? (signed URL `expires=` when present vs fixed 15m.)
2. **Priority semantics** — exclude non-priority sports, or scrape them later in the same run?
3. **API auth** — device/user bearer vs dedicated feed API key vs secret URL path?
4. **Single global scrape vs per-user scrape** — strongly prefer global scrape + filter at read if idea 4 lands.
5. **Removal timing** — with checkpoint publishes, when do ended games disappear from the partial feed?

---

## Key file map

| Concern | Files |
|---------|--------|
| Orchestration | `src/index.js` |
| Streamed resolve loop | `src/streamed-scraper.js` |
| Embed Puppeteer | `src/embed-resolver.js` |
| Diff / previous feed | `src/state-manager.js` |
| URL signature | `src/feed-generator.js` (`getStreamSignature`) |
| onhockey deep scrape (good incremental pattern) | `src/scraper.js` (`deepScrapeGames`) |
| B2 publish | `src/uploader.js` |
| Account feed URL (not catalog) | `backend/`, `docs/CONFIGURABLE_FEEDS.md` |
| Sample timing | `feed_creation.txt` |
