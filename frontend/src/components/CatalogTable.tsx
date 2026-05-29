import { Fragment, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Check } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import FavoriteButton from './FavoriteButton';
import ProductThumb from './ProductThumb';
import AddToCartButton from './AddToCartButton';
import AddToListButton from './AddToListButton';
import { RowMenuButton } from './ContextMenu';
import MonthEffectiveSparkline from './MonthEffectiveSparkline';
import RipMembersModal from './RipMembersModal';
import { distributorName } from '../lib/distributors';
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

type SortKey = 'product_name' | 'frontline_case_price' | 'effective_case_price';

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
}

/**
 * The shared product catalog table: a parent row per product plus expandable
 * DISC/RIP tier sub-rows ("Buy N = $X", save/case, price-after, ROI). Used by
 * the Catalog screen and the Order Analysis screen so they render identically.
 */
export default function CatalogTable({ items, open, cart, updateQty, sortControls, comboLink, showIntroduced, groupByRip }: Props) {
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
  const addAllMut = useMutation({
    mutationFn: async (entries: {
      product_name: string; wholesaler: string; upc?: string; unit_volume?: string;
      qty_cases: number; qty_units: number;
    }[]) => {
      for (const p of entries) {
        try {
          await cartApi.add({ product_name: p.product_name, wholesaler: p.wholesaler,
            upc: p.upc, unit_volume: p.unit_volume,
            qty_cases: p.qty_cases, qty_units: p.qty_units });
        } catch { /* keep going on partial failures */ }
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
    // No per-quantity tier ladder for this RIP (flat rebate or stripped
    // by the dedupe): we still surface the running total so the buyer
    // sees what they're about to send, just without the "X more for $Y"
    // milestone language.
    if (b.tiers.length === 0) {
      return { text: ledgerPrefix, tone: typed > 0 || inCart > 0 ? 'pending' : 'gap' };
    }
    const reached = b.tiers.filter(t => have >= t.qty);
    const ahead   = b.tiers.filter(t => have < t.qty);
    const best    = b.tiers[b.tiers.length - 1];
    if (reached.length > 0 && ahead.length === 0) {
      // Top tier hit. Lead with the win, then the ledger.
      return { text: `✓ Best RIP locked: $${best.amount.toFixed(2)} rebate · ${ledgerPrefix}`, tone: 'reached' };
    }
    const next = ahead[0];
    const gap = next.qty - have;
    if (reached.length > 0) {
      const top = reached[reached.length - 1];
      return {
        text: `${ledgerPrefix} · $${top.amount.toFixed(2)} earned · Add ${gap} more ${unitShort} for $${next.amount.toFixed(2)} (best: $${best.amount.toFixed(2)} at ${best.qty} ${unitShort})`,
        tone: 'pending',
      };
    }
    if (have === 0) {
      return { text: `Nothing entered yet · Add ${next.qty} ${unitShort} for $${next.amount.toFixed(2)} rebate (best: $${best.amount.toFixed(2)} at ${best.qty} ${unitShort})`, tone: 'gap' };
    }
    return {
      text: `${ledgerPrefix} · Add ${gap} more ${unitShort} for $${next.amount.toFixed(2)} rebate (best: $${best.amount.toFixed(2)} at ${best.qty} ${unitShort})`,
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
                so the value of the upgrade is visible while browsing. */}
            <th className="catalog-pro-th" title="Pro feature: connects to your POS to recommend how much to buy based on your real sales velocity and on-hand stock.">
              <span className="catalog-pro-badge">Pro</span>
              Suggested Qty
            </th>
            <th className="catalog-pro-th" title="Pro feature: explains the suggested quantity using your store's sales history and current inventory.">
              <span className="catalog-pro-badge">Pro</span>
              Quantity Justification
            </th>
            <th>Distributor</th>
            <th>Type</th>
            {/* Size column dropped: Size and Bottles-per-Case are surfaced
                in the product cell's identifier line. */}
            {showIntroduced && <th>Introduced</th>}
            <th {...rightHeadSort('frontline_case_price')}>Case / Btl{sortIcon('frontline_case_price')}</th>
            <th>Tier</th>
            <th className="right">Save (cs / btl)</th>
            <th {...rightHeadSort('effective_case_price')}>Effective (cs / btl){sortIcon('effective_case_price')}</th>
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
            // +2 for the Pro placeholder columns (Suggested Qty + Justification)
            // that sit between Product and Distributor.
            const totalColumns = showIntroduced ? 12 : 11;
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
                            // covers the partial / all-empty cases.
                            const entries = banner.products.map(p => {
                              const q = cart[`${p.product_name}|${p.wholesaler}`] ?? { cases: 0, units: 0 };
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
                            addAllMut.mutate(toAdd);
                            setAddedFlash(banner.code);
                            setTimeout(() => setAddedFlash(null), 1600);
                          }}
                          title={`Add the typed quantity of every product in this RIP group. Products with no quantity entered are skipped.`}
                        >
                          {addedFlash === banner.code
                            ? (<><Check size={13} /> Added</>)
                            : (<><Plus size={13} /> Add All Case Mix to Cart</>)}
                        </button>
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
                    onClick={() => open(item.product_name, item.wholesaler, undefined, { upc: item.upc, unitVolume: item.unit_volume })}>
                  <td className="card-actions-cell" onClick={e => e.stopPropagation()}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                      <FavoriteButton productName={item.product_name} wholesaler={item.wholesaler}
                        upc={item.upc} unitVolume={item.unit_volume} />
                      <RowMenuButton product={{ product_name: item.product_name, wholesaler: item.wholesaler, upc: item.upc, unit_volume: item.unit_volume }} />
                    </span>
                  </td>
                  <td className="card-title-cell">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <ProductThumb src={item.image_url} alt={item.product_name} size={64} />
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontWeight: 600 }}>{item.product_name}</div>
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
                        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                          {item.upc}
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
                          const HARD_CAP = 8;
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
                            <AddToCartButton productName={item.product_name} wholesaler={item.wholesaler}
                              upc={item.upc} unitVolume={item.unit_volume}
                              qtyCases={qty.cases} qtyUnits={qty.units} />
                            <AddToListButton productName={item.product_name} wholesaler={item.wholesaler}
                              upc={item.upc} unitVolume={item.unit_volume} />
                          </div>
                        )}
                      </div>
                      {/* This-month vs next-month sparkline sits on the
                          RIGHT side of the product cell, after the name +
                          spec + badges block, so the catalog row isn't
                          crowded next to the thumbnail. Popover lays out
                          Frontline / After Discount / RIP tiers / Best for
                          both months side by side. */}
                      {(() => {
                        const ce = item.effective_case_price ?? item.frontline_case_price ?? null;
                        const ne = item.next_effective_case_price ?? item.next_case_price ?? null;
                        if (ce == null && ne == null) return null;
                        const buildBlock = (
                          tiers: CatalogTier[] | undefined,
                          frontline: number | null,
                          bestEff: number | null,
                          edition: string | null,
                        ) => {
                          const disc = (tiers ?? []).filter(t => t.source === 'discount');
                          const rip  = (tiers ?? []).filter(t => t.source === 'rip');
                          const bestDisc = disc.length
                            ? Math.min(...disc.map(t => t.price_after ?? Infinity).filter(v => Number.isFinite(v)))
                            : null;
                          return {
                            edition,
                            frontline,
                            afterDiscount: bestDisc != null && Number.isFinite(bestDisc) ? bestDisc : null,
                            discountTiers: disc
                              .map(t => ({ qty: t.qty, unit: t.unit, eff: t.price_after ?? 0 }))
                              .filter(t => t.eff > 0),
                            ripTiers: rip
                              .map(t => ({ qty: t.qty, unit: t.unit, eff: t.price_after ?? 0 }))
                              .filter(t => t.eff > 0),
                            bestEff,
                          };
                        };
                        const nextEd = (() => {
                          const m = /^(\d{4})-(\d{1,2})$/.exec(item.edition ?? '');
                          if (!m) return null;
                          const y = parseInt(m[1], 10), mo = parseInt(m[2], 10);
                          const ny = mo === 12 ? y + 1 : y;
                          const nm = mo === 12 ? 1 : mo + 1;
                          return `${ny}-${String(nm).padStart(2, '0')}`;
                        })();
                        const curr = buildBlock(item.tiers, item.frontline_case_price ?? null, ce, item.edition ?? null);
                        const next = buildBlock(item.next_tiers, item.next_case_price ?? null, ne, nextEd);
                        return (
                          <span onClick={e => e.stopPropagation()} style={{ marginLeft: 'auto', flexShrink: 0 }}>
                            <MonthEffectiveSparkline curr={curr} next={next} />
                          </span>
                        );
                      })()}
                    </div>
                  </td>
                  {/* Pro teaser cells: the buying suggestion + the
                      justification behind it. Placeholder copy until POS
                      integration is live. The Pro badge lives only on the
                      column header (no per-row repeat). Each cell still
                      carries a hover tooltip and a value-prop sticker. */}
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
                  <td data-label="Distributor"><span className="cell-distributor-badge">{distributorName(item.wholesaler)}</span></td>
                  <td data-label="Type">{item.product_type}</td>
                  {/* Size column dropped: surfaced in the product cell. */}
                  {showIntroduced && (
                    <td data-label="Introduced"><span className="tag tag-blue">{introMonth(item.introduced_edition)}</span></td>
                  )}
                  <td className="right" data-label="Case / Btl" style={{ fontWeight: 600 }}>
                    ${item.frontline_case_price.toFixed(2)}
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 400 }}>${item.frontline_unit_price.toFixed(2)}/btl</div>
                  </td>
                  <td data-label="Tier">
                    {hasTiers
                      ? <span className="text-muted" style={{ fontSize: 11 }}>{tiers.length} tier{tiers.length !== 1 ? 's' : ''} below</span>
                      : <span className="text-muted">&mdash;</span>}
                  </td>
                  <td className="right" data-label="Save"><span className="text-muted">&mdash;</span></td>
                  <td className="right" data-label="Effective" style={{ fontWeight: 600 }}>
                    ${item.effective_case_price.toFixed(2)}
                    {(() => {
                      const uq = Number(item.unit_qty);
                      return uq > 0
                        ? <div style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 400 }}>${(item.effective_case_price / uq).toFixed(2)}/btl</div>
                        : null;
                    })()}
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
                      {/* +2 from the Pro placeholder columns (Suggested Qty
                          + Justification) that sit between Product and
                          Distributor; tier sub-rows skip across them. */}
                      <td colSpan={showIntroduced ? 8 : 7} className="card-title-cell catalog-tier-sub-cell">
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
                              <AddToCartButton productName={item.product_name} wholesaler={item.wholesaler}
                                upc={item.upc} unitVolume={item.unit_volume}
                                qtyCases={qty.cases} qtyUnits={qty.units} />
                              <AddToListButton productName={item.product_name} wholesaler={item.wholesaler}
                                upc={item.upc} unitVolume={item.unit_volume} />
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
                          <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{fmt(t.save_per_bottle)}/btl</div>
                        )}
                      </td>
                      <td className="right font-bold" data-label="Eff">
                        {fmt(t.price_after)}
                        {t.btl_price_after != null && (
                          <div style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 400 }}>{fmt(t.btl_price_after)}/btl</div>
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
            <tr><td colSpan={showIntroduced ? 12 : 11} className="empty">No products</td></tr>
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
                          setAddAllConfirm(null);
                          addAllMut.mutate(toAdd);
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
