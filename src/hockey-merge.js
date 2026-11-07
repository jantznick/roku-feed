/**
 * Combine onhockey (NHL) and ppv.st (HOCKEY / ICE HOCKEY) listings for the
 * same matchup into one feed game.
 *
 * Matching mirrors plexflix/scores: dictionary aliases → NHL team ids → pair
 * equality. Not open-ended fuzzy string similarity.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NHL_TEAMS_PATH = path.resolve(__dirname, '..', 'data', 'nhl-teams.json');

/** Max combined streams after a merge (same cap as each scraper). */
export const MAX_MERGED_STREAMS = 5;

/** Feed / scrape league labels that mean "generic ice hockey bucket". */
const GENERIC_HOCKEY_LEAGUES = new Set([
    'hockey',
    'ice hockey',
    'ice-hockey',
    'nhl',
]);

/**
 * Hand aliases from plexflix/scores (nhl EXTRA_ALIASES). Values are NHL abbrs.
 * Keep in sync when scores nicknames change.
 */
const EXTRA_ALIASES = {
    bolts: 'TB',
    lightning: 'TB',
    caps: 'WSH',
    capitals: 'WSH',
    hawks: 'CHI',
    blackhawks: 'CHI',
    jackets: 'CBJ',
    'blue jackets': 'CBJ',
    canes: 'CAR',
    hurricanes: 'CAR',
    avs: 'COL',
    avalanche: 'COL',
    preds: 'NSH',
    predators: 'NSH',
    yotes: 'UTAH',
    coyotes: 'UTAH',
    utah: 'UTAH',
    mammoth: 'UTAH',
    'hockey club': 'UTAH',
    kraken: 'SEA',
    leafs: 'TOR',
    'maple leafs': 'TOR',
    habs: 'MTL',
    canadiens: 'MTL',
    montreal: 'MTL',
    sens: 'OTT',
    senators: 'OTT',
    isles: 'NYI',
    islanders: 'NYI',
    rangers: 'NYR',
    nyr: 'NYR',
    nyi: 'NYI',
    devils: 'NJD',
    nj: 'NJD',
    njd: 'NJD',
    wings: 'DET',
    'red wings': 'DET',
    pens: 'PIT',
    penguins: 'PIT',
    'golden knights': 'VGK',
    knights: 'VGK',
    vegas: 'VGK',
    'la kings': 'LA',
    kings: 'LA',
    sj: 'SJ',
    sharks: 'SJ',
    'san jose': 'SJ',
};

const NON_ALNUM = /[^a-z0-9]+/g;

let cachedAliasIndex = null;

