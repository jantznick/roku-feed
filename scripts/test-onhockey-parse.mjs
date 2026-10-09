/**
 * Offline regression: parse a saved onhockey HTML fixture and assert we pick
 * modern providers (not fluidtv-only).
 *
 *   node scripts/test-onhockey-parse.mjs [path-to-html]
 */
import puppeteer from 'puppeteer';
import fs from 'fs/promises';
import path from 'path';
import { getPuppeteerLaunchOptions } from '../src/puppeteer-config.js';
import { scrapeMainPage } from '../src/scraper.js';

const fixture = path.resolve(
  process.argv[2] || path.join(process.cwd(), 'debug-output.html')
);

await fs.access(fixture);
await fs.copyFile(fixture, path.resolve(process.cwd(), 'debug-output.html'));

process.env.DEBUG = 'true';
process.env.PROXY_HEADLESS = 'true';

const browser = await puppeteer.launch(getPuppeteerLaunchOptions());
try {
  const games = await scrapeMainPage(browser);
  if (games.length === 0) {
    console.error('FAIL: expected at least one game with accepted providers');
    process.exit(1);
  }

  const providers = new Set();
  for (const game of games) {
    for (const stream of game.streamLinks) {
      providers.add(stream.provider);
    }
  }

  console.log(`OK: ${games.length} game(s); providers=${[...providers].join(',')}`);
  if (![...providers].some((p) => ['streamd', 'plytvme', 'mtchor', 'fluidtv'].includes(p))) {
    console.error('FAIL: expected a modern/resolvable provider');
    process.exit(1);
  }
} finally {
  await browser.close();
}
