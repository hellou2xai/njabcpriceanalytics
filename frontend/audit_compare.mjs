// Compare Prices audit scraper (analysis only): logs into the LOCAL app,
// opens /compare-prices?d=kramer,shore_point with every row shown, captures
// BOTH the API payload the page received and the numbers actually painted in
// the DOM, and writes them to scripts/_audit_compare_out.json for the python
// cross-checker. Run from frontend/:  node audit_compare.mjs
import { chromium } from 'playwright';
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'scripts', '_audit_compare_out.json');
const BASE = process.env.AUDIT_BASE || 'http://localhost:5173';
const EMAIL = process.env.AUDIT_EMAIL || 'audit@celr.test';
const PASSWORD = process.env.AUDIT_PASSWORD || 'AuditPass123!';
// pp must be one of the page's PAGE_SIZES (50/100/250/500/1000) or it clamps
// back to 100; 1000 covers the whole Kramer vs Shore Point common set.
const ROUTE = '/compare-prices?d=kramer,shore_point&diff=0&pp=1000&cs=0';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1900, height: 1100 } });
  const page = await ctx.newPage();

  let apiPayload = null;
  page.on('response', async (r) => {
    if (r.url().includes('/api/compare/products')) {
      try { apiPayload = await r.json(); } catch { /* non-json */ }
    }
  });

  // ---- login ----
  await page.goto(BASE + '/login', { waitUntil: 'networkidle' });
  await page.waitForSelector('input[type="password"]', { timeout: 30000 });
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.press('input[type="password"]', 'Enter');
  await page.waitForLoadState('networkidle');
  await sleep(2500);
  for (const t of ['Accept all', 'Accept', 'Got it', 'I agree']) {
    const b = await page.$(`button:has-text("${t}")`);
    if (b) { await b.click().catch(() => {}); break; }
  }

  // ---- the comparison grid ----
  await page.goto(BASE + ROUTE, { waitUntil: 'networkidle' });
  await page.waitForSelector('table.cmp-table tbody tr', { timeout: 120000 });
  await sleep(3000); // let the first page paint

  // Expand the grid fully: keep clicking "Show more" until every row renders.
  for (let i = 0; i < 300; i++) {
    const more = await page.$('button.cmp-more');
    if (!more) break;
    await more.click().catch(() => {});
    await sleep(250);
  }
  await sleep(1500);

  const dom = await page.evaluate(() => {
    const rows = [];
    for (const tr of document.querySelectorAll('table.cmp-table tbody tr.clickable')) {
      const tds = [...tr.children];
      const prod = tds[0];
      const name = prod.querySelector('.cmp-prod-name')?.textContent?.trim() ?? '';
      const size = prod.querySelector('.cmp-size')?.textContent?.trim() ?? '';
      const prices = [...tr.querySelectorAll('td.cmp-price')].map(td => ({
        text: (td.childNodes[0]?.textContent ?? td.textContent ?? '').trim(),
        win: td.classList.contains('cmp-win'),
        tie: td.classList.contains('cmp-tie'),
      }));
      // after the 6 price cells: spread td, winner td
      const after = tds.slice(1 + prices.length);
      rows.push({
        name, size, prices,
        spread_text: after[0]?.textContent?.trim() ?? '',
        winner_text: after[1]?.textContent?.trim() ?? '',
      });
    }
    return rows;
  });

  writeFileSync(OUT, JSON.stringify({ route: ROUTE, dom, api: apiPayload }, null, 1));
  console.log(`scraped ${dom.length} DOM rows; api rows: ${apiPayload?.rows?.length ?? 'NONE'}`);
  console.log('wrote', OUT);
  await browser.close();
})();