export function normalizeText(value) {
    const text = String(value || '')
        .toLowerCase()
        .replace(/[’`]/g, "'")
        .replace(/&/g, ' and ');
    return text.replace(NON_ALNUM, ' ').replace(/\s+/g, ' ').trim();
}

export function normalizeLeagueKey(league) {
    return normalizeText(String(league || '').replace(/_/g, ' ').replace(/-/g, ' '));
}

export function isGenericHockeyLeague(league) {
    return GENERIC_HOCKEY_LEAGUES.has(normalizeLeagueKey(league));
}

export function isNhlFamilyLeague(league) {
    const key = normalizeLeagueKey(league);
    return key === 'nhl' || isGenericHockeyLeague(league);
}

function loadNhlTeams() {
    const raw = JSON.parse(fs.readFileSync(NHL_TEAMS_PATH, 'utf8'));
    if (!Array.isArray(raw)) {
        throw new Error('data/nhl-teams.json must be an array');
    }
    return raw;
}

function addAlias(index, alias, teamId) {
    const key = normalizeText(alias);
    if (!key || key.length < 2) return;
    if (!index.has(key)) index.set(key, new Set());
    index.get(key).add(String(teamId));
}

/**
 * Build {normalizedAlias → Set(teamId)} for NHL.
 * @returns {Map<string, Set<string>>}
 */
export function buildNhlAliasIndex(teams = loadNhlTeams()) {
    const index = new Map();
    const byAbbr = new Map();

    for (const team of teams) {
        const tid = String(team.id);
        byAbbr.set(String(team.abbreviation || '').toUpperCase(), team);
        for (const field of [
            'abbreviation',
            'name',
            'location',
            'displayName',
            'shortDisplayName',
        ]) {
            addAlias(index, team[field] || '', tid);
        }
        const slug = String(team.slug || '').replace(/-/g, ' ');
        addAlias(index, slug, tid);
    }

    for (const [alias, abbr] of Object.entries(EXTRA_ALIASES)) {
        const team = byAbbr.get(String(abbr).toUpperCase());
        if (team) addAlias(index, alias, team.id);
    }

    return index;
}

function getAliasIndex() {
    if (!cachedAliasIndex) {
        cachedAliasIndex = buildNhlAliasIndex();
    }
    return cachedAliasIndex;
}

/**
 * Find NHL team ids mentioned in a title (longer aliases win / consume span).
 * @returns {{ teamIds: string[], hits: object[], ambiguous: object[] }}
 */
export function findNhlTeamsInTitle(title, aliasIndex = getAliasIndex()) {
    const norm = normalizeText(title);
    if (!norm) {
        return { teamIds: [], hits: [], ambiguous: [] };
    }

    const aliases = [...aliasIndex.keys()].sort((a, b) => b.length - a.length || a.localeCompare(b));
    const tokens = norm.split(' ');
    const used = tokens.map(() => false);
    const hits = [];
    const ambiguous = [];

    for (const alias of aliases) {
        const aliasTokens = alias.split(' ');
        const n = aliasTokens.length;
        if (!n) continue;
        for (let i = 0; i <= tokens.length - n; i++) {
            if (used.slice(i, i + n).some(Boolean)) continue;
            let match = true;
            for (let k = 0; k < n; k++) {
                if (tokens[i + k] !== aliasTokens[k]) {
                    match = false;
                    break;
                }
            }
            if (!match) continue;
            const teamIds = [...aliasIndex.get(alias)].sort();
            for (let j = i; j < i + n; j++) used[j] = true;
            const entry = { alias, teamIds, span: [i, i + n] };
            if (teamIds.length === 1) hits.push(entry);
            else ambiguous.push(entry);
        }
    }

    const teamIds = [];
    for (const hit of hits) {
        const tid = hit.teamIds[0];
        if (!teamIds.includes(tid)) teamIds.push(tid);
    }

    return { teamIds, hits, ambiguous };
}

/**
 * Stable pair key for two team ids (order-independent).
 * @param {string[]} teamIds
 * @returns {string|null}
 */
export function teamPairKey(teamIds) {
    if (!Array.isArray(teamIds) || teamIds.length < 2) return null;
    return [...teamIds].map(String).sort().join('|');
}

/**
 * Resolve a game to an NHL team-pair key, or null if not two NHL teams.
 */
export function nhlPairKeyForGame(game, aliasIndex = getAliasIndex()) {
    const title = game?.name || game?.title || '';
    // Prefer structured teams from scrapers when present.
    if (Array.isArray(game?.teams) && game.teams.filter(Boolean).length >= 2) {
        const fromTeams = findNhlTeamsInTitle(game.teams.filter(Boolean).join(' vs '), aliasIndex);
        const key = teamPairKey(fromTeams.teamIds);
        if (key) return key;
    }
    const fromTitle = findNhlTeamsInTitle(title, aliasIndex);
    return teamPairKey(fromTitle.teamIds);
}

function streamIdentity(stream) {
    if (stream?.embedUrl) return `e:${stream.embedUrl}`;
    if (stream?.url) return `u:${stream.url}`;
    return '';
}

/**
 * Merge stream link arrays; prefer earlier entries; dedupe by embed/url.
 */
export function mergeStreamLinks(primary = [], secondary = [], max = MAX_MERGED_STREAMS) {
    const out = [];
    const seen = new Set();
    for (const stream of [...primary, ...secondary]) {
        if (!stream) continue;
        const id = streamIdentity(stream);
        if (id && seen.has(id)) continue;
        if (id) seen.add(id);
        out.push(stream);
        if (out.length >= max) break;
    }
    return out;
}

function isOnHockeyGame(game) {
    // Prefer explicit source when annotated (tests / future scrapers).
    if (game?.source === 'onhockey') return true;
    if (game?.source === 'ppv' || game?.source === 'streamed') return false;

    const links = game?.streamLinks || [];
    const hasResolvedM3u8 = links.some((s) => s?.url && /\.m3u8(\?|$)/i.test(s.url));
    const hasProviderCandidate = links.some((s) => s?.provider);
    // onhockey list rows: provider + raw embed/page URL, no HLS yet.
    if (hasProviderCandidate && !hasResolvedM3u8) return true;
    // ppv.st rows arrive already resolved to HLS.
    if (hasResolvedM3u8 && !hasProviderCandidate) return false;

    return normalizeLeagueKey(game?.league) === 'nhl';
}

/**
 * Combine NHL (onhockey) + generic hockey (ppv.st) games that share a team pair.
 *
 * - Matched pairs → one game under league `NHL`, onhockey id preferred, streams
 *   from both (ppv streams stashed on `pendingMergedStreams` until deep scrape).
 * - Unmatched ppv hockey that still resolves to two NHL teams → rebucket to `NHL`.
 * - Remaining generic hockey → league `HOCKEY`.
 *
 * Non-hockey games are returned unchanged.
 *
 * @param {object[]} games
 * @returns {object[]}
 */
export function mergeNhlAndHockeySources(games, aliasIndex = getAliasIndex()) {
    if (!Array.isArray(games) || games.length === 0) return games || [];

    const nhlFamily = [];
    const others = [];

    for (const game of games) {
        if (isNhlFamilyLeague(game.league) || normalizeLeagueKey(game.league) === 'nhl rookie camp') {
            // Rookie camp stays its own row — do not merge into NHL/HOCKEY.
            if (normalizeLeagueKey(game.league) === 'nhl rookie camp') {
                others.push(game);
            } else {
                nhlFamily.push(game);
            }
        } else {
            others.push(game);
        }
    }

    /** @type {Map<string, object[]>} */
    const byPair = new Map();
    const unmatched = [];

    for (const game of nhlFamily) {
        const pair = nhlPairKeyForGame(game, aliasIndex);
        if (!pair) {
            unmatched.push(game);
            continue;
        }
        if (!byPair.has(pair)) byPair.set(pair, []);
        byPair.get(pair).push(game);
    }

    const merged = [];
    let mergeCount = 0;
    let rebucketCount = 0;

    for (const group of byPair.values()) {
        if (group.length === 1) {
            const only = group[0];
            if (isGenericHockeyLeague(only.league)) {
                rebucketCount += 1;
                merged.push({ ...only, league: 'NHL' });
            } else {
                merged.push(only);
            }
            continue;
        }

        // Prefer onhockey / explicit NHL listing as the survivor.
        const sorted = [...group].sort((a, b) => {
            const aOn = isOnHockeyGame(a) ? 0 : 1;
            const bOn = isOnHockeyGame(b) ? 0 : 1;
            if (aOn !== bOn) return aOn - bOn;
            const aNhl = normalizeLeagueKey(a.league) === 'nhl' ? 0 : 1;
            const bNhl = normalizeLeagueKey(b.league) === 'nhl' ? 0 : 1;
            return aNhl - bNhl;
        });

        const primary = { ...sorted[0], league: 'NHL' };
        const pending = [];
        for (let i = 1; i < sorted.length; i++) {
            const other = sorted[i];
            // ppv.st links are already resolved HLS; attach after onhockey deep scrape.
            if (Array.isArray(other.streamLinks) && other.streamLinks.length) {
                const looksResolved = other.streamLinks.some(
                    (s) => s?.url && /\.m3u8(\?|$)/i.test(s.url)
                );
                if (looksResolved && isOnHockeyGame(primary) && !isOnHockeyGame(other)) {
                    pending.push(...other.streamLinks);
                } else {
                    primary.streamLinks = mergeStreamLinks(
                        primary.streamLinks || [],
                        other.streamLinks || []
                    );
                }
            }
        }
        if (pending.length) {
            primary.pendingMergedStreams = mergeStreamLinks(
                primary.pendingMergedStreams || [],
                pending
            );
        }
        if (sorted.length > 1) {
            mergeCount += 1;
            primary.mergedFromIds = sorted.map((g) => g.id);
            console.log(
                `🏒 Merged NHL/hockey sources for "${primary.name}" ` +
                `(${sorted.map((g) => g.id).join(' + ')})`
            );
        }
        merged.push(primary);
    }

    // Unmatched generic hockey (KHL, etc.) → HOCKEY; unmatched NHL stays NHL.
    for (const game of unmatched) {
        if (isGenericHockeyLeague(game.league) && normalizeLeagueKey(game.league) !== 'nhl') {
            merged.push({ ...game, league: 'HOCKEY' });
        } else if (isGenericHockeyLeague(game.league)) {
            // Tagged nhl-ish but couldn't resolve two teams — keep as NHL bucket.
            merged.push({ ...game, league: 'NHL' });
        } else {
            merged.push(game);
        }
    }

    if (mergeCount || rebucketCount) {
        console.log(
            `Hockey source merge: ${mergeCount} combined matchup(s), ` +
            `${rebucketCount} ppv hockey game(s) filed under NHL.`
        );
    }

    return [...merged, ...others];
}

/**
 * After onhockey deep scrape, fold in any ppv streams stashed during merge.
 * @param {object[]} games
 * @returns {object[]}
 */
export function applyPendingMergedStreams(games) {
    return (games || []).map((game) => {
        if (!game?.pendingMergedStreams?.length) return game;
        const { pendingMergedStreams, ...rest } = game;
        return {
            ...rest,
            streamLinks: mergeStreamLinks(rest.streamLinks || [], pendingMergedStreams),
        };
    });
}

/** Test helper — clear cached alias index. */
export function _resetAliasCacheForTests() {
    cachedAliasIndex = null;
}
