/**
 * Dashboard tile accuracy test.
 *
 * For every KPI card and every tile on /dashboard, read the number the UI
 * actually renders, then independently compute what that number SHOULD be from
 * the same API the tile consumes (using the same rule the tile applies). Report
 * a PASS / FAIL / WARN line per check and exit non-zero on any hard failure.
 *
 * "Accuracy" here means two things:
 *   1. Self-consistency: the headline number equals the data behind that tile.
 *   2. Cross-source agreement: a KPI card agrees with the page/tile it stands
 *      for (these are emitted as WARN when they diverge, because the underlying
 *      definitions live in different endpoints).
 *
 * Run (backend on :8000, frontend dev on :5173):
 *   node frontend/tests/e2e/dashboard_tile_accuracy.mjs
 */
import { chromium, request as pwRequest } from 'playwright';

const FRONTEND = process.env.FRONTEND_BASE || 'http://localhost:5173';
const API = process.env.API_BASE || 'http://localhost:8000';
const EMAIL = process.env.TEST_EMAIL || 'audit@celr.test';
const PASSWORD = process.env.TEST_PASSWORD || 'AuditPass123!';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const record = (name, dom, expected, severity = 'fail', note = '') => {
  const ok = dom != null && expected != null && Number(dom) === Number(expected);
  results.push({ name, dom, expected, ok, severity, note });
};

const num = (s) => {
  if (s == null) return null;
  const m = String(s).replace(/[^0-9.-]/g, '');
  return m === '' ? null : Number(m);
};

