import { Fragment, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Check, X } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import FavoriteButton from './FavoriteButton';
import ProductThumb from './ProductThumb';
import AddToCartButton from './AddToCartButton';
import AddToListButton from './AddToListButton';
import { RowMenuButton } from './ContextMenu';
import MonthEffectiveSparkline from './MonthEffectiveSparkline';
import { buildMonths } from '../lib/promotionsSparkline';
import RipMembersModal from './RipMembersModal';
import { distributorName, abgSku } from '../lib/distributors';
import { cart as cartApi } from '../lib/api';
import type { Product, CatalogTier } from '../lib/api';

// ---- shared cart state (localStorage) ----
export type CartQty = { cases: number; units: number };
export type CartState = Record<string, CartQty>;
export function loadCart(): CartState {
  try { return JSON.parse(localStorage.getItem('lpb_current_cart') ?? '{}'); } catch { return {}; }
}
export function saveCart(c: CartState) { localStorage.setItem('lpb_current_cart', JSON.stringify(c)); }

export function shortUnit(u?: string | null): string {
  if (!u) return 'cs';
  const s = u.toLowerCase();
  if (s.startsWith('case') || s === 'c') return 'cs';
  if (s.startsWith('bottle') || s.startsWith('btl') || s === 'b') return 'btl';
  return u;
}

// Distinct-colour palette for RIP groups in a table view. We assign colours
// by order-of-appearance on the page (not by hashing the code) so adjacent
// groups never collide: codes 111200 / 111201 / 111202 cluster together in
// SQL but had nearly identical hashed hues, defeating the whole point of
// grouping. Twelve evenly-spaced, high-saturation hues are plenty for what
// a single catalog page shows; we cycle if a page somehow has more.
export interface RipPaletteEntry { stripe: string; tint: string; text: string; border: string }
export const RIP_PALETTE: RipPaletteEntry[] = [
  { stripe: '#2563eb', tint: '#dbeafe', text: '#1e40af', border: '#bfdbfe' }, // blue
  { stripe: '#dc2626', tint: '#fee2e2', text: '#991b1b', border: '#fecaca' }, // red
  { stripe: '#16a34a', tint: '#dcfce7', text: '#14532d', border: '#bbf7d0' }, // green
  { stripe: '#ea580c', tint: '#ffedd5', text: '#9a3412', border: '#fdba74' }, // orange
  { stripe: '#7c3aed', tint: '#ede9fe', text: '#5b21b6', border: '#ddd6fe' }, // purple
  { stripe: '#0891b2', tint: '#cffafe', text: '#155e75', border: '#a5f3fc' }, // cyan
  { stripe: '#db2777', tint: '#fce7f3', text: '#9d174d', border: '#fbcfe8' }, // pink
  { stripe: '#65a30d', tint: '#ecfccb', text: '#365314', border: '#bef264' }, // lime
  { stripe: '#0d9488', tint: '#ccfbf1', text: '#134e4a', border: '#99f6e4' }, // teal
  { stripe: '#a16207', tint: '#fef3c7', text: '#713f12', border: '#fde68a' }, // amber
  { stripe: '#4f46e5', tint: '#e0e7ff', text: '#3730a3', border: '#c7d2fe' }, // indigo
  { stripe: '#be123c', tint: '#ffe4e6', text: '#881337', border: '#fecdd3' }, // rose
];

// Map every distinct rip code on a page to its palette slot in the order it
// first appears, so the visual band rotation matches the SQL cluster order.
export function buildRipPaletteMap(codes: Iterable<string | null | undefined>): Map<string, RipPaletteEntry> {
  const map = new Map<string, RipPaletteEntry>();
  let idx = 0;
  for (const raw of codes) {
    if (!raw) continue;
    const c = String(raw);
    if (!map.has(c)) {
      map.set(c, RIP_PALETTE[idx % RIP_PALETTE.length]);
      idx++;
    }
  }
  return map;
}
function fmt(v: number | null | undefined, prefix = '$'): string {
  return v == null ? '-' : `${prefix}${v.toFixed(2)}`;
}

// "2026-05" -> "May 2026" for the Introduced column.
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function introMonth(ym?: string | null): string {
  if (!ym) return '—';
  const [y, m] = ym.split('-');
  const idx = parseInt(m, 10) - 1;
  return idx >= 0 && idx < 12 ? `${MONTH_NAMES[idx]} ${y}` : ym;
}

export function QtyStepper({ label, value, onChange }: { label: string; value: number; onChange: (n: number) => void }) {
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  return (
    <div className="qty-stepper" onClick={stop}>
      <span style={{ fontSize: 10, color: 'var(--text-muted)', width: 26, flexShrink: 0 }}>{label}</span>
      <button type="button" disabled={value <= 0} onClick={() => onChange(Math.max(0, value - 1))}>-</button>
      <input
        type="number" min={0} value={value === 0 ? '' : value} placeholder="0"
        onClick={stop} onMouseDown={stop} onKeyDown={stop}
        onChange={e => {
          const v = e.target.value.replace(/[^0-9]/g, '');
          onChange(v === '' ? 0 : Math.max(0, parseInt(v, 10)));
        }}
        onFocus={e => e.target.select()}
      />
      <button type="button" onClick={() => onChange(value + 1)}>+</button>
    </div>
  );
}

type SortKey = 'product_name' | 'frontline_case_price' | 'effective_case_price' | 'live_effective_case_price';

interface Props {
  items: Product[];
  open: (productName: string, wholesaler: string, compareWith?: unknown, opts?: { upc?: string; unitVolume?: string }) => void;
  cart: CartState;
  updateQty: (key: string, field: 'cases' | 'units', value: number) => void;
  // Optional sortable headers (server- or client-side, controlled by the parent).
  sortControls?: { sort: string; order: 'asc' | 'desc'; onSort: (col: SortKey) => void };
  // When provided and it returns a URL, show a "🎁 In combo" link under the product.
  comboLink?: (item: Product) => string | null;
  // When true, show an "Introduced" column (the edition the item first appeared
  // in). Used by the New Items screen; the main catalog leaves it off.
  showIntroduced?: boolean;
  // When true, the items list is server-sorted by rip_group_code and we render
  // a banner row above each cluster: rebate code, tier ladder, cart-aware
  // "X cases in cart · Y more for next tier" progress, and an Add-all-to-cart
  // button that drops 1 case of every unique product in the cluster.
  groupByRip?: boolean;
  // Display preference: when false, hide the three Pro teaser columns
  // (Time to Sell, Suggested Qty, Quantity Justification) and shrink
  // every colSpan / totalColumns by 3 to keep layout in sync. The
  // Catalog page persists the choice in localStorage.
  showProColumns?: boolean;
}

