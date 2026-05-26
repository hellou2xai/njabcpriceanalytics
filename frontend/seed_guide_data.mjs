// One-time demo data so the Cart and Lists guide screenshots are not empty.
// Logs in as the demo account and seeds a few active cart items + one named list
// via the same API the app uses. Safe to re-run (skips a list that already exists).
//   GUIDE_EMAIL=... GUIDE_PASSWORD=... node seed_guide_data.mjs
const BASE = process.env.GUIDE_BASE || 'https://nj.celr.ai';
const EMAIL = process.env.GUIDE_EMAIL;
const PASSWORD = process.env.GUIDE_PASSWORD;

async function api(path, token, init = {}) {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.headers || {}) },
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

(async () => {
  if (!EMAIL || !PASSWORD) { console.error('Set GUIDE_EMAIL and GUIDE_PASSWORD'); process.exit(1); }
  const { token } = await api('/api/auth/login', null, { method: 'POST', body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
  console.log('logged in');

  // ---- Active cart: pick deal products from the distributor with the most hits ----
  const { items } = await api('/api/catalog/search?has_rip=true&limit=20&sort=total_savings_per_case&order=desc', token);
  const byDist = {};
  for (const it of items) (byDist[it.wholesaler] ??= []).push(it);
  const topDist = Object.entries(byDist).sort((a, b) => b[1].length - a[1].length)[0]?.[0];
  const chosen = (byDist[topDist] ?? items).slice(0, 3);
  for (const it of chosen) {
    await api('/api/cart', token, { method: 'POST', body: JSON.stringify({
      product_name: it.product_name, wholesaler: it.wholesaler, upc: it.upc,
      unit_volume: it.unit_volume, qty_cases: 5, qty_units: 0,
    }) });
  }
  console.log(`added ${chosen.length} active cart items from ${topDist}`);

  // ---- A named list with a few items ----
  const lists = await api('/api/lists', token);
  let list = lists.find(l => l.name === 'Weekly reorder');
  if (!list) list = await api('/api/lists', token, { method: 'POST', body: JSON.stringify({ name: 'Weekly reorder' }) });
  const detail = await api(`/api/lists/${list.id}`, token);
  if (!detail.items || detail.items.length === 0) {
    const { items: more } = await api('/api/catalog/search?has_discount=true&limit=10&sort=total_savings_per_case&order=desc', token);
    for (const it of more.slice(0, 4)) {
      await api(`/api/lists/${list.id}/items`, token, { method: 'POST', body: JSON.stringify({
        product_name: it.product_name, wholesaler: it.wholesaler, upc: it.upc, unit_volume: it.unit_volume,
      }) });
    }
    console.log('seeded list "Weekly reorder" with 4 items');
  } else {
    console.log('list "Weekly reorder" already has items, leaving as is');
  }
  console.log('done');
})().catch(e => { console.error(e.message); process.exit(1); });