(async () => {
  // ---- API context (source of truth) ----
  const api = await pwRequest.newContext({ baseURL: API });
  const login = await api.post('/api/auth/login', { data: { email: EMAIL, password: PASSWORD } });
  if (!login.ok()) { console.error('Login failed', login.status(), await login.text()); process.exit(2); }
  const { token, user } = await login.json();
  const isAdmin = !!user?.is_admin;
  const H = { Authorization: `Bearer ${token}` };
  const get = async (p) => {
    const r = await api.get(p, { headers: H });
    if (!r.ok()) throw new Error(`${p} -> ${r.status()}`);
    return r.json();
  };

  // Pull the same data the dashboard pulls.
  const kpi = await get('/api/analytics/dashboard');
  const newItems = await get('/api/catalog/new-items?limit=5000');
  const ts = await get('/api/deals/time-sensitive?include_past=true');
  const topDeals = await get('/api/deals/discounts?per_category=true&limit=200');
  const priceCmp = await get('/api/catalog/price-comparison?direction=any&min_abs_delta_pct=0.01&sort=abs_delta_pct&order=desc&limit=50000');
  const crossA = await get('/api/catalog/cross-distributor?distributor_a=allied&distributor_b=fedway&cheaper=a&min_abs_savings_pct=0.01&sort=abs_savings_pct&order=desc&limit=50000');
  const crossB = await get('/api/catalog/cross-distributor?distributor_a=allied&distributor_b=fedway&cheaper=b&min_abs_savings_pct=0.01&sort=abs_savings_pct&order=desc&limit=50000');
  const crossO = await get('/api/catalog/cross-distributor-combined?distributor=opici&competitors=allied,fedway&min_abs_savings_pct=0.01&sort=abs_savings_pct&order=desc&limit=50000');
  const favorites = await get('/api/watchlist');
  const draft = await get('/api/orders?status=draft');
  const submitted = await get('/api/orders?status=submitted');
  const myNotes = await get('/api/notes/all');
  // The page that the Price Drops / Increases KPI cards link to (movers lens).
  const moversDown = await get('/api/analytics/price-movers?direction=down&limit=2000');
  const moversUp = await get('/api/analytics/price-movers?direction=up&limit=2000');

  const tsActive = ts.filter(r => r.days_to_expire != null && r.days_to_expire >= 0).length;
  const cmpDown = (priceCmp.items || []).filter(r => (r.delta_pct || 0) < 0).length;
  const cmpUp = (priceCmp.items || []).filter(r => (r.delta_pct || 0) > 0).length;

  // ---- Drive the UI ----
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 1200 } });
  const page = await ctx.newPage();
  await page.goto(`${FRONTEND}/login`, { waitUntil: 'networkidle' });
  await page.waitForSelector('input[type="password"]', { timeout: 30000 });
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.press('input[type="password"]', 'Enter');
  await page.waitForLoadState('networkidle');
  await sleep(1500);
  for (const t of ["Don't remind me again", 'Skip for now', 'Accept all', 'Got it']) {
    const b = await page.$(`button:has-text("${t}")`); if (b) { await b.click().catch(() => {}); await sleep(200); }
  }
  await page.goto(`${FRONTEND}/dashboard`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.kpi-grid .kpi-card', { timeout: 60000 });
  await sleep(3000);  // let all tile queries resolve

  // Read a KPI card value by its label.
  const kpiVal = async (label) => {
    const v = await page.evaluate((lbl) => {
      const cards = [...document.querySelectorAll('.kpi-card')];
      const c = cards.find(c => c.querySelector('.kpi-label')?.textContent?.trim() === lbl);
      return c ? c.querySelector('.kpi-value')?.textContent?.trim() ?? null : null;
    }, label);
    return num(v);
  };
  // Read a tile's headline count by a substring of its title.
  const tileVal = async (titleSub) => {
    const v = await page.evaluate((sub) => {
      const tiles = [...document.querySelectorAll('.dashboard-tile')];
      const t = tiles.find(t => (t.querySelector('.dashboard-tile-title')?.textContent || '').includes(sub));
      return t ? t.querySelector('.dashboard-tile-count')?.textContent?.trim() ?? null : null;
    }, titleSub);
    return num(v);
  };

  // ---- KPI cards (must equal the dashboard endpoint they render) ----
  record('KPI · Total Items', await kpiVal('Total Items'), kpi.total_items);
  record('KPI · Active Discounts', await kpiVal('Active Discounts'), kpi.active_discounts);
  record('KPI · Clearance Items', await kpiVal('Clearance Items'), kpi.clearance_items);
  record('KPI · Active RIPs', await kpiVal('Active RIPs'), kpi.active_rips);
  // Canonical definition (chosen): matched 2-edition price-comparison.
  record('KPI · Price Drops (== price-comparison)', await kpiVal('Price Drops'), cmpDown);
  record('KPI · Price Increases (== price-comparison)', await kpiVal('Price Increases'), cmpUp);

  // ---- Insight tiles (must equal their own data source) ----
  record('Tile · New Items', await tileVal('New Items'), newItems.total);
  record('Tile · Time-Sensitive Deals', await tileVal('Time-Sensitive Deals'), tsActive);
  record('Tile · Top Discount Opportunities', await tileVal('Top Discount Opportunities'), (topDeals || []).length);
  record('Tile · Price Changes (MoM)', await tileVal('Price Changes'), priceCmp.total);
  record('Tile · Cross-dist Allied Cheaper', await tileVal('Allied Cheaper'), crossA.total);
  record('Tile · Cross-dist Fedway Cheaper', await tileVal('Fedway Cheaper'), crossB.total);
  record('Tile · Cross-dist OPICI Cheaper', await tileVal('OPICI Cheaper'), crossO.total);

  // ---- Workspace tiles ----
  record('Tile · My Favorites', await tileVal('My Favorites'), favorites.length);
  record('Tile · My Orders in Progress', await tileVal('My Orders in Progress'), draft.length);
  record('Tile · My Submitted Orders', await tileVal('My Submitted Orders'), submitted.length);
  record('Tile · My Notes', await tileVal('My Notes'), myNotes.length);

  // ---- Admin-only tiles (only when the user is admin and they render) ----
  if (isAdmin) {
    const bpd = await tileVal('Biggest Price Drops');
    if (bpd != null) record('Tile · Biggest Price Drops (capped@200 source)', bpd, Math.min(moversDown.length, 200), 'warn',
      `true movers-down=${moversDown.length}`);
  }

  // ---- Cross-source accuracy (WARN: KPI vs the page it opens) ----
  record('XCHECK · "Price Drops" KPI vs /price-drops page (movers)', await kpiVal('Price Drops'), moversDown.length, 'warn',
    `movers down=${moversDown.length}, price-comparison down=${cmpDown}, price_changes=${kpi.price_drops}`);
  record('XCHECK · "Price Increases" KPI vs /price-increases page (movers)', await kpiVal('Price Increases'), moversUp.length, 'warn',
    `movers up=${moversUp.length}, price-comparison up=${cmpUp}, price_changes=${kpi.price_increases}`);
  record('XCHECK · "Price Drops" KPI vs MoM-tile drops subset', await kpiVal('Price Drops'), cmpDown, 'warn',
    'price-comparison down subset');

  await browser.close();
  await api.dispose();

  // ---- Report ----
  const pad = (s, n) => String(s).padEnd(n);
  console.log('\n================ DASHBOARD TILE ACCURACY ================');
  console.log(`user=${EMAIL} admin=${isAdmin}\n`);
  console.log(pad('CHECK', 52), pad('UI', 9), pad('EXPECTED', 9), 'RESULT');
  let hardFails = 0, warns = 0;
  for (const r of results) {
    const status = r.ok ? 'PASS' : (r.severity === 'warn' ? 'WARN' : 'FAIL');
    if (!r.ok && r.severity === 'warn') warns++;
    if (!r.ok && r.severity !== 'warn') hardFails++;
    console.log(pad(r.name, 52), pad(r.dom ?? '—', 9), pad(r.expected ?? '—', 9), status, r.note ? `  (${r.note})` : '');
  }
  console.log('\n--------------------------------------------------------');
  console.log(`PASS=${results.filter(r => r.ok).length}  FAIL=${hardFails}  WARN=${warns}`);
  console.log('========================================================\n');
  process.exit(hardFails > 0 ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
