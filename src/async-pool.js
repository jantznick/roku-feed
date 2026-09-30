/**
 * Lightweight async concurrency pool — no external deps.
 * Used to run Puppeteer embed resolves (and similar) with a bounded
 * number of in-flight tasks while preserving input order in the results.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Coerce a concurrency hint to a positive integer.
 * Non-finite / <= 0 values become 1 so callers never dead-lock the pool.
 * @param {unknown} concurrency
 * @returns {number}
 */
function normalizeConcurrency(concurrency) {
    const n = Number(concurrency);
    if (!Number.isFinite(n) || n <= 0) {
        return 1;
    }
    return Math.floor(n);
}

/**
 * Run async tasks over `items` with at most `concurrency` in flight.
 * Preserves result order matching `items`.
 *
 * Early stop (`shouldStop`):
 * - Checked before scheduling each new item (not mid-mapper).
 * - Already-started work is always allowed to finish.
 * - Items that were never started get `null` in the result array
 *   (slots stay aligned with `items` indices).
 *
 * @template T, R
 * @param {Iterable<T>|ArrayLike<T>|null|undefined} items
 * @param {number} concurrency
 * @param {(item: T, index: number) => Promise<R>|R} mapper
 * @param {{ shouldStop?: () => boolean }} [options]
 * @returns {Promise<Array<R|null>>}
 */
export async function mapPool(items, concurrency, mapper, { shouldStop } = {}) {
    const list = items == null ? [] : Array.from(items);
    const length = list.length;
    /** @type {Array<R|null|undefined>} */
    const results = new Array(length);

    if (length === 0) {
        return results;
    }

    if (typeof mapper !== 'function') {
        throw new TypeError('mapPool: mapper must be a function');
    }

    const limit = Math.min(normalizeConcurrency(concurrency), length);
    let nextIndex = 0;

    /**
     * Claim the next index if work should continue; otherwise signal stop.
     * Returns -1 when this worker should exit (no more work to start).
     */
    function claimNext() {
        if (typeof shouldStop === 'function' && shouldStop()) {
            return -1;
        }
        if (nextIndex >= length) {
            return -1;
        }
        return nextIndex++;
    }

    async function worker() {
        for (;;) {
            const index = claimNext();
            if (index < 0) {
                return;
            }
            // Await in isolation so one rejection does not strand siblings;
            // callers that want soft-fail should catch inside mapper.
            results[index] = await mapper(list[index], index);
        }
    }

    const workers = [];
    for (let w = 0; w < limit; w++) {
        workers.push(worker());
    }
    await Promise.all(workers);

    // Fill slots that were never scheduled (early stop) with null.
    for (let i = 0; i < length; i++) {
        if (results[i] === undefined) {
            results[i] = null;
        }
    }

    return /** @type {Array<R|null>} */ (results);
}

/**
 * Max concurrent Puppeteer embed resolves.
 * Reads `process.env.EMBED_CONCURRENCY`, default 4, clamped to 1..8.
 * @returns {number}
 */
export function getEmbedConcurrency() {
    const raw = process.env.EMBED_CONCURRENCY;
    if (raw === undefined || raw === '') {
        return 4;
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) {
        return 4;
    }
    return Math.min(8, Math.max(1, Math.floor(n)));
}

// ---------------------------------------------------------------------------
// Self-check — run with: node src/async-pool.js
// ---------------------------------------------------------------------------
const isDirectRun =
    Boolean(process.argv[1]) &&
    path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

if (isDirectRun) {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    // Order preserved under concurrency > 1
    {
        const items = [1, 2, 3, 4, 5];
        const out = await mapPool(items, 3, async (n) => {
            await sleep(5 * (6 - n)); // slower for smaller n → finish out of order
            return n * 10;
        });
        assert.deepEqual(out, [10, 20, 30, 40, 50]);
    }

    // concurrency <= 0 treated as 1
    {
        const seen = [];
        await mapPool([1, 2, 3], 0, async (n) => {
            seen.push(`start:${n}`);
            await sleep(10);
            seen.push(`end:${n}`);
            return n;
        });
        // With concurrency 1, starts and ends must nest sequentially
        assert.deepEqual(seen, [
            'start:1', 'end:1',
            'start:2', 'end:2',
            'start:3', 'end:3',
        ]);
    }

    // shouldStop: don't start new work; skipped slots are null; in-flight finish
    {
        let started = 0;
        let stop = false;
        const out = await mapPool([0, 1, 2, 3, 4], 2, async (n) => {
            started += 1;
            if (started >= 2) {
                stop = true;
            }
            await sleep(20);
            return `done:${n}`;
        }, { shouldStop: () => stop });

        // First two claimed before stop flips; remaining are null
        assert.equal(out.filter((v) => v !== null).length, 2);
        assert.ok(out.slice(2).every((v) => v === null));
        assert.ok(out[0] === 'done:0' || out[0] === null);
        assert.equal(started, 2);
    }

    // getEmbedConcurrency clamp / default
    {
        const prev = process.env.EMBED_CONCURRENCY;
        try {
            delete process.env.EMBED_CONCURRENCY;
            assert.equal(getEmbedConcurrency(), 4);
            process.env.EMBED_CONCURRENCY = '0';
            assert.equal(getEmbedConcurrency(), 1);
            process.env.EMBED_CONCURRENCY = '99';
            assert.equal(getEmbedConcurrency(), 8);
            process.env.EMBED_CONCURRENCY = '3';
            assert.equal(getEmbedConcurrency(), 3);
            process.env.EMBED_CONCURRENCY = 'nope';
            assert.equal(getEmbedConcurrency(), 4);
        } finally {
            if (prev === undefined) {
                delete process.env.EMBED_CONCURRENCY;
            } else {
                process.env.EMBED_CONCURRENCY = prev;
            }
        }
    }

    console.log('async-pool self-check: ok');
}
