/**
 * Unit checks for NHL ↔ hockey source merging (no network).
 * Run: node scripts/test-hockey-merge.mjs
 */
import assert from 'assert/strict';
import {
    applyPendingMergedStreams,
    findNhlTeamsInTitle,
    mergeNhlAndHockeySources,
    mergeStreamLinks,
    nhlPairKeyForGame,
    normalizeText,
    teamPairKey,
} from '../src/hockey-merge.js';

function testNormalize() {
    assert.equal(normalizeText('New York Rangers'), 'new york rangers');
    assert.equal(normalizeText('A & B'), 'a and b');
}

function testFindTeams() {
    const { teamIds } = findNhlTeamsInTitle('Seattle Kraken @ Detroit Red Wings');
    assert.equal(teamIds.length, 2);
    const pair = teamPairKey(teamIds);
    assert.ok(pair);

    const same = findNhlTeamsInTitle('Kraken vs Wings');
    assert.equal(teamPairKey(same.teamIds), pair);

    const none = findNhlTeamsInTitle('Western Michigan vs Michigan State');
    assert.ok(none.teamIds.length < 2 || teamPairKey(none.teamIds) !== pair);
}

function testMergeDuplicateSources() {
    const onhockey = {
        id: 'Kraken-vs-Wings-Thu',
        name: 'Seattle Kraken vs Detroit Red Wings',
        teams: ['Seattle Kraken', 'Detroit Red Wings'],
        league: 'NHL',
        source: 'onhockey',
        streamLinks: [{ provider: 'mtchor', url: 'https://onhockey.example/embed/1' }],
    };
    const streamed = {
        id: 'seattle-kraken-vs-detroit-red-wings-2026-11-06',
        name: 'Kraken @ Wings',
        teams: ['Kraken', 'Wings'],
        league: 'ICE HOCKEY',
        source: 'ppv',
        streamLinks: [
            {
                name: 'HD',
                url: 'https://cdn.example/live.m3u8',
                embedUrl: 'https://embed.example/1',
                headers: { Referer: 'https://ppv.st/' },
            },
        ],
    };

    const merged = mergeNhlAndHockeySources([onhockey, streamed, {
        id: 'cubs',
        name: 'Cubs vs Cards',
        league: 'BASEBALL',
        streamLinks: [],
    }]);

    assert.equal(merged.length, 2);
    const hockey = merged.find((g) => g.league === 'NHL');
    assert.ok(hockey);
    assert.equal(hockey.id, onhockey.id);
    assert.ok(hockey.pendingMergedStreams?.length === 1);
    assert.equal(hockey.pendingMergedStreams[0].url, streamed.streamLinks[0].url);
    assert.ok(merged.some((g) => g.id === 'cubs'));
}

function testRebucketPpvOnly() {
    const streamed = {
        id: 'only-ppv',
        name: 'Boston Bruins vs Toronto Maple Leafs',
        league: 'HOCKEY',
        streamLinks: [{ url: 'https://cdn.example/a.m3u8' }],
    };
    const merged = mergeNhlAndHockeySources([streamed]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].league, 'NHL');
    assert.equal(merged[0].id, 'only-ppv');
}

function testNonNhlHockeyStaysHockey() {
    const khl = {
        id: 'khl-1',
        name: 'CSKA Moscow vs SKA St Petersburg',
        league: 'ICE HOCKEY',
        streamLinks: [],
    };
    const merged = mergeNhlAndHockeySources([khl]);
    assert.equal(merged[0].league, 'HOCKEY');
}

function testApplyPending() {
    const game = {
        id: '1',
        streamLinks: [{ url: 'https://a.m3u8' }],
        pendingMergedStreams: [{ url: 'https://b.m3u8', embedUrl: 'e1' }],
    };
    const [out] = applyPendingMergedStreams([game]);
    assert.equal(out.streamLinks.length, 2);
    assert.equal(out.pendingMergedStreams, undefined);
}

function testMergeStreamLinksDedupes() {
    const a = [{ url: 'https://x.m3u8', embedUrl: 'e1' }];
    const b = [{ url: 'https://y.m3u8', embedUrl: 'e1' }, { url: 'https://z.m3u8' }];
    const out = mergeStreamLinks(a, b, 5);
    assert.equal(out.length, 2);
    assert.equal(out[0].url, 'https://x.m3u8');
    assert.equal(out[1].url, 'https://z.m3u8');
}

function testPairKeyOrderIndependent() {
    const a = nhlPairKeyForGame({ name: 'Rangers vs Islanders' });
    const b = nhlPairKeyForGame({ name: 'Islanders at Rangers' });
    assert.ok(a);
    assert.equal(a, b);
}

const tests = [
    testNormalize,
    testFindTeams,
    testMergeDuplicateSources,
    testRebucketPpvOnly,
    testNonNhlHockeyStaysHockey,
    testApplyPending,
    testMergeStreamLinksDedupes,
    testPairKeyOrderIndependent,
];

let failed = 0;
for (const fn of tests) {
    try {
        fn();
        console.log(`ok  ${fn.name}`);
    } catch (error) {
        failed += 1;
        console.error(`fail ${fn.name}:`, error.message);
    }
}

if (failed) {
    console.error(`\n${failed} test(s) failed`);
    process.exit(1);
}
console.log(`\n${tests.length} tests passed`);