/**
 * The shared product catalog table: a parent row per product plus expandable
 * DISC/RIP tier sub-rows ("Buy N = $X", save/case, price-after, ROI). Used by
 * the Catalog screen and the Order Analysis screen so they render identically.
 */
export default function CatalogTable({ items, open, cart, updateQty, sortControls, comboLink, showIntroduced, groupByRip, showProColumns = true }: Props) {
  // Pro columns add 3 cells per row. Centralise the bump so every
  // colSpan / totalColumns stays in step when the buyer toggles them
  // off.
  const proColSpan = showProColumns ? 3 : 0;
  // Live server cart, used by the per-group banner's progress message and
  // by "Add all to cart" so adds reflect immediately. react-query dedupes
  // this with the parent's cart query if any.
  const { data: cartData } = useQuery({
    queryKey: ['cart'],
    queryFn: cartApi.get,
    refetchOnWindowFocus: true,
    refetchInterval: 15000,
  });
  const qc = useQueryClient();
  const cartByKey = useMemo(() => {
    const m = new Map<string, { cases: number; units: number }>();
    for (const it of (cartData?.items ?? [])) {
      const upc = (it.upc ?? '').toString().replace(/^0+/, '');
      const k = `${it.wholesaler}|${upc}|${(it.unit_volume ?? '').toString()}`;
      const prev = m.get(k) ?? { cases: 0, units: 0 };
      m.set(k, { cases: prev.cases + (it.qty_cases || 0), units: prev.units + (it.qty_units || 0) });
    }
    return m;
  }, [cartData]);
  // Adds an explicit per-product quantity, so the row steppers drive what
  // gets sent. Items with both qty_cases = 0 AND qty_units = 0 are filtered
  // out by the caller before the mutation runs (the confirmation popup
  // covers that case).
  // Send all entries as ONE labelled batch. The cart keeps every RIP cluster
  // visually separate by default, so a second send of the same cluster
  // produces a SECOND card instead of merging. Falls back to per-item /add
  // calls if the batch endpoint somehow rejects, so a partial outage doesn't
  // strand the user.
  const addAllMut = useMutation({
    mutationFn: async (args: {
      ripCode: string;
      wholesaler: string;
      entries: {
        product_name: string; wholesaler: string; upc?: string; unit_volume?: string;
        qty_cases: number; qty_units: number;
      }[];
    }) => {
      const items = args.entries.map(p => ({
        product_name: p.product_name, wholesaler: p.wholesaler,
        upc: p.upc, unit_volume: p.unit_volume,
        qty_cases: p.qty_cases, qty_units: p.qty_units,
      }));
      try {
        await cartApi.addBatch({
          batch_label: `${args.wholesaler} RIP ${args.ripCode}`,
          batch_source: 'catalog_rip',
          items,
        });
      } catch {
        // Best-effort fallback to per-item adds so a transient endpoint
        // failure doesn't lose the basket.
        for (const p of items) {
          try { await cartApi.add(p); } catch { /* skip individual failures */ }
        }
      }
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['cart'] }); },
  });
  // Remove a RIP group's COMMITTED cart lines (the server cart, not the local
  // typed steppers). Without this the banner's "X in cart" could only ever go
  // up: adds invalidate ['cart'], but nothing on the catalog decremented it,
  // so a buyer who cleared a Case Mix still saw the old count. Matches lines by
  // the same wholesaler|upc-norm|unit_volume key the banner totals are built
  // from, so every vintage/row in the cluster is cleared.
  const removeGroupMut = useMutation({
    mutationFn: async (cartKeys: string[]) => {
      const keys = new Set(cartKeys);
      const ids = (cartData?.items ?? [])
        .filter(it => {
          const upc = (it.upc ?? '').toString().replace(/^0+/, '');
          return keys.has(`${it.wholesaler}|${upc}|${(it.unit_volume ?? '').toString()}`);
        })
        .map(it => it.id);
      for (const id of ids) {
        try { await cartApi.remove(id); } catch { /* skip individual failures */ }
      }
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['cart'] }); },
  });
  const [addedFlash, setAddedFlash] = useState<string | null>(null);
  // Confirmation modal state for "Add All Case Mix to Cart". Null = closed.
  // Two flavours: 'none' (zero quantities entered, ask user to enter some),
  // and 'partial' (some products have qty, others don't — confirm skipping
  // the empties). On confirm, we send the non-zero subset to addAllMut.
  const [addAllConfirm, setAddAllConfirm] = useState<{
    code: string;
    kind: 'none' | 'partial';
    toAdd: { product_name: string; wholesaler: string; upc?: string; unit_volume?: string;
             qty_cases: number; qty_units: number }[];
    skipped: { product_name: string }[];
  } | null>(null);
  // Open RIP-members popup: { wholesaler, ripCode } when set, null when closed.
  // Triggered by clicking any of the per-row RIP chips below; the chip's
  // onClick stops propagation so the row's quick-view doesn't also fire.
  const [ripModal, setRipModal] = useState<{ wholesaler: string; ripCode: string } | null>(null);

  // Precompute per-cluster banner metadata when groupByRip is on. Cluster
  // boundaries are the points where rip_group_code changes between
  // consecutive items in the server-sorted list, so a Map keyed by the
  // cluster's first-row index lets the render loop look it up in O(1).
  type RipBanner = {
    code: string;
    // One entry per ROW in the cluster (not per SKU): the row-unique
    // stepperKey lets the banner read the per-row typed qty, and the
    // popup count + skipped list line up with what the user sees on
    // screen. Multiple vintages of the same SKU still merge at the
    // cart endpoint, but the UI tracks them separately here.
    products: {
      product_name: string; wholesaler: string;
      upc?: string; unit_volume?: string;
      cartKey: string;    // cartByKey lookup (wholesaler|upc-norm|unit_volume)
      stepperKey: string; // local cart[stepperKey] lookup for typed qty
    }[];
    tiers: { qty: number; unit: string; amount: number; isCases: boolean }[];
    progressUnit: 'case' | 'btl';
    casesInCart: number;
    bottlesInCart: number;
    // What the user has typed into the per-row steppers but not yet
    // added. Updates instantly as they edit Case/Btl, so the banner
    // can show "Adding N cs · 2 more for $1.00 rebate" without waiting
    // for the Add to Cart click. Total = inCart + typed.
    casesTyped: number;
    bottlesTyped: number;
  };
  const normUnit = (s?: string | null): 'case' | 'btl' => {
    const x = (s ?? '').toLowerCase();
    if (x === 'b' || x.startsWith('btl') || x.startsWith('bottle')) return 'btl';
    return 'case';
  };
  const ripBanners = useMemo(() => {
    const out = new Map<number, RipBanner>();
    if (!groupByRip) return out;
    let i = 0;
    while (i < items.length) {
      const code = (items[i].rip_group_code ?? '').toString();
      if (!code) { i++; continue; }
      let j = i;
      while (j < items.length && (items[j].rip_group_code ?? '').toString() === code) j++;
      const productMap = new Map<string, RipBanner['products'][number]>();
      const tierMap = new Map<string, RipBanner['tiers'][number]>();
      let unitVotes = { case: 0, btl: 0 };
      for (let k = i; k < j; k++) {
        const it = items[k];
        const upc = (it.upc ?? '').toString().replace(/^0+/, '');
        // Per-ROW key (UPC included), so multi-vintage rows of the same
        // SKU don't collapse to one entry in the popup or the running
        // total. Same shape as the cartKey computed in the row render
        // below, so cart[stepperKey] is a direct lookup.
        const pKey = `${it.product_name}|${it.wholesaler}|${it.upc ?? ''}|${it.unit_volume ?? ''}`;
        if (!productMap.has(pKey)) {
          productMap.set(pKey, {
            product_name: it.product_name,
            wholesaler: it.wholesaler,
            upc: it.upc ?? undefined,
            unit_volume: it.unit_volume ?? undefined,
            cartKey: `${it.wholesaler}|${upc}|${(it.unit_volume ?? '').toString()}`,
            stepperKey: pKey,
          });
        }
        for (const t of (it.tiers ?? [])) {
          if (t.source !== 'rip') continue;
          const u = normUnit(t.unit);
          unitVotes[u]++;
          const tKey = `${t.qty}|${u}`;
          const prev = tierMap.get(tKey);
          if (!prev || t.amount > prev.amount) {
            tierMap.set(tKey, { qty: t.qty, unit: t.unit, amount: t.amount, isCases: u === 'case' });
          }
        }
      }
      const progressUnit: 'case' | 'btl' = unitVotes.btl > unitVotes.case ? 'btl' : 'case';
      let casesInCart = 0, bottlesInCart = 0;
      let casesTyped = 0, bottlesTyped = 0;
      for (const p of productMap.values()) {
        const cv = cartByKey.get(p.cartKey);
        if (cv) { casesInCart += cv.cases; bottlesInCart += cv.units; }
        const tv = cart[p.stepperKey];
        if (tv) { casesTyped += tv.cases; bottlesTyped += tv.units; }
      }
      out.set(i, {
        code,
        products: [...productMap.values()],
        tiers: [...tierMap.values()].sort((a, b) => a.qty - b.qty),
        progressUnit,
        casesInCart,
        bottlesInCart,
        casesTyped,
        bottlesTyped,
      });
      i = j;
    }
    return out;
    // `cart` is in the dep list so the banner totals update as the user
    // types into the steppers, not just when the server cart refreshes.
  }, [groupByRip, items, cartByKey, cart]);
  // Live progress message for the banner. Reads the combined live total
  // (what's in the server cart + what the user has just typed into the
  // steppers for any product in this RIP group), so a buyer typing
  // "Case 3" on row two sees the banner instantly move from
  // "Adding 0 cs" to "Adding 3 cs · 2 more for $1.00 rebate".
  function bannerProgress(b: RipBanner): { text: string; tone: 'gap' | 'pending' | 'reached' } | null {
    const inCart = b.progressUnit === 'case' ? b.casesInCart : b.bottlesInCart;
    const typed  = b.progressUnit === 'case' ? b.casesTyped  : b.bottlesTyped;
    const have = inCart + typed;
    const unitShort = b.progressUnit === 'case' ? 'cs' : 'btl';
    // "Adding 3 cs (2 already in cart)" or "Adding 3 cs" or "3 cs in cart"
    const ledgerPrefix = (() => {
      if (typed > 0 && inCart > 0) return `Adding ${typed} ${unitShort} (${inCart} already in cart)`;
      if (typed > 0) return `Adding ${typed} ${unitShort}`;
      if (inCart > 0) return `${inCart} ${unitShort} in cart`;
      return 'Nothing entered yet';
    })();
    // A mixed-unit RIP can list both case and bottle tiers. We track
    // progress in ONE unit (the cluster's majority unit), so the
    // milestone math has to consult only tiers expressed in that unit
    // (otherwise a 6-bottle tier gets compared to 4 cases on hand and
    // the popover prints "6 cs" for what's actually 6 btl).
    const isCaseUnit = b.progressUnit === 'case';
    const sameUnitTiers = b.tiers.filter(t => t.isCases === isCaseUnit);
    if (sameUnitTiers.length === 0) {
      return { text: ledgerPrefix, tone: typed > 0 || inCart > 0 ? 'pending' : 'gap' };
    }
    const reached = sameUnitTiers.filter(t => have >= t.qty);
    const ahead   = sameUnitTiers.filter(t => have < t.qty);
    // "Best" is the LARGEST REBATE AMOUNT, not the largest qty.
    // Tiers don't always reward proportional to volume (in the user's
    // RIP 10047, $84 at 2 cs beats $30 at 1 cs and $6 at 6 btl), so
    // sorting by qty and picking the last is wrong.
    const best = sameUnitTiers.reduce((a, c) => c.amount > a.amount ? c : a, sameUnitTiers[0]);
    const tierUnit = (t: { isCases: boolean }) => t.isCases ? 'cs' : 'btl';
    if (reached.length > 0 && ahead.length === 0) {
      const top = reached.reduce((a, c) => c.amount > a.amount ? c : a, reached[0]);
      return { text: `✓ Best RIP locked: $${top.amount.toFixed(2)} rebate · ${ledgerPrefix}`, tone: 'reached' };
    }
    const next = ahead[0];
    const gap = next.qty - have;
    if (reached.length > 0) {
      const top = reached.reduce((a, c) => c.amount > a.amount ? c : a, reached[0]);
      return {
        text: `${ledgerPrefix} · $${top.amount.toFixed(2)} earned · Add ${gap} more ${tierUnit(next)} for $${next.amount.toFixed(2)} (best: $${best.amount.toFixed(2)} at ${best.qty} ${tierUnit(best)})`,
        tone: 'pending',
      };
    }
    if (have === 0) {
      return { text: `Nothing entered yet · Add ${next.qty} ${tierUnit(next)} for $${next.amount.toFixed(2)} rebate (best: $${best.amount.toFixed(2)} at ${best.qty} ${tierUnit(best)})`, tone: 'gap' };
    }
    return {
      text: `${ledgerPrefix} · Add ${gap} more ${tierUnit(next)} for $${next.amount.toFixed(2)} rebate (best: $${best.amount.toFixed(2)} at ${best.qty} ${tierUnit(best)})`,
      tone: 'gap',
    };
  }
  // Palette assignment for "Group by RIP" coloured row bands. Built once
  // per items snapshot in order of appearance so adjacent SQL-clustered
  // groups always get visually distinct slots (no hash collisions). We feed
  // primary codes FIRST so the band/sort cluster colour always lands in the
  // first slots; secondary stacked codes pick up the next free palette
  // entries.
  const ripPalette = useMemo(() => {
    const ordered: (string | null | undefined)[] = [];
    for (const i of items) ordered.push(i.rip_group_code ?? null);
    for (const i of items) for (const c of (i.rip_all_codes ?? [])) ordered.push(c);
    return buildRipPaletteMap(ordered);
  }, [items]);
  // Display unit for the Pro Time to Sell teaser column. Single shared
  // state for the whole table so the buyer picks once and every row
  // re-labels. Pure placeholder UX until POS integration is live.
  const [ttsUnit, setTtsUnit] = useState<'day' | 'week' | 'month'>('week');
  const sortIcon = (col: string) =>
    sortControls && sortControls.sort === col ? (sortControls.order === 'asc' ? ' ▲' : ' ▼') : '';
  const headSort = (col: SortKey) => sortControls
    ? { className: 'sortable', onClick: () => sortControls.onSort(col) }
    : {};
  const rightHeadSort = (col: SortKey) => sortControls
    ? { className: 'right sortable', onClick: () => sortControls.onSort(col) }
    : { className: 'right' };

  return (
    <div className="catalog-table-wrap">
      <table className="catalog-table">
        <thead>
          <tr>
            <th style={{ width: 56 }}></th>
            <th {...headSort('product_name')}>Product{sortIcon('product_name')}</th>
            {/* Pro placeholders. Live preview of the POS-integrated buying
                suggestion + justification, shown as a teaser on every row
                so the value of the upgrade is visible while browsing.
                Hidden when the buyer toggles "Show Pro Features" off. */}
            {showProColumns && (
              <>
                <th className="catalog-pro-th" title="Depending on the Case + Btl quantity you're adding to cart, this calculates how long that stock will take to sell through at your store's real sales velocity from POS. Updates live as you edit Case / Btl. Pick Day / Week / Month to switch the time unit.">
                  <span className="catalog-pro-badge">Pro</span>
                  Time to Sell
                </th>
                <th className="catalog-pro-th" title="Pro feature: connects to your POS to recommend how much to buy based on your real sales velocity and on-hand stock.">
                  <span className="catalog-pro-badge">Pro</span>
                  Suggested Qty
                </th>
                <th className="catalog-pro-th" title="Pro feature: explains the suggested quantity using your store's sales history and current inventory.">
                  <span className="catalog-pro-badge">Pro</span>
                  Quantity Justification
                </th>
              </>
            )}
            <th>Distributor</th>
            <th>Type</th>
            {/* Size column dropped: Size and Bottles-per-Case are surfaced
                in the product cell's identifier line. */}
            {showIntroduced && <th>Introduced</th>}
            <th {...rightHeadSort('frontline_case_price')}>Case / Btl{sortIcon('frontline_case_price')}</th>
            <th>Tier</th>
            <th className="right">Save (cs / btl)</th>
            <th className="right">
              <span className={sortControls ? 'sortable' : undefined}
                    onClick={sortControls ? () => sortControls.onSort('effective_case_price') : undefined}>
                Effective (cs / btl){sortIcon('effective_case_price')}
              </span>
              {sortControls && (
                <span className="sortable"
                      title="Sort by the price active today, including dated RIPs that aren't part of the whole-month price"
                      onClick={() => sortControls.onSort('live_effective_case_price')}
                      style={{ marginLeft: 6, color: 'var(--green)' }}>
                  Live{sortIcon('live_effective_case_price')}
                </span>
              )}
            </th>
            <th className="right">ROI / GP%</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item: Product, rowIdx: number) => {
            // Row-unique stepper key: include UPC + unit_volume so two
            // rows that share a product name (e.g. multiple vintages of
            // the same wine, each with its own UPC) get independent
            // Case/Btl steppers, separate banner totals and a separate
            // line in the "Skip N products" popup. The cart endpoint
            // dedupes downstream via its UNIQUE (name, wholesaler,
            // unit_volume) index, so multiple POSTs for the same SKU
            // get summed server-side.
            const cartKey = `${item.product_name}|${item.wholesaler}|${item.upc ?? ''}|${item.unit_volume ?? ''}`;
            const reactKey = `${cartKey}|${rowIdx}`;
            const qty = cart[cartKey] ?? { cases: 0, units: 0 };
            const tiers: CatalogTier[] = item.tiers ?? [];
            const hasTiers = tiers.length > 0;
            // RIP-group decoration (only populated when the catalog requested
            // group_by_rip). Palette is assigned in order-of-appearance so
            // adjacent clusters always get visually distinct colours.
            const ripGroupCode = item.rip_group_code ?? null;
            const ripColour = ripGroupCode ? ripPalette.get(String(ripGroupCode)) ?? null : null;
            const ripBandStyle: React.CSSProperties = ripColour
              ? { boxShadow: `inset 6px 0 0 ${ripColour.stripe}`,
                  background: `linear-gradient(90deg, ${ripColour.tint} 0, transparent 240px)` }
              : {};
            const showMismatch = !!item.rip_cpl_mismatch && !!ripGroupCode;
            // Per-cluster banner when groupByRip is on: shows the chip, the
            // tier ladder, a cart-aware progress message and an Add-all-to-
            // cart button. Only renders on the first row of each cluster.
            const banner = groupByRip ? ripBanners.get(rowIdx) : undefined;
            const bannerColour = banner ? ripPalette.get(banner.code) ?? null : null;
            const bannerProg = banner ? bannerProgress(banner) : null;
            // Base 10 columns + 1 optional Introduced + the Pro block
            // (0 or 3) depending on showProColumns.
            const totalColumns = (showIntroduced ? 10 : 9) + proColSpan;
            return (
              <Fragment key={reactKey}>
                {banner && (
                  <tr className="catalog-rip-banner"
                      style={bannerColour ? { background: bannerColour.tint } : undefined}>
                    <td colSpan={totalColumns} className="catalog-rip-banner-cell"
                        style={bannerColour ? { borderLeft: `5px solid ${bannerColour.stripe}` } : undefined}>
                      <div className="catalog-rip-banner-row">
                        <span className="catalog-rip-banner-code"
                              style={bannerColour
                                ? { background: bannerColour.stripe, color: '#fff' }
                                : undefined}>
                          🔗 RIP {banner.code}
                        </span>
                        <span className="catalog-rip-banner-products">
                          {banner.products.length} product{banner.products.length === 1 ? '' : 's'}
                        </span>
                        {banner.tiers.length > 0 && (
                          <span className="catalog-rip-banner-tiers">
                            {banner.tiers.map((t, i) => (
                              <span key={i} className="catalog-rip-banner-tier"
                                    style={bannerColour ? { color: bannerColour.text } : undefined}>
                                Buy {t.qty} {t.isCases ? 'cs' : 'btl'} = <strong>${t.amount.toFixed(2)}</strong>
                              </span>
                            ))}
                          </span>
                        )}
                        {bannerProg && (
                          <span className={`catalog-rip-banner-progress tone-${bannerProg.tone}`}>
                            {bannerProg.text}
                          </span>
                        )}
                        <button
                          className="btn btn-sm catalog-rip-banner-add"
                          disabled={addAllMut.isPending}
                          onClick={e => {
                            e.stopPropagation();
                            // Partition the group's products into those with
                            // a typed qty and those with none. The button
                            // sends ONLY the typed-qty subset; the popup
                            // covers the partial / all-empty cases. Read
                            // from p.stepperKey — the row-unique cart key
                            // (name|wholesaler|upc|unit_volume) that the
                            // row's Case/Btl steppers write to. Using the
                            // old name|wholesaler shape here would always
                            // miss and fire "No quantities entered" even
                            // when the buyer just typed something.
                            const entries = banner.products.map(p => {
                              const q = cart[p.stepperKey] ?? { cases: 0, units: 0 };
                              return { ...p, qty_cases: q.cases, qty_units: q.units };
                            });
                            const toAdd = entries.filter(e => e.qty_cases > 0 || e.qty_units > 0);
                            const skipped = entries
                              .filter(e => e.qty_cases === 0 && e.qty_units === 0)
                              .map(e => ({ product_name: e.product_name }));
                            if (toAdd.length === 0) {
                              setAddAllConfirm({ code: banner.code, kind: 'none', toAdd: [], skipped });
                              return;
                            }
                            if (skipped.length > 0) {
                              setAddAllConfirm({ code: banner.code, kind: 'partial', toAdd, skipped });
                              return;
                            }
                            addAllMut.mutate({
                              ripCode: banner.code,
                              wholesaler: banner.products[0]?.wholesaler ?? '',
                              entries: toAdd,
                            });
                            setAddedFlash(banner.code);
                            setTimeout(() => setAddedFlash(null), 1600);
                          }}
                          title={`Add the typed quantity of every product in this RIP group. Products with no quantity entered are skipped.`}
                        >
                          {addedFlash === banner.code
                            ? (<><Check size={13} /> Added</>)
                            : (<><Plus size={13} /> Add All Case Mix to Cart</>)}
                        </button>
                        {/* Reset clears every typed Case/Btl value across the
                            products in this RIP cluster, so the buyer can
                            start the rebate basket over without scrolling
                            row by row. Greyed out when nothing's typed; the
                            count of products affected lives in the title. */}
                        {(() => {
                          const typedProducts = banner.products.filter(p => {
                            const q = cart[p.stepperKey];
                            return q && (q.cases > 0 || q.units > 0);
                          });
                          const hasTyped = typedProducts.length > 0;
                          // Committed quantity sitting in the server cart for
                          // this cluster. Reset must clear this too, otherwise
                          // "X in cart" never drops on removal.
                          const inCart = banner.casesInCart > 0 || banner.bottlesInCart > 0;
                          const canReset = hasTyped || inCart;
                          return (
                            <button
                              className="btn btn-sm btn-secondary catalog-rip-banner-reset"
                              disabled={!canReset || removeGroupMut.isPending}
                              onClick={e => {
                                e.stopPropagation();
                                // Clear the local typed steppers...
                                for (const p of typedProducts) {
                                  updateQty(p.stepperKey, 'cases', 0);
                                  updateQty(p.stepperKey, 'units', 0);
                                }
                                // ...and remove what's already committed to the
                                // cart for this cluster, so the banner count
                                // actually reflects the removal.
                                if (inCart) removeGroupMut.mutate(banner.products.map(p => p.cartKey));
                              }}
                              title={canReset
                                ? `Clear this Case Mix: removes ${inCart ? 'items already in your cart and ' : ''}any typed Case / Btl quantities (${banner.products.length} product${banner.products.length === 1 ? '' : 's'}).`
                                : 'Nothing typed or in cart for this Case Mix.'}
                            >
                              <X size={13} /> Reset
                            </button>
                          );
                        })()}
                      </div>
                    </td>
                  </tr>
                )}
                <tr className={`catalog-row-main${ripGroupCode ? ' has-rip-group' : ''}`}
                    style={ripBandStyle}
                    data-ctx=""
                    data-ctx-product={item.product_name}
                    data-ctx-wholesaler={item.wholesaler}
                    data-ctx-upc={item.upc}
                    data-ctx-volume={item.unit_volume}
                    onClick={() => open(item.product_name, item.wholesaler, undefined, {
                      upc: item.upc, unitVolume: item.unit_volume,
                      unitQty: item.unit_qty ?? undefined,
                      vintage: (item.vintage as string | null | undefined) ?? undefined,
                      // Pin the modal to the cluster the row is being shown
                      // under, so a product in multiple RIPs opens with the
                      // SAME code as the row banner (not its canonical code).
                      ripCode: ripGroupCode || undefined,
                    })}>
                  <td className="card-actions-cell" onClick={e => e.stopPropagation()}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                      <FavoriteButton productName={item.product_name} wholesaler={item.wholesaler}
                        upc={item.upc} unitVolume={item.unit_volume} />
                      <RowMenuButton product={{ product_name: item.product_name, wholesaler: item.wholesaler, upc: item.upc, unit_volume: item.unit_volume }} />
                    </span>
                  </td>
                  <td className="card-title-cell">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <ProductThumb src={item.image_url} alt={item.product_name} size={48} />
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div className="cat-name">{item.product_name}</div>
                        {/* Identifier line per Provi-style layout: Size and
                            bottles-per-case sit right under the name so the
                            buyer reads the SKU shape (1L, 12 btl/cs) at a
                            glance. UPC + badges follow on the next line.
                            The standalone Size column is dropped because
                            the same info is more useful here. */}
                        <div className="catalog-product-spec">
                          {item.unit_volume ?? '—'}
                          {item.unit_qty
                            ? <> · {item.unit_qty} btl/cs</>
                            : null}
                        </div>
                        <div className="cat-ident">
                          {item.upc}
                          {abgSku(item.wholesaler, item.abg_sku) && (
                            <span className="tag" style={{ marginLeft: 6, fontSize: 10 }}
                                  title="Allied (ABG) SKU">ABG {item.abg_sku}</span>
                          )}
                          {item.vintage != null && String(item.vintage) !== '0' && String(item.vintage).trim() !== '' && (
                            <span className="tag" style={{ marginLeft: 6, fontSize: 10 }}
                                  title="Vintage year. The same barcode can cover several vintages, each priced separately.">Vintage {item.vintage}</span>
                          )}
                          {item.multi_distributor && (() => {
                            const names = (item.multi_distributor_names ?? [])
                              .map(s => distributorName(s))
                              .filter(Boolean);
                            const title = names.length > 0
                              ? `Same product is carried by ${names.length} distributors: ${names.join(', ')}`
                              : `Same product is carried by ${item.distributor_count ?? 'several'} distributors`;
                            return (
                              <span className="tag tag-blue" style={{ marginLeft: 6, fontSize: 10 }}
                                    title={title}>
                                Multiple distributors{names.length > 0 ? ` (${names.length})` : ''}
                              </span>
                            );
                          })()}
                        </div>
                        {comboLink && (() => {
                          const url = comboLink(item);
                          return url
                            ? <a href={url} className="combo-link-badge"
                                 onClick={e => { e.preventDefault(); e.stopPropagation(); window.open(url, 'combo-bundle', 'popup,width=940,height=780'); }}
                                 title="This product is part of a combo bundle — open in a popup">🎁 In combo</a>
                            : null;
                        })()}
                        {ripGroupCode && (() => {
                          // Render one coloured sticker per RIP code this UPC
                          // qualifies under, with the primary (cluster) code
                          // first. Hard cap at 8 stickers + "+N more": some
                          // stub UPCs in the RIP sheet match HUNDREDS of
                          // codes and would otherwise blow up the row into a
                          // wall of badges.
                          // Show every RIP code the SKU qualifies under (was
                          // capped at 8). High ceiling only to avoid a runaway
                          // render on pathological data.
                          const HARD_CAP = 1000;
                          const all = (item.rip_all_codes && item.rip_all_codes.length > 0)
                            ? item.rip_all_codes
                            : [String(ripGroupCode)];
                          const ordered = [
                            String(ripGroupCode),
                            ...all.filter(c => String(c) !== String(ripGroupCode)),
                          ];
                          const visible = ordered.slice(0, HARD_CAP);
                          const overflow = ordered.length - visible.length;
                          return (
                            <span className="catalog-rip-group-row">
                              {visible.map((c, i) => {
                                const col = ripPalette.get(c) ?? ripColour;
                                const isPrimary = i === 0;
                                return (
                                  <button
                                    type="button"
                                    key={c}
                                    className="catalog-rip-group-badge catalog-rip-group-badge--btn"
                                    title={isPrimary
                                      ? `Click to see all products in RIP ${c}. Items sharing this code must be purchased together to qualify.`
                                      : `Click to see all products in RIP ${c}.`}
                                    style={col
                                      ? { background: col.tint, color: col.text, border: `1px solid ${col.border}` }
                                      : undefined}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setRipModal({ wholesaler: item.wholesaler, ripCode: String(c) });
                                    }}
                                  >
                                    🔗 RIP {c}
                                  </button>
                                );
                              })}
                              {overflow > 0 && (
                                <span
                                  className="catalog-rip-group-badge"
                                  title={`This UPC also qualifies under ${overflow} additional RIP code${overflow === 1 ? '' : 's'}. Open the product to see the full list.`}
                                  style={{ background: 'var(--surface)', color: 'var(--text-muted)', border: '1px solid var(--border)' }}
                                >
                                  +{overflow} more
                                </span>
                              )}
                            </span>
                          );
                        })()}
                        {showMismatch && (
                          <span className="catalog-rip-mismatch-badge"
                            title={`This UPC is listed under RIP ${ripGroupCode} on the RIP sheet, but the CPL row references a different code. Verify with the sales rep before relying on the rebate.`}
                          >
                            ⚠ Check with Sales Rep
                          </span>
                        )}
                        {item.better_month && (
                          <div style={{ marginTop: 3, display: 'flex', alignItems: 'center', gap: 5 }}>
                            <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>Better price:</span>
                            <span className="better-price-badge"
                              data-variant={item.better_month === 'This Month' ? 'this' : item.better_month === 'Next Month' ? 'next' : 'same'}
                              title={item.next_case_price != null
                                ? `This: $${(item.effective_case_price ?? item.frontline_case_price).toFixed(2)} · Next: $${(item.next_effective_case_price ?? item.next_case_price).toFixed(2)}`
                                : 'No next-month data'}>
                              {item.better_month}
                            </span>
                          </div>
                        )}
                        {/* Order facility: stays inline in the product cell
                            for simple products (no tier ladder below).
                            When tier sub-rows DO follow, the order block
                            instead rides on the LEFT of the first tier
                            sub-row, embedded in the same band as the
                            DISC / RIP rungs so the buyer reads
                            ladder + qty inputs as one unit. */}
                        {!hasTiers && (
                          <div onClick={e => e.stopPropagation()} className="catalog-order-inline"
                            style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                              <QtyStepper label="Case" value={qty.cases} onChange={v => updateQty(cartKey, 'cases', v)} />
                              <QtyStepper label="Btl" value={qty.units} onChange={v => updateQty(cartKey, 'units', v)} />
                            </div>
                            <div className="catalog-order-actions">
                              <AddToCartButton productName={item.product_name} wholesaler={item.wholesaler}
                                upc={item.upc} unitVolume={item.unit_volume}
                                qtyCases={qty.cases} qtyUnits={qty.units} />
                              <AddToListButton productName={item.product_name} wholesaler={item.wholesaler}
                                upc={item.upc} unitVolume={item.unit_volume} />
                            </div>
                          </div>
                        )}
                      </div>
                      {/* Two 3-month sparklines (1-case-discount price + best-RIP
                          price) over the last 3 existing editions, on the RIGHT
                          of the product cell. Hover -> popover with one block per
                          month, every price as case + bottle (with size). */}
                      {(() => {
                        const months = buildMonths(item);
                        if (months.length === 0) return null;
                        return (
                          <span onClick={e => e.stopPropagation()} style={{ marginLeft: 'auto', flexShrink: 0 }}>
                            <MonthEffectiveSparkline months={months} />
                          </span>
                        );
                      })()}
                    </div>
                  </td>
                  {/* Pro teaser cells: time-to-sell + buying suggestion +
                      justification. Placeholder copy until POS
                      integration is live. The Pro badge lives only on the
                      column header (no per-row repeat). Each cell still
                      carries a hover tooltip and a value-prop sticker.
                      Hidden as a block when "Show Pro Features" is off. */}
                  {showProColumns && (<>
                  <td className="catalog-pro-cell" data-label="Time to Sell"
                      title="Depending on the Case + Btl quantity you're adding to cart, this calculates how long that stock will take to sell through at your store's real sales velocity from POS. Updates live as you edit Case / Btl. Pick Day / Week / Month to switch the time unit.">
                    <div className="catalog-pro-body">
                      <div className="catalog-pro-value">
                        XX <span className="catalog-pro-unit">{ttsUnit === 'day' ? 'days' : ttsUnit === 'week' ? 'weeks' : 'months'}</span>
                      </div>
                      <div className="catalog-pro-sub">based on the qty you add to cart</div>
                      {/* Unit toggle. Click changes ttsUnit for every row at
                          once so the buyer picks once and the whole catalog
                          re-labels. Pure display preference for now; the
                          numeric XX is a placeholder until POS lands. */}
                      <div className="catalog-pro-unit-pick" onClick={e => e.stopPropagation()}>
                        {(['day', 'week', 'month'] as const).map(u => (
                          <button
                            key={u}
                            type="button"
                            className={`catalog-pro-unit-btn${ttsUnit === u ? ' is-active' : ''}`}
                            onClick={() => setTtsUnit(u)}
                          >
                            {u === 'day' ? 'Day' : u === 'week' ? 'Week' : 'Month'}
                          </button>
                        ))}
                      </div>
                      <span className="catalog-pro-savings">No more dead stock</span>
                    </div>
                  </td>
                  <td className="catalog-pro-cell" data-label="Suggested Qty"
                      title="Pro feature: connects to your POS. After integration this column shows the actual case + bottle quantity recommended for this product, calculated from your daily sell-through and current on-hand inventory.">
                    <div className="catalog-pro-body">
                      <div className="catalog-pro-value">Qty XXXXX</div>
                      <div className="catalog-pro-sub">cs / btl after POS sync</div>
                      <span className="catalog-pro-savings">Frees up 40+ hrs / week</span>
                    </div>
                  </td>
                  <td className="catalog-pro-cell" data-label="Quantity Justification"
                      title="Pro feature: after POS integration this column shows the math behind the suggestion — your store's daily sales velocity for this product, current on-hand stock, and the case count to buy this month.">
                    <div className="catalog-pro-body">
                      <dl className="catalog-pro-kv">
                        <div><dt>Store</dt><dd><em>[Store Name]</em></dd></div>
                        <div><dt>Velocity</dt><dd><strong>XX</strong> btl / day</dd></div>
                        <div><dt>On-hand</dt><dd><strong>YY</strong> btl</dd></div>
                        <div className="catalog-pro-kv-buy"><dt>Buy</dt><dd><strong>XXXXX</strong> cases</dd></div>
                      </dl>
                      <span className="catalog-pro-savings">Eliminates guess-work buying</span>
                    </div>
                  </td>
                  </>)}
                  <td data-label="Distributor"><span className="cell-distributor-badge">{distributorName(item.wholesaler)}</span></td>
                  <td data-label="Type">{item.product_type}</td>
                  {/* Size column dropped: surfaced in the product cell. */}
                  {showIntroduced && (
                    <td data-label="Introduced"><span className="tag tag-blue">{introMonth(item.introduced_edition)}</span></td>
                  )}
                  <td className="right" data-label="Case / Btl" style={{ fontWeight: 600 }}>
                    ${item.frontline_case_price.toFixed(2)}
                    <div className="cat-subprice">${item.frontline_unit_price.toFixed(2)}/btl</div>
                  </td>
                  <td data-label="Tier">
                    {hasTiers
                      ? <span className="text-muted cat-tier-note">{tiers.length} tier{tiers.length !== 1 ? 's' : ''} below</span>
                      : <span className="text-muted">&mdash;</span>}
                  </td>
                  <td className="right" data-label="Save"><span className="text-muted">&mdash;</span></td>
                  <td className="right" data-label="Effective" style={{ fontWeight: 600 }}>
                    ${item.effective_case_price.toFixed(2)}
                    {(() => {
                      const uq = Number(item.unit_qty);
                      return uq > 0
                        ? <div className="cat-subprice">${(item.effective_case_price / uq).toFixed(2)}/btl</div>
                        : null;
                    })()}
                    {item.live_better_than_month && item.live_effective_case_price != null && (
                      <div className="cat-subprice live-price" title="A dated RIP active today beats the stable month price">
                        ${item.live_effective_case_price.toFixed(2)} live now
                      </div>
                    )}
                  </td>
                  <td className="right" data-label="ROI / GP%">
                    {item.has_discount || item.has_rip
                      ? <span className="text-green">{item.discount_pct?.toFixed(1)}%</span>
                      : <span className="text-muted">&mdash;</span>}
                  </td>
                </tr>

                {tiers.map((t, idx) => {
                  const tierMet = (t.unit.toLowerCase().startsWith('case') || t.unit.toLowerCase() === 'c')
                    ? qty.cases >= t.qty : qty.units >= t.qty;
                  // Tier sub-rows wear the same coloured RIP band so the
                  // stripe reads as one continuous bar from the parent
                  // product down through its discount + RIP tier rows. The
                  // background gradient is dropped (only the parent gets the
                  // tinted lead-in) but the left edge bar carries through.
                  const tierBandStyle: React.CSSProperties | undefined = ripColour
                    ? { boxShadow: `inset 6px 0 0 ${ripColour.stripe}` }
                    : undefined;
                  return (
                    <tr key={`${reactKey}_${idx}`}
                        className={`catalog-row-sub${ripGroupCode ? ' has-rip-group' : ''}`}
                        style={tierBandStyle}
                        data-tier-met={tierMet}>
                      <td></td>
                      {/* Sub-row layout: chip + description are stacked in
                          a small inline-block that sits at the RIGHT edge
                          of the wide colSpan (so it sits next to Save /
                          Effective / ROI). Inside that stack both lines
                          are LEFT-aligned, so the description sits
                          directly beneath the chip with their left edges
                          flush. */}
                      {/* Tier sub-row spans Product + (optional) Introduced +
                          Distributor + Type, plus the Pro block when shown. */}
                      <td colSpan={(showIntroduced ? 6 : 5) + proColSpan} className="card-title-cell catalog-tier-sub-cell">
                        {/* Tier sub-cell is a flex row: the order block sits
                            on the LEFT (only on the FIRST tier row, so it
                            shows once per product even when several tiers
                            stack below). The chip + description stays
                            anchored on the RIGHT next to Save / Eff / ROI
                            exactly as before. */}
                        <div className="catalog-tier-sub-row">
                          {idx === 0 ? (
                            <div onClick={e => e.stopPropagation()} className="catalog-order-inline catalog-order-embedded"
                              style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                                <QtyStepper label="Case" value={qty.cases} onChange={v => updateQty(cartKey, 'cases', v)} />
                                <QtyStepper label="Btl" value={qty.units} onChange={v => updateQty(cartKey, 'units', v)} />
                              </div>
                              <div className="catalog-order-actions">
                                <AddToCartButton productName={item.product_name} wholesaler={item.wholesaler}
                                  upc={item.upc} unitVolume={item.unit_volume}
                                  qtyCases={qty.cases} qtyUnits={qty.units} />
                                <AddToListButton productName={item.product_name} wholesaler={item.wholesaler}
                                  upc={item.upc} unitVolume={item.unit_volume} />
                              </div>
                              <span className="catalog-order-hint"
                                    title="Type any quantity. The best applicable tier from the ladder on the right is applied automatically.">
                                best tier auto-applies
                              </span>
                            </div>
                          ) : (
                            <span className="catalog-order-embedded-spacer" aria-hidden />
                          )}
                          <div className="catalog-tier-sub-stack">
                            <div className="catalog-tier-sub-chip">
                              <span className={`source-badge source-${t.source}`}>{t.source === 'discount' ? 'DISC' : 'RIP'}</span>
                              <span className={`rip-tier-badge ${t.source === 'discount' ? 'rip-tier-curr' : 'rip-tier-next'}`}>
                                Buy {t.qty} {shortUnit(t.unit)} = <strong>${t.amount.toFixed(2)}</strong>
                              </span>
                            </div>
                            {t.description && (
                              <div className="catalog-tier-sub-desc">{t.description}</div>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="right" data-label="Save">
                        <span className="text-green font-bold">{fmt(t.save_per_case)}</span>
                        {t.save_per_bottle != null && (
                          <div className="cat-subprice">{fmt(t.save_per_bottle)}/btl</div>
                        )}
                      </td>
                      <td className="right font-bold" data-label="Eff">
                        {fmt(t.price_after)}
                        {t.btl_price_after != null && (
                          <div className="cat-subprice">{fmt(t.btl_price_after)}/btl</div>
                        )}
                      </td>
                      <td className="right" data-label="ROI">
                        <span className={t.roi_pct >= 10 ? 'text-green font-bold' : t.roi_pct >= 5 ? 'text-yellow' : ''}>
                          {t.roi_pct.toFixed(1)}%
                        </span>
                      </td>
                    </tr>
                  );
                })}

              </Fragment>
            );
          })}
          {items.length === 0 && (
            <tr><td colSpan={(showIntroduced ? 10 : 9) + proColSpan} className="empty">No products</td></tr>
          )}
        </tbody>
      </table>
      {ripModal && (
        <RipMembersModal
          wholesaler={ripModal.wholesaler}
          ripCode={ripModal.ripCode}
          onClose={() => setRipModal(null)}
        />
      )}
      {/* Confirmation popup for "Add All Case Mix to Cart" when some / all
          rows have no quantity typed. Two modes:
            'none'    — every product in the group has 0 cases AND 0 bottles;
                        ask the buyer to enter quantities first.
            'partial' — some products have qty, others don't; confirm that
                        only the typed ones are sent and the rest are skipped. */}
      {addAllConfirm && (
        <div className="catalog-confirm-overlay"
             role="dialog" aria-modal="true"
             aria-labelledby="catalog-confirm-title"
             onClick={e => { if (e.target === e.currentTarget) setAddAllConfirm(null); }}>
          <div className="catalog-confirm-modal">
            <div className="catalog-confirm-head">
              <span className="catalog-confirm-code">RIP {addAllConfirm.code}</span>
              <h3 id="catalog-confirm-title" className="catalog-confirm-title">
                {addAllConfirm.kind === 'none'
                  ? 'No quantities entered'
                  : `Skip ${addAllConfirm.skipped.length} product${addAllConfirm.skipped.length === 1 ? '' : 's'} with no quantity?`}
              </h3>
            </div>
            <div className="catalog-confirm-body">
              {addAllConfirm.kind === 'none' ? (
                <p>
                  None of the products in this Case Mix have a case or bottle quantity entered yet.
                  Enter quantities on the rows you want to order, then tap <b>Add All Case Mix to Cart</b> again.
                </p>
              ) : (
                <>
                  <p>
                    <b>{addAllConfirm.toAdd.length}</b> product{addAllConfirm.toAdd.length === 1 ? '' : 's'} with a typed quantity will be added to your cart.
                    The following {addAllConfirm.skipped.length === 1 ? 'product has' : `${addAllConfirm.skipped.length} products have`} no quantity entered and will be skipped:
                  </p>
                  <ul className="catalog-confirm-list">
                    {addAllConfirm.skipped.slice(0, 8).map((p, i) => (
                      <li key={i}>{p.product_name}</li>
                    ))}
                    {addAllConfirm.skipped.length > 8 && (
                      <li className="catalog-confirm-list-more">
                        + {addAllConfirm.skipped.length - 8} more
                      </li>
                    )}
                  </ul>
                </>
              )}
            </div>
            <div className="catalog-confirm-actions">
              {addAllConfirm.kind === 'partial' && (
                <button type="button" className="btn btn-primary"
                        onClick={() => {
                          const code = addAllConfirm.code;
                          const toAdd = addAllConfirm.toAdd;
                          const ws = toAdd[0]?.wholesaler ?? '';
                          setAddAllConfirm(null);
                          addAllMut.mutate({ ripCode: code, wholesaler: ws, entries: toAdd });
                          setAddedFlash(code);
                          setTimeout(() => setAddedFlash(null), 1600);
                        }}>
                  Add {addAllConfirm.toAdd.length} to Cart, Skip the Rest
                </button>
              )}
              <button type="button" className="btn btn-secondary"
                      onClick={() => setAddAllConfirm(null)}>
                {addAllConfirm.kind === 'none' ? 'Got it' : 'Cancel'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
