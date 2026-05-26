// Capture fresh How-To-Guide screenshots from the live app.
// Prereq (not a committed dep, to keep the production build lean):
//   cd frontend && npm i -D playwright && npx playwright install chromium
// Run from frontend/ with creds in the env:
//   GUIDE_EMAIL=... GUIDE_PASSWORD=... node capture_guide.mjs
import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, 'public', 'guide');
const BASE = process.env.GUIDE_BASE || 'https://nj.celr.ai';
const EMAIL = process.env.GUIDE_EMAIL;
const PASSWORD = process.env.GUIDE_PASSWORD;

const PAGES = [
  ['/', '01-dashboard.png'],
  ['/catalog', '02-catalog.png'],
  ['/new-items', '03-new-items.png'],
  ['/combos', '04-combos.png'],
  ['/rip-products', '05-rip-products.png'],
  ['/watchlist', '06-favorites.png'],
  ['/notes', '07-notes.png'],
  ['/orders', '08-orders.png'],
  ['/alerts', '09-alerts.png'],
  ['/configuration', '10-configuration.png'],
  ['/profile', '11-profile.png'],
  ['/todo', '14-todo.png'],
  ['/lists', '15-lists.png'],
  ['/cart', '16-cart.png'],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!EMAIL || !PASSWORD) { console.error('Set GUIDE_EMAIL and GUIDE_PASSWORD'); process.exit(1); }
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();

  // ---- Login (the form lives at /login) ----
  await page.goto(BASE + '/login', { waitUntil: 'networkidle' });
  await page.waitForSelector('input[type="password"]', { timeout: 30000 });
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.press('input[type="password"]', 'Enter');
  await page.waitForLoadState('networkidle');
  await sleep(3000);

  // Dismiss cookie consent if present
  for (const t of ['Accept all', 'Accept', 'Got it', 'I agree']) {
    const b = await page.$(`button:has-text("${t}")`);
    if (b) { await b.click().catch(() => {}); break; }
  }
  await sleep(800);

  // ---- Pages ----
  for (const [route, file] of PAGES) {
    try {
      await page.goto(BASE + route, { waitUntil: 'networkidle' });
      await sleep(2200); // let images/charts settle
      await page.screenshot({ path: join(OUT, file) });
      console.log('shot', file);
    } catch (e) {
      console.error('FAILED', route, e.message);
    }
  }

  // ---- Product detail (Quick View modal from the catalog) ----
  try {
    await page.goto(BASE + '/catalog', { waitUntil: 'networkidle' });
    await sleep(2500);
    const row = page.locator('table.catalog-table tbody tr.catalog-row-main').first();
    await row.click({ timeout: 15000 });
    await page.waitForSelector('.modal', { timeout: 15000 });
    await sleep(2000);
    await page.screenshot({ path: join(OUT, '13-product-details.png') });
    console.log('shot 13-product-details.png');
  } catch (e) {
    console.error('FAILED product-details', e.message);
  }

  await browser.close();
  console.log('done');
})();
