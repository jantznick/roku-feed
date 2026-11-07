/**
 * DaddyLive (dembed.st player → edge.wedd48c.top) sealed playlists, over plain HTTP.
 *
 * The player fetches `{edge}/api/playlist-token?slug=premiumN` → { token, k, ttl },
 * loads `index.m3u8?t={token}`, and each segment line is base64url AES-CTR
 * ciphertext (key `k`, counter = media sequence in the low 64 bits). Decrypted
 * lines are absolute TikTok-CDN PNG URLs carrying the MPEG-TS.
 */

import crypto from 'crypto';
import { BROWSER_USER_AGENT } from '../src/proxy-payload.js';

export const DADDY_REFERER = 'https://dembed.st/';

const HEADERS = {
    'User-Agent': BROWSER_USER_AGENT,
    Accept: '*/*',
    Referer: DADDY_REFERER,
    Origin: 'https://dembed.st',
};

/** @type {Map<string, { token: string, key: Buffer, renewAt: number, expiresAt: number }>} */
const tokens = new Map();

/** @returns {{ edge: string, slug: string } | null} */
function parseDaddyPlaylistUrl(url) {
    try {
        const parsed = new URL(url);
        const match = parsed.pathname.match(/^\/(premium\d+)\/index\.m3u8$/);
        if (!/wedd48c\./i.test(parsed.hostname) || !match) {
            return null;
        }
        return { edge: parsed.origin, slug: match[1] };
    } catch {
        return null;
    }
}

export function isDaddyPlaylistUrl(url) {
    return parseDaddyPlaylistUrl(url) !== null;
}

async function getToken(edge, slug, { force = false } = {}) {
    const cacheKey = `${edge}/${slug}`;
    const cached = tokens.get(cacheKey);
    if (!force && cached && Date.now() < cached.renewAt) {
        return cached;
    }

    const response = await fetch(
        `${edge}/api/playlist-token?slug=${encodeURIComponent(slug)}`,
        { headers: HEADERS, signal: AbortSignal.timeout(8000) }
    );
    const json = response.ok ? await response.json().catch(() => null) : null;
    if (!json?.token || !json?.k) {
        throw new Error(`playlist-token HTTP ${response.status}`);
    }
    const ttlMs = Math.max(20, Number(json.ttl) || 120) * 1000;
    const entry = {
        token: json.token,
        key: Buffer.from(json.k, 'base64url'),
        renewAt: Date.now() + ttlMs / 2,
        expiresAt: Date.now() + ttlMs - 2000,
    };
    tokens.set(cacheKey, entry);
    return entry;
}

function decryptLine(line, key, sequence) {
    const counter = Buffer.alloc(16);
    counter.writeBigUInt64BE(BigInt(sequence), 8);
    const decipher = crypto.createDecipheriv(`aes-${key.length * 8}-ctr`, key, counter);
    return Buffer.concat([
        decipher.update(Buffer.from(line, 'base64url')),
        decipher.final(),
    ]).toString('utf8');
}

/** Sealed lines have no scheme; plain playlists pass through untouched. */
function openPlaylist(body, key) {
    let sequence = 0;
    return body.split('\n').map((raw) => {
        const line = raw.trim();
        if (!line) {
            return raw;
        }
        if (line.startsWith('#')) {
            const match = /^#EXT-X-MEDIA-SEQUENCE:\s*(\d+)/.exec(line);
            if (match) {
                sequence = Number(match[1]);
            }
            return raw;
        }
        const opened = line.includes('://') ? line : decryptLine(line, key, sequence);
        sequence++;
        return opened;
    }).join('\n');
}

/**
 * @param {string} url feed URL, e.g. https://edge.wedd48c.top/premium765/index.m3u8
 * @returns {Promise<string>} playlist with absolute segment URLs
 */
export async function fetchDaddyPlaylist(url) {
    const parsed = parseDaddyPlaylistUrl(url);
    if (!parsed) {
        throw new Error('not a Daddy playlist URL');
    }

    for (const force of [false, true]) {
        const { token, key } = await getToken(parsed.edge, parsed.slug, { force });
        const response = await fetch(
            `${parsed.edge}/${parsed.slug}/index.m3u8?t=${encodeURIComponent(token)}&_=${Date.now()}`,
            { headers: HEADERS, signal: AbortSignal.timeout(10000) }
        );
        if (response.status === 403 && !force) {
            continue;
        }
        const body = await response.text();
        if (!response.ok || !body.includes('#EXTM3U')) {
            throw new Error(`playlist HTTP ${response.status}`);
        }
        return openPlaylist(body, key);
    }
    throw new Error('playlist token rejected');
}
