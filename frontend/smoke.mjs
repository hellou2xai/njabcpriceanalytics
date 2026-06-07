/**
 * SMOKE SUITE — run before every push (scripts/run_smoke.ps1 orchestrates).
 *
 * Asserts the critical pages render AND the user-specified conventions hold:
 * geometry (no horizontal overflow), full QD/RIP tier tooltips, rebate-alone
 * RIP amounts, time-sensitive deals present, combo expander, agent panel.
 * Exit code != 0 on any failure — a failing smoke means DO NOT DEPLOY.
 *
 * Prereqs: backend on :8000 serving the built dist, and a row in auth_tokens
 * with token 'smoke-suite-token' (run_smoke.ps1 mints + removes it).
 */
import { chromium } from 'playwright';

const BASE = process.env.SMOKE_BASE || 'http://localhost:8000';
const TOKEN = process.env.SMOKE_TOKEN || 'smoke-suite-token';
let failures = 0;

function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

const dismiss = async (page) => {
  for (const t of ['Skip for now', 'Accept all']) {
    const b = await page.$(`button:has-text("${t}")`);
    if (b) { await b.click().catch(() => {}); await page.waitForTimeout(200); }
  }
};

const noOverflow = async (page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));

  await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded' });
  await page.evaluate(t => localStorage.setItem('lpb_auth_token', t), TOKEN);

  // ---- Products grid -------------------------------------------------------
  await page.goto(BASE + '/products', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500); await dismiss(page);
  check('products: cards render', (await page.$$('.prod-card, [class*=prod-group], .products-layout')).length > 0);
  check('products: no horizontal overflow', await noOverflow(page));
  check('products: filter rail collapsible', !!(await page.$('.prod-filter-collapse')));
  check('products: In QD filter label', (await page.textContent('.prod-filter-rail').catch(() => '') ?? '').includes('In QD'));

  // ---- Product Detail (Laphroaig Boot: QD + dated RIPs) --------------------
  await page.goto(BASE + '/product?w=allied&n=' + encodeURIComponent('LAPHROAIG 10Y BOOT6P') + '&u=80686007326',
                  { waitUntil: 'networkidle' });
  await page.waitForTimeout(3500); await dismiss(page);
  const body = (await page.textContent('body')) ?? '';
  check('detail: volume-pricing chart', !!(await page.$('.qpc')));
  check('detail: list-under-cart actions', !!(await page.$('.pd-order-actions')));
  check('detail: no horizontal overflow', await noOverflow(page));
  check('detail: AI explainer is off', !/What this means|AI explainer/i.test(body));
  // The sparkline tooltip must show FULL tiers with rebate-alone RIP amounts.
  const spark = await page.$('.psk');
  if (spark) {
    const b = await spark.boundingBox();
    if (b) { await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await page.waitForTimeout(2000); }
  }
  const pop = (await page.textContent('.psk-pop').catch(() => '')) ?? '';
  check('detail: sparkline tooltip has FULL tiers', /Buy \d/.test(pop), pop.slice(0, 60));
  check('detail: tooltip RIP shows rebate alone', /RIP −\$\d/.test(pop));

  // ---- Time-Sensitive ------------------------------------------------------
  await page.goto(BASE + '/time-sensitive', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500); await dismiss(page);
  const tsHead = (await page.textContent('.page').catch(() => '')) ?? '';
  const tsCount = parseInt(tsHead.match(/(\d+)\s*deals/)?.[1] ?? '0', 10);
  check('time-sensitive: deals present', tsCount > 0, `${tsCount} deals`);

  // ---- Combos --------------------------------------------------------------
  await page.goto(BASE + '/combos?code=203034', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500); await dismiss(page);
  const toggle = await page.$('.combo-items-toggle');
  check('combos: items expander present', !!toggle);
  if (toggle) {
    await toggle.click(); await page.waitForTimeout(300);
    check('combos: component lines expand', (await page.$$('.combo-item-line')).length > 0);
  }

  // ---- Compare Prices: closeout flag + admin review form ------------------
  await page.goto(BASE + '/compare-prices?d=allied,fedway', { waitUntil: 'networkidle' });
  await page.waitForTimeout(4000); await dismiss(page);
  check('compare: closeout flag button present', (await page.$$('.closeout-btn')).length > 0);
  await page.goto(BASE + '/admin/closeout-flags', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000); await dismiss(page);
  check('admin: closeout flags page renders',
    ((await page.textContent('.page').catch(() => '')) ?? '').includes('User Closeout Flags'));

  // ---- Celr AI Agents ------------------------------------------------------
  await page.goto(BASE + '/agents/proposals', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500); await dismiss(page);
  check('agents: 4 panel cards', (await page.$$('.agent-control-card')).length === 4);
  check('agents: staging area present',
    ((await page.textContent('.page').catch(() => '')) ?? '').includes('Staging area'));
  check('agents: no horizontal overflow', await noOverflow(page));

  check('no page errors anywhere', errors.length === 0, errors.slice(0, 2).join(' | '));

  await browser.close();
  console.log(failures === 0 ? '\nSMOKE: ALL PASS' : `\nSMOKE: ${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})();
