/**
 * Diagnostic probe for onhockey.tv: Cloudflare challenge, schedule URLs, providers.
 * Run: PROXY_HEADLESS=true node scripts/probe-onhockey.mjs
 */
import puppeteer from 'puppeteer';
import { getPuppeteerLaunchOptions } from '../src/puppeteer-config.js';
import fs from 'fs/promises';

const TARGETS = [
  'https://onhockey.tv/',
  'https://onhockey.tv/schedule_eng_online.html',
  'https://onhockey.tv/schedule_table_eng.php',
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function probeUrl(browser, url) {
  const page = await browser.newPage();
  const report = { url, steps: [] };

  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  );
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
  });

  // Light anti-automation fingerprint tweaks
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  page.on('response', (res) => {
    const u = res.url();
    if (u.includes('onhockey.tv') && !u.includes('cdn-cgi') && !u.includes('cloudflare')) {
      report.steps.push({
        type: 'response',
        status: res.status(),
        url: u.slice(0, 120),
        cfMitigated: res.headers()['cf-mitigated'] || null,
      });
    }
  });

  try {
    console.log(`\n=== Probing ${url} ===`);
    const nav = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
    report.navStatus = nav?.status();
    report.title = await page.title();
    report.finalUrl = page.url();
    console.log(`nav=${report.navStatus} title="${report.title}" final=${report.finalUrl}`);

    // Wait for either challenge clear or gametable
    const deadline = Date.now() + 90000;
    let found = false;
    while (Date.now() < deadline) {
      const state = await page.evaluate(() => {
        const title = document.title || '';
        const hasTable = !!document.querySelector('#gametable');
        const hasChallenge =
          title.toLowerCase().includes('just a moment') ||
          !!document.querySelector('#challenge-form, .cf-browser-verification, #cf-challenge-running');
        const bodySnippet = (document.body?.innerText || '').slice(0, 200);
        const providers = Array.from(document.querySelectorAll('.gamelinks a'))
          .map((a) => a.textContent?.trim().toLowerCase())
          .filter(Boolean);
        const leagues = Array.from(document.querySelectorAll('#gametable tbody tr:first-child td b'))
          .map((b) => b.textContent?.trim())
          .filter(Boolean);
        const gameCount = document.querySelectorAll('tr.game').length;
        return { title, hasTable, hasChallenge, bodySnippet, providers, leagues, gameCount };
      });

      report.lastState = state;
      console.log(
        `  t+${Math.round((90000 - (deadline - Date.now())) / 1000)}s ` +
          `table=${state.hasTable} challenge=${state.hasChallenge} games=${state.gameCount} ` +
          `title="${state.title}"`
      );

      if (state.hasTable && !state.hasChallenge) {
        found = true;
        break;
      }
      await sleep(2000);
    }

    report.success = found;
    if (found) {
      const html = await page.content();
      const safe = url.replace(/https?:\/\//, '').replace(/[^\w.-]+/g, '_');
      await fs.writeFile(`probe-${safe}.html`, html, 'utf8');
      console.log(`  Saved probe-${safe}.html`);
      console.log(`  Leagues: ${(report.lastState.leagues || []).join(', ')}`);
      const counts = {};
      for (const p of report.lastState.providers || []) {
        counts[p] = (counts[p] || 0) + 1;
      }
      console.log(`  Providers: ${JSON.stringify(counts)}`);
    } else {
      const html = await page.content();
      const safe = url.replace(/https?:\/\//, '').replace(/[^\w.-]+/g, '_');
      await fs.writeFile(`probe-fail-${safe}.html`, html, 'utf8');
      console.log(`  FAILED — saved probe-fail-${safe}.html`);
      console.log(`  body: ${report.lastState?.bodySnippet}`);
    }
  } catch (err) {
    report.error = err.message;
    console.error(`  ERROR: ${err.message}`);
  } finally {
    await page.close().catch(() => {});
  }

  return report;
}

const browser = await puppeteer.launch(getPuppeteerLaunchOptions());
console.log('Launch options headless=', getPuppeteerLaunchOptions().headless);

const results = [];
for (const url of TARGETS) {
  results.push(await probeUrl(browser, url));
}

await browser.close();
await fs.writeFile('probe-onhockey-report.json', JSON.stringify(results, null, 2));
console.log('\nWrote probe-onhockey-report.json');
console.log(
  'Summary:',
  results.map((r) => ({
    url: r.url,
    success: r.success,
    games: r.lastState?.gameCount,
    title: r.title || r.lastState?.title,
    error: r.error,
  }))
);
