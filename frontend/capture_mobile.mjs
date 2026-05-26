// Quick mobile-width screenshots of the data pages (for tuning mobile CSS).
// Not committed output: writes to frontend/.mobile-shots/. Run from frontend/:
//   GUIDE_EMAIL=... GUIDE_PASSWORD=... node capture_mobile.mjs
import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '.mobile-shots');
mkdirSync(OUT, { recursive: true });
const BASE = process.env.GUIDE_BASE || 'https://nj.celr.ai';
const EMAIL = process.env.GUIDE_EMAIL, PASSWORD = process.env.GUIDE_PASSWORD;
const TAG = process.env.SHOT_TAG || 'before';
const PAGES = [['/catalog', 'catalog'], ['/watchlist', 'favorites'], ['/combos', 'combos'], ['/cart', 'cart'], ['/rip-products', 'rip']];
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 402, height: 874 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await page.goto(BASE + '/login', { waitUntil: 'networkidle' });
  await page.waitForSelector('input[type="password"]', { timeout: 30000 });
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.press('input[type="password"]', 'Enter');
  await page.waitForLoadState('networkidle');
  await sleep(3000);
  for (const t of ['Accept all', 'Accept', 'Got it', 'I agree']) {
    const b = await page.$(`button:has-text("${t}")`); if (b) { await b.click().catch(() => {}); break; }
  }
  await sleep(800);
  for (const [route, name] of PAGES) {
    try {
      await page.goto(BASE + route, { waitUntil: 'networkidle' });
      await sleep(2200);
      await page.screenshot({ path: join(OUT, `${name}-${TAG}.png`) });
      console.log('shot', `${name}-${TAG}.png`);
    } catch (e) { console.error('FAILED', route, e.message); }
  }
  await browser.close();
  console.log('done');
})();
