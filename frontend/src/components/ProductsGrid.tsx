/**
 * Products page grid — a Provi-style grouped catalog.
 *
 * The search backend returns ONE ROW PER SKU (each size of a product is a
 * separate row). This component groups those rows into one expandable card per
 * product family (wholesaler + product_name). The collapsed card shows the
 * name, type, brand, distributor, a price RANGE across the sizes and the number
 * of size options; expanding reveals every size with its bottles/case, SKU,
 * deal badge, $/bottle – $/case price, a "See price schedule" link and Bottle /
 * Case order steppers.
 *
 * Everything else (semantic search, filters, facets, the cart) is the same
 * machinery the Catalog page uses — this is purely a new presentation layer.
 */
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, Store } from 'lucide-react';
import FavoriteButton from './FavoriteButton';
import ProductThumb from './ProductThumb';
import AddToCartButton from './AddToCartButton';
import AddToListButton from './AddToListButton';
import { QtyStepper, type CartState } from './CatalogTable';
import PriceSparklines from './PriceSparklines';
import DealLadder from './DealLadder';
import DealTimingSticker, { everyDayFromTiers } from './DealTimingSticker';
import DistCompareChip from './DistCompareChip';
import TierBadge from './TierBadge';
import { buildMonths } from '../lib/promotionsSparkline';
import { catalog } from '../lib/api';
import { useProductSizes, bottlesPerCase, stripHeaderVintage } from '../lib/productSizes';
import { useComboLink } from '../lib/comboLink';
import { distributorName, abgSku, skuLabel, containerTitle, containerNoun, packPhrase, priceUnitWord, perUnitNoun, isKegUnit } from '../lib/distributors';
import { isRealUpc } from '../lib/upc';
import type { Product } from '../lib/api';

// Full-page product-detail deep link for a product family.
function detailUrl(wholesaler: string, productName: string, upc?: string | null, unitVolume?: string | null): string {
  const q = new URLSearchParams({ w: wholesaler, n: productName });
  if (upc) q.set('u', String(upc));
  if (unitVolume) q.set('s', String(unitVolume));   // exact size, so the link pins one SKU
  return `/product?${q.toString()}`;
}

// Parse a size label ("750ML", "1.75L", "16OZ") to millilitres so sizes sort
// smallest -> largest. Unknowns sort last. (Same heuristic the catalog filter
// rail uses.)
function toMl(label?: string | null): number {
  const s = (label || '').toUpperCase().trim();
  const m = s.match(/^([\d.]+)\s*(ML|L|LIT|LITER|OZ)?/);
  if (!m) return Number.MAX_SAFE_INTEGER;
  const n = parseFloat(m[1]);
  if (isNaN(n)) return Number.MAX_SAFE_INTEGER;
  const unit = m[2] || 'ML';
  if (unit.startsWith('L')) return n * 1000;
  if (unit === 'OZ') return n * 29.5735;
  return n;
}

// "2026-06" -> "Jun 2026" for the New Items "introduced" sticker.
const _INTRO_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function introLabel(ym?: string | null): string | null {
  if (!ym) return null;
  const m = /^(\d{4})-(\d{1,2})/.exec(String(ym));
  if (!m) return null;
  const mon = _INTRO_MONTHS[parseInt(m[2], 10) - 1];
  return mon ? `${mon} ${m[1]}` : ym;
}
function IntroSticker({ ym }: { ym?: string | null }) {
  const label = introLabel(ym);
  if (!label) return null;
  return (
    <span className="prod-new-sticker" title={`New item — first introduced ${label}`}>
      New · {label}
    </span>
  );
}

interface ProductGroup {
  key: string;
  wholesaler: string;
  productName: string;        // a representative SKU name (detail link / expand seed)
  displayName: string;        // clean family title shown on the card
  productType: string;
  brand?: string;
  imageUrl?: string | null;
  celrNumber?: string | null; // CELR Product Number chip (family identity)
  sizes: Product[];          // one Product row per size, sorted small -> large
  // Ungrouped ("Group products" OFF) mode: this group is ONE distributor +
  // size + pack, with its UPC variants (vintages / closeout / dup barcodes)
  // collapsed to a single best-price representative. memberCount = how many
  // listings collapsed (>1 shows a badge).
  flat?: boolean;
  memberCount?: number;
}

// Normalise a pack count for keying ("12" / "12.0" / 12 -> "12").
function normPack(uq: unknown): string {
  return String(uq ?? '').replace(/\.0+$/, '').trim();
}

// Pick the representative listing when collapsing several UPCs at one
// (distributor, size, pack): prefer a NON-bundle, then the cheapest effective
// price (what the buyer actually pays), then the latest vintage. Mirrors the
// "non-bundle -> latest vintage" SKU-identity rule, with price as the tiebreak
// the user asked for ("best of N UPCs").
function pickRep(members: Product[]): Product {
  const eff = (p: Product) => p.effective_case_price ?? p.frontline_case_price ?? Infinity;
  const isBundle = (p: Product) => !!(p.combo_code && p.combo_code !== '0' && p.combo_code !== '');
  const vintageNum = (p: Product) => { const v = parseInt(String(p.vintage ?? ''), 10); return Number.isFinite(v) ? v : -1; };
  return [...members].sort((a, b) =>
    (isBundle(a) ? 1 : 0) - (isBundle(b) ? 1 : 0)
    || eff(a) - eff(b)
    || vintageNum(b) - vintageNum(a))[0];
}

// Title-case an ALL-CAPS distributor name ("ABSOLUT CITRON" -> "Absolut
// Citron"); leave already-mixed-case Go-UPC names untouched.
function titleCaseIfShouty(s: string): string {
  return s && s === s.toUpperCase()
    ? s.toLowerCase().replace(/\b\w/g, c => c.toUpperCase()) : s;
}

// Clean a product name for DISPLAY: drop the size/pack and the "- Bottle"
// style suffix (size + distributor are shown separately), so a Go-UPC name
// like "Absolut Citron Vodka 1L" reads "Absolut Citron Vodka".
function cleanDisplayName(s: string | null | undefined): string {
  if (!s) return '';
  const out = s
    .replace(/\s*[-–|]\s*(bottle|can|keg|case)s?\s*$/i, '')
    .replace(/\b\d+(\.\d+)?\s*(ml|l|liter|litre|oz|cl|gal)\b/gi, ' ')
    .replace(/\b\d+\s*(pk|pack|pks|bt|btl|btls)\b/gi, ' ')
    .replace(/\s{2,}/g, ' ').trim();
  return titleCaseIfShouty(out) || titleCaseIfShouty(s);
}

// Family title for GROUPED mode, derived from the members' OWN names — the
// Go-UPC enrichment name (per-UPC source of truth) when present, else the
// distributor product name — instead of the CELR family header, which can be
// wrong (an Absolut Citron family stamped "Absolut Mandarin"). Picks the most
// common cleaned name across the members, preferring one a Go-UPC name backs.
function deriveFamilyName(members: Product[]): string | null {
  const counts = new Map<string, { n: number; label: string; hasEnr: boolean }>();
  for (const m of members) {
    const label = cleanDisplayName(m.enrichment_name || m.product_name);
    if (!label) continue;
    const k = label.toUpperCase();
    const c = counts.get(k) ?? { n: 0, label, hasEnr: false };
    c.n++; c.hasEnr = c.hasEnr || !!m.enrichment_name;
    counts.set(k, c);
  }
  if (!counts.size) return null;
  return [...counts.values()].sort((a, b) =>
    (b.hasEnr ? 1 : 0) - (a.hasEnr ? 1 : 0) || b.n - a.n)[0].label;
}

// Group by the server-provided product family key so a product's
// differently-named sizes (GLENFID MALT 12Y 12P / 12YR / 6P …) collapse into
// ONE card. The key is DISTRIBUTOR-AGNOSTIC (product_group = brand|enrichment
// core, shared across distributors by UPC), so the same product carried by
// several distributors merges into one card and each distributor's listing
// shows as its own size row — instead of a separate card per distributor.
function groupByProduct(items: Product[], grouped = true): ProductGroup[] {
  const map = new Map<string, ProductGroup>();
  const order: string[] = [];
  for (const it of items) {
    const fam = (it.product_group && it.product_group.trim()) ? it.product_group : it.product_name;
    // Grouped: distributor-agnostic family card. Ungrouped (default): one group
    // per distributor + family + size + pack, so the cross-distributor merge is
    // OFF and each distributor's listing of each size stands on its own.
    const key = grouped
      ? fam
      : `${it.wholesaler}|${fam}|${it.unit_volume ?? ''}|${normPack(it.unit_qty)}`;
    let g = map.get(key);
    if (!g) {
      g = {
        key,
        wholesaler: it.wholesaler,
        productName: it.product_name,
        displayName: it.product_display || it.product_name,
        productType: it.product_type,
        brand: it.brand,
        imageUrl: it.image_url,
        celrNumber: it.celr_product_number ?? null,
        sizes: [],
        flat: !grouped,
      };
      map.set(key, g);
      order.push(key);
    }
    if (!g.imageUrl && it.image_url) g.imageUrl = it.image_url;
    g.sizes.push(it);
  }
  for (const g of map.values()) {
    if (g.flat) {
      // Collapse the UPC variants to ONE best-price representative.
      g.memberCount = g.sizes.length;
      const rep = pickRep(g.sizes);
      g.productName = rep.product_name;
      // Flat mode shows ONE SKU, so use ITS OWN name — the Go-UPC enrichment
      // name (clean, by UPC) when present, else the distributor's product_name.
      // NEVER product_display: that's the CELR FAMILY title, which mis-labels a
      // SKU when the family is wrong (e.g. an Absolut Citron tagged the family's
      // "Absolut Mandarin").
      g.displayName = cleanDisplayName(rep.enrichment_name || rep.product_name);
      g.wholesaler = rep.wholesaler;
      g.imageUrl = g.imageUrl ?? rep.image_url;
      g.celrNumber = rep.celr_product_number ?? g.celrNumber;
      g.sizes = [rep];
    } else {
      // Family card title: prefer the Go-UPC-derived name over the (sometimes
      // wrong) CELR family header. Falls back to the existing title when no
      // member carries a Go-UPC enrichment name.
      g.displayName = deriveFamilyName(g.sizes) ?? g.displayName;
      // size ascending, then by distributor so a product's listings group cleanly
      g.sizes.sort((a, b) =>
        toMl(a.unit_volume) - toMl(b.unit_volume) || a.wholesaler.localeCompare(b.wholesaler));
    }
  }
  return order.map(k => map.get(k)!);
}

// Price after the 1-CASE quantity discount (what you pay buying a single case),
// from the row's discount tiers — NOT the deepest RIP. Falls back to frontline
// when there's no 1-case QD. Bottle-unit tiers (qty <= pack) count as reachable.
function oneCaseQdCase(s: Product): number | null {
  const front = s.frontline_case_price ?? null;
  const pack = bottlesPerCase(s.product_name, s.unit_qty);
  const disc = (s.discount_tiers ?? s.tiers ?? []).filter(
    t => t.source !== 'rip' && t.price_after != null);
  const reachable = disc.filter(t => {
    const isBtl = /^\s*b/i.test(String(t.unit ?? ''));
    return isBtl ? (pack ? t.qty <= pack : false) : t.qty <= 1;
  });
  if (reachable.length) return Math.min(...reachable.map(t => t.price_after as number));
  return front;
}

// Best-QD sticker for the card header (top-right). Shows the deepest quantity-
// discount bracket from the backend-computed `best_qd` (RIP excluded): the case
// requirement, the best case price AND best bottle cost, $/case saved, and the
// total cash for the bracket. Falls back across rows so it shows on the list row
// (best_qd is on every Products list row, no tier fetch needed).
function BestQdSticker({ s }: { s?: Product | null }) {
  const qd = s?.best_qd;
  if (!qd) return null;
  const cs = qd.cases;
  const money = (v: number | null | undefined) =>
    v == null ? '' : `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const moneyR = (v: number | null | undefined) =>
    v == null ? '' : `$${Math.round(v).toLocaleString()}`;
  return (
    <span className="prod-bestqd"
      title={`Best quantity discount${cs != null ? `: buy ${cs} case${cs === 1 ? '' : 's'}` : ''} → ${money(qd.case_price)}/case`
        + (qd.bottle_price != null ? ` · ${money(qd.bottle_price)}/bottle` : '')
        + ` · save ${money(qd.save_per_case)}/case`
        + (qd.total_cost != null ? ` · ${moneyR(qd.total_cost)} total cost` : '')
        + (qd.total_save != null ? ` · ${moneyR(qd.total_save)} total saved` : '')
        + ' (excludes RIP)'}>
      <span className="prod-bestqd-head">
        <span className="prod-bestqd-k">Best QD</span>
        {cs != null && <span className="prod-bestqd-q">{cs} cs</span>}
      </span>
      <span className="prod-bestqd-p">{money(qd.case_price)}/cs{qd.bottle_price != null && <> · {money(qd.bottle_price)}/btl</>}</span>
      <span className="prod-bestqd-s">
        save {money(qd.save_per_case)}/cs
        {qd.total_save != null && <> · {moneyR(qd.total_save)} total QD</>}
      </span>
    </span>
  );
}

// Better-price month sticker: is the effective case price best THIS month, or
// cheaper NEXT month (when that edition is loaded)? Labelled with the actual
// month NAME and coloured by which wins (green = buy now, blue = cheaper next).
// Tooltip explains WHY with the real per-case numbers.
const _FULL_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
function _monthName(ed?: string | null): string {
  const m = /^(\d{4})-(\d{1,2})/.exec(ed ?? '');
  return m ? (_FULL_MONTHS[parseInt(m[2], 10) - 1] ?? '') : '';
}
function _nextMonthName(ed?: string | null): string {
  const m = /^(\d{4})-(\d{1,2})/.exec(ed ?? '');
  return m ? (_FULL_MONTHS[parseInt(m[2], 10) % 12] ?? '') : '';   // +1 month, wraps Dec→Jan
}
function BetterMonthSticker({ s, repRow }: { s?: Product | null; repRow?: Product | null }) {
  const row = (repRow && s?.upc && repRow.upc === s.upc && repRow.wholesaler === s.wholesaler)
    ? repRow : (s ?? repRow);
  const cur = row?.effective_case_price ?? null;
  const curMo = _monthName(row?.edition);
  if (cur == null || !curMo) return null;
  const next = row?.next_effective_case_price ?? null;
  const nextMo = _nextMonthName(row?.edition);
  const money = (v: number) => `$${v.toFixed(2)}`;
  if (next != null && next < cur - 0.01) {
    const save = cur - next;
    return (
      <span className="prod-bettermo prod-bettermo--next"
        title={`Cheaper next month — ${nextMo}: ${money(next)}/cs vs ${curMo}: ${money(cur)}/cs. Save ${money(save)}/cs by waiting.`}>
        Best · {nextMo}
      </span>
    );
  }
  let tip = `Best price this month — ${curMo}: ${money(cur)}/cs.`;
  if (next != null) tip += next > cur + 0.01
    ? ` Next month (${nextMo}) rises to ${money(next)}/cs (+${money(next - cur)}/cs) — buy now.`
    : ` Next month (${nextMo}): ${money(next)}/cs (same).`;
  return (
    <span className="prod-bettermo prod-bettermo--now" title={tip}>Best · {curMo}</span>
  );
}

// True per-bottle list price, correcting slash-multipacks (unit_qty = trays)
// the same way every other per-bottle surface does.
function bottleUnitPrice(s: Product): number | null {
  const pack = bottlesPerCase(s.product_name, s.unit_qty);
  if (pack && s.frontline_case_price != null) return s.frontline_case_price / pack;
  return s.frontline_unit_price ?? null;
}

// Card headline price (user rule): the CASE price after the 1-case QD when
// one exists, with the per-bottle right beside it at the SAME size — never
// the bottle price alone. `repRow` (the rep listing fetched WITH tiers) is
// preferred over the bare list row so the 1-cs QD is actually visible.
function CardPriceLine({ s, repRow }: { s: Product; repRow?: Product | null }) {
  const row = repRow && s.upc && repRow.upc === s.upc && repRow.wholesaler === s.wholesaler ? repRow : s;
  const caseP = oneCaseQdCase(row) ?? row.effective_case_price ?? null;
  if (caseP == null) {
    const btlOnly = bottleUnitPrice(row);
    if (btlOnly == null) return null;
    return (
      <div className="prod-card-range">
        ${btlOnly.toFixed(2)}/{perUnitNoun(row.unit_volume, row.unit_type)}
        {' '}<span className="prod-card-range-size">({row.unit_volume})</span>
      </div>
    );
  }
  const pack = bottlesPerCase(row.product_name, row.unit_qty);
  const keg = isKegUnit(row.unit_volume, row.unit_type);
  const btl = keg ? null : (pack ? caseP / pack : (row.frontline_unit_price ?? null));
  return (
    <div className="prod-card-range">
      ${caseP.toFixed(2)}/{priceUnitWord(row.unit_volume, row.unit_type)}
      {btl != null && <span className="prod-card-range-btl"> · ${btl.toFixed(2)}/{perUnitNoun(row.unit_volume, row.unit_type)}</span>}
      {' '}<span className="prod-card-range-size">({row.unit_volume})</span>
    </div>
  );
}

// "$0.83 (50mL) – $19.29 (1.75L)" — the per-bottle price range across the
// product's sizes, each end labelled with its own size. Uses the corrected
// per-bottle price so a 50mL 120-pack reads $2.99, not $35.90/tray.
function priceRange(sizes: Product[]): { lo: Product; hi: Product; loPrice: number; hiPrice: number } | null {
  const priced = sizes
    .map(s => ({ s, p: bottleUnitPrice(s) }))
    .filter((x): x is { s: Product; p: number } => x.p != null);
  if (priced.length === 0) return null;
  let lo = priced[0], hi = priced[0];
  for (const x of priced) {
    if (x.p < lo.p) lo = x;
    if (x.p > hi.p) hi = x;
  }
  return { lo: lo.s, hi: hi.s, loPrice: lo.p, hiPrice: hi.p };
}

// Nest a grouped card's sizes into the 4-level hierarchy the Products view shows:
//   CELR Product (the card) -> Distributor -> Distributor Product Name -> Size/Price.
// Distributor product names differ across distributors, but UPC matching already
// unified them under one CELR family (the card); here we only split WITHIN a
// distributor by its own catalogue name. Page wholesaler sorts first.
function nestByDistributor(sizes: Product[], pageWholesaler: string) {
  const byDist = new Map<string, Product[]>();
  for (const s of sizes) {
    const arr = byDist.get(s.wholesaler) ?? [];
    arr.push(s);
    byDist.set(s.wholesaler, arr);
  }
  const order = [...byDist.keys()].sort((a, b) =>
    (a === pageWholesaler ? 0 : 1) - (b === pageWholesaler ? 0 : 1)
    || distributorName(a).localeCompare(distributorName(b)));
  return order.map(w => {
    const byName = new Map<string, Product[]>();
    for (const s of byDist.get(w)!) {
      const nm = (cleanDisplayName(s.product_name) || s.product_name || '—').trim();
      const arr = byName.get(nm) ?? [];
      arr.push(s);
      byName.set(nm, arr);
    }
    return { wholesaler: w, products: [...byName.entries()].map(([name, ss]) => ({ name, sizes: ss })) };
  });
}

function SizeRow({ size, cart, updateQty, primaryName, showDeals = true, hideDist = false }: {
  size: Product;
  cart: CartState;
  updateQty: (key: string, field: 'cases' | 'units', value: number) => void;
  primaryName?: string;
  // Detail view (Price details) shows the deal ladder on screen; Summary hides it.
  showDeals?: boolean;
  // Hide the per-row distributor chip when a Distributor header already shows it
  // (the 4-level grouped card body).
  hideDist?: boolean;
}) {
  const cartKey = `${size.product_name}|${size.wholesaler}|${size.upc ?? ''}|${size.unit_volume ?? ''}`;
  const qty = cart[cartKey] ?? { cases: 0, units: 0 };
  const pack = bottlesPerCase(size.product_name, size.unit_qty);
  const comboLink = useComboLink();
  const comboUrl = comboLink(size.wholesaler, size.upc);
  const sku = abgSku(size.wholesaler, size.abg_sku) ? `${skuLabel(size.wholesaler)} ${size.abg_sku}` : size.upc;
  // Headline = price after the 1-case QD (the realistic single-case price), not
  // the deepest RIP. The deeper RIP/QD tiers still show in the deal ladder below.
  const caseP = oneCaseQdCase(size) ?? size.effective_case_price;
  const btlPrice = pack ? caseP / pack : (size.frontline_unit_price ?? caseP);
  // Current-month quantity-discount + RIP tier ladders, shown inline so the
  // buyer gets every number without hovering the sparkline. Driven from the
  // SAME price_3mo data the sparkline uses (via buildMonths), so the inline
  // deals can never disagree with the chart (the row's flat `tiers` array can
  // be dropped on the multi-UPC variant search while price_3mo survives).
  const months = buildMonths(size);
  return (
    <div className="prod-size-row">
      <Link to={detailUrl(size.wholesaler, size.product_name, size.upc, size.unit_volume)} className="prod-size-id"
        title="Open this product — exact size and UPC">
        <div className="prod-size-name">{size.unit_volume || '-'} {containerTitle(size.unit_volume, size.unit_type)}</div>
        {/* The distributor's EXACT catalogue name always shows on the listing
            line (it's how the buyer matches the row to the distributor's own
            book) — suppressed only when it would literally repeat the card
            title above it. Compared case-insensitively: the title is the
            standardized CELR header, the listing name is the raw line. */}
        {size.product_name && size.product_name.trim().toUpperCase() !== (primaryName ?? '').trim().toUpperCase() && (
          <div className="prod-size-variant">{size.product_name}</div>
        )}
        {!hideDist && <div className="prod-size-dist"><Store size={11} /> {distributorName(size.wholesaler)}</div>}
        <div className="prod-size-pack">{packPhrase(pack, size.unit_volume, size.unit_type)}</div>
        {sku && <div className="prod-size-sku">SKU: {sku}</div>}
        {size.vintage != null && String(size.vintage) !== '0' && String(size.vintage).trim() !== '' && (
          <span className="tag tag-blue prod-size-vintage">Vintage {size.vintage}</span>
        )}
      </Link>
      <div className="prod-size-price">
        <span className="prod-size-badges">
          <IntroSticker ym={size.introduced_edition} />
          {size.has_discount && <TierBadge kind="qd" />}
          {size.has_rip && <TierBadge kind="rip" />}
          <DealTimingSticker deals={size.deal_windows ?? []} gaps={size.rip_gaps}
            everyDay={everyDayFromTiers(size.tiers, size.frontline_case_price)} />
          {comboUrl && (
            <Link to={comboUrl} className="prod-combo-sticker" onClick={e => e.stopPropagation()}
              title="This product is part of a combo bundle — view the combo">🎁 Combo</Link>
          )}
        </span>
        {/* Case price first (the buying unit), then per-unit. A keg has no
            per-bottle price, so only the keg price is shown. */}
        <div className="prod-size-amounts">
          <span className="prod-size-case">${caseP.toFixed(2)}/{priceUnitWord(size.unit_volume, size.unit_type)}</span>
          {!isKegUnit(size.unit_volume, size.unit_type) && (
            <span className="prod-size-btl">${btlPrice.toFixed(2)}/{perUnitNoun(size.unit_volume, size.unit_type)}</span>
          )}
        </div>
        <PriceSparklines wholesaler={size.wholesaler} productName={size.product_name}
          upc={size.upc} unitVolume={size.unit_volume} unitQty={size.unit_qty} vintage={size.vintage}
          months={months} />
      </div>
      {/* Inline RIP + quantity-discount tiers for the current month — one shared
          DealLadder (tier qty, total $ off, price-after for BOTH case + bottle)
          so the numbers always match the sparkline tooltip. Detail view only;
          Summary hides the ladder to stay compact. */}
      {showDeals && (
        <div className="prod-size-deals">
          <DealLadder months={months} pack={pack} emptyText="No deals this month"
            unitVolume={size.unit_volume} unitType={size.unit_type} />
        </div>
      )}
      <div className="prod-size-order">
        <div className="prod-size-steppers">
          <QtyStepper label={isKegUnit(size.unit_volume, size.unit_type) ? 'Kegs' : containerNoun(size.unit_volume, size.unit_type) === 'can' ? 'Cans' : 'Bottles'}
            value={qty.units} onChange={v => updateQty(cartKey, 'units', v)} />
          {!isKegUnit(size.unit_volume, size.unit_type) && (
            <QtyStepper label="Cases" value={qty.cases} onChange={v => updateQty(cartKey, 'cases', v)} />
          )}
        </div>
        <div className="prod-size-actions">
          <AddToCartButton productName={size.product_name} wholesaler={size.wholesaler}
            upc={size.upc} unitVolume={size.unit_volume}
            qtyCases={qty.cases} qtyUnits={qty.units} />
          <AddToListButton productName={size.product_name} wholesaler={size.wholesaler}
            upc={size.upc} unitVolume={size.unit_volume} />
        </div>
      </div>
    </div>
  );
}

function ProductCard({ group, cart, updateQty, showDeals = true, defaultExpanded = false }: {
  group: ProductGroup;
  cart: CartState;
  updateQty: (key: string, field: 'cases' | 'units', value: number) => void;
  // Page-level "Price details / Summary" toggle: false hides the collapsed
  // card's deal ladder (the expanded size rows always keep theirs).
  showDeals?: boolean;
  // Start expanded (used on an active search, so result details + add-to-cart
  // show without a click). Per-card collapse still works afterwards.
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  // Hover/focus intent: start the expand-time fetches (full size set + tiers)
  // as soon as the pointer reaches the card, so clicking the chevron renders
  // from cache instead of waiting seconds for the network.
  const [warm, setWarm] = useState(false);
  const warmUp = () => setWarm(true);
  const range = priceRange(group.sizes);
  const anyDisc = group.sizes.some(s => s.has_discount);   // quantity discount
  const anyRip = group.sizes.some(s => s.has_rip);          // RIP
  const comboLink = useComboLink();
  const comboUrl = group.sizes.map(s => comboLink(s.wholesaler, s.upc)).find(Boolean) ?? null;
  const first = group.sizes[0];

  // Collapsed-card deal summary: the REAL current-month QD + RIP tier ladder for
  // the rep (cheapest) size, from the SAME canonical price_3mo the expanded rows
  // and sparkline use — no invented "best RIP". The list row omits price_3mo for
  // speed, so we fetch the rep's tiers lazily (only once the card scrolls into
  // view) and feed that ONE fetch to both the ladder and the sparkline (the
  // sparkline runs with noSelfFetch so the page never fires two requests/card).
  const rep = range?.lo ?? first;
  const repPack = rep ? bottlesPerCase(rep.product_name, rep.unit_qty) : null;
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    if (inView || !cardRef.current) return;
    const io = new IntersectionObserver(es => {
      for (const e of es) if (e.isIntersecting) { setInView(true); io.disconnect(); break; }
    }, { rootMargin: '150px' });
    io.observe(cardRef.current);
    return () => io.disconnect();
  }, [inView]);
  const { data: repTierData } = useQuery({
    enabled: inView && !!rep?.wholesaler && isRealUpc(rep?.upc),
    staleTime: 5 * 60_000,
    queryKey: ['rep-tiers', rep?.wholesaler, rep?.upc],
    queryFn: () => catalog.search({ wholesaler: rep!.wholesaler, upcs: String(rep!.upc), include_tiers: true, limit: 1 }),
  });
  const repRow = (repTierData?.items?.[0] as Product | undefined) ?? rep;
  const repMonths = repRow ? buildMonths(repRow) : [];

  // Cross-distributor best-price nudge: the SAME UPC at OTHER distributors. One
  // lazy search (when the card scrolls into view) by the rep's barcode across
  // ALL distributors, fed to DistCompareChip with selfWholesaler so the chip
  // reads "Best price: <distributor> · save $/cs" and its hover shows the full
  // QD + RIP ladder per distributor. Real barcodes only (placeholders shared).
  const { data: crossDistData } = useQuery({
    enabled: inView && isRealUpc(rep?.upc),
    staleTime: 5 * 60_000,
    queryKey: ['card-cross-dist', String(rep?.upc)],
    queryFn: () => catalog.search({ upcs: String(rep!.upc), include_tiers: true, limit: 50 }),
  });
  const crossDistRows = (crossDistData?.items ?? []) as Product[];

  // The list is paginated by SKU, so a product's sizes can be split across
  // pages. On expand, fetch the FULL size set via the shared "products by size"
  // tool (handles spirits' inconsistent names + wine's vintages) so every size
  // always shows regardless of where the page boundary fell.
  // Ungrouped (flat) mode shows ONE distributor+size, so never pull the full
  // size set on expand — that would re-introduce the sizes we deliberately
  // split into their own rows.
  const { sizes: fullSizes, isFetching } = useProductSizes(
    group.wholesaler, group.productName, first?.upc, (expanded || warm) && !group.flat);
  // Distinct distributors carrying this product (one row per distributor's
  // listing). When >1, keep the search rows (they already span distributors) —
  // the single-distributor "all sizes" fetch would otherwise drop the others.
  const distSlugs = useMemo(() => [...new Set(group.sizes.map(s => s.wholesaler))], [group.sizes]);
  const multiDist = distSlugs.length > 1;
  // For a multi-distributor product, refetch the listings BY UPC across all
  // distributors WITH tiers (the list rows lack tiers/price_3mo, which left the
  // deal ladder empty — "No deals this month" — and the headline at frontline).
  // Placeholder barcodes (111111111117 etc.) are shared by unrelated products,
  // so they are NEVER used as fetch keys; rows carrying one are merged back in
  // from the search results below so they stay visible.
  const groupUpcs = useMemo(
    () => [...new Set(group.sizes.map(s => s.upc).filter(u => isRealUpc(u)) as string[])], [group.sizes]);
  const { data: multiData } = useQuery({
    enabled: (expanded || warm) && multiDist && groupUpcs.length > 0,
    staleTime: 30 * 60_000,
    queryKey: ['multidist-sizes', groupUpcs.join(',')],
    queryFn: () => catalog.search({ upcs: groupUpcs.join(','), include_tiers: true, limit: 200, sort: 'product_name', order: 'asc' }),
  });
  const sizes = useMemo(() => {
    // The size refetches only cover real barcodes; re-attach this card's own
    // search rows the fetch couldn't address (placeholder/blank UPC), deduped
    // against what came back so nothing shows twice. Show, don't hide.
    const rowKey = (p: Product) =>
      `${p.wholesaler}|${String(p.upc ?? '').replace(/^0+/, '')}|${p.product_name}|${p.unit_volume ?? ''}`;
    const withOwnRows = (fetched: Product[]) => {
      const seen = new Set(fetched.map(rowKey));
      return [...fetched, ...group.sizes.filter(s => !seen.has(rowKey(s)))];
    };
    let base: Product[];
    if (group.flat) {
      // Flat mode shows ONE listing and skips the full-size fetch, so the bare
      // group row has no price_3mo (-> the deal ladder read "No deals this
      // month"). Use the SAME tier-enriched rep (repRow) the card header
      // already fetches, so the size row's deals match the sparkline.
      base = [repRow];
    } else if (multiDist) {
      base = multiData?.items ? withOwnRows(multiData.items as Product[]) : group.sizes;
    } else {
      base = fullSizes.length ? withOwnRows(fullSizes) : group.sizes;
    }
    return [...base].sort((a, b) =>
      toMl(a.unit_volume) - toMl(b.unit_volume) || a.wholesaler.localeCompare(b.wholesaler));
  }, [group.flat, repRow, multiDist, multiData, fullSizes, group.sizes]);
  const optionCount = sizes.length;

  return (
    <div className={`prod-card${expanded ? ' is-expanded' : ''}`} ref={cardRef}>
      <div className="prod-card-head" onClick={() => setExpanded(e => !e)}
        onPointerEnter={warmUp} onFocus={warmUp}>
        <div className="prod-card-fav" onClick={e => e.stopPropagation()}>
          <FavoriteButton productName={group.productName} wholesaler={group.wholesaler}
            upc={first?.upc} unitVolume={first?.unit_volume} />
        </div>
        <Link to={detailUrl(group.wholesaler, group.productName, first?.upc)}
          className="prod-card-thumb-link" onClick={e => e.stopPropagation()}>
          <ProductThumb src={group.imageUrl} alt={group.productName} size={56} expandable />
        </Link>
        <div className="prod-card-meta">
          {/* CELR family header — NOT a link: it's a family (many distributors/
              sizes), not one SKU. Drill in via a distributor product name below. */}
          <span className="prod-card-name prod-card-name--plain"
            title={stripHeaderVintage(group.displayName, group.productType)}>
            {stripHeaderVintage(group.displayName, group.productType)}
          </span>
          <div className="prod-card-type">
            {[group.productType, group.brand].filter(Boolean).join(' · ')}
            {group.celrNumber && (
              <span className="prod-card-cpn" title="CELR Product Number: one identity for this product across all sizes, vintages and distributors">
                {group.celrNumber}
              </span>
            )}
          </div>
          <div className="prod-card-dist"
            title={multiDist ? distSlugs.map(distributorName).join(', ') : undefined}>
            <Store size={12} className="prod-card-dist-icon" />
            {multiDist ? `Sold by ${distSlugs.length} distributors` : distributorName(group.wholesaler)}
            {group.flat && (group.memberCount ?? 1) > 1 && (
              <span className="prod-card-collapsed"
                title={`${group.memberCount} barcodes at this size/distributor (e.g. vintages or a closeout) — showing the best price`}>
                · best of {group.memberCount}
              </span>
            )}
          </div>
          <div className="prod-card-stickers" onClick={e => e.stopPropagation()}>
            <BetterMonthSticker s={rep} repRow={repRow} />
            <IntroSticker ym={group.sizes.reduce<string | null>(
              (mx, s) => (s.introduced_edition && (!mx || s.introduced_edition > mx)
                ? s.introduced_edition : mx), null)} />
            <DealTimingSticker deals={repRow?.deal_windows ?? []} gaps={repRow?.rip_gaps}
              everyDay={everyDayFromTiers(repRow?.tiers, repRow?.frontline_case_price)} />
            {/* Best-price-across-distributors nudge for THIS card's SKU; hover
                shows the full per-distributor QD + RIP ladder. */}
            <DistCompareChip sizes={crossDistRows} selfWholesaler={group.wholesaler} />
          </div>
          {/* Sparkline sits next to the name so its hover tooltip opens over the
              left/content area, not off the right edge. */}
          {rep && (
            <span className="prod-card-spark" onClick={e => e.stopPropagation()}>
              <PriceSparklines wholesaler={rep.wholesaler} productName={rep.product_name}
                upc={rep.upc} unitVolume={rep.unit_volume} unitQty={rep.unit_qty} vintage={rep.vintage}
                months={repMonths.length ? repMonths : undefined} noSelfFetch={!!rep.upc} />
            </span>
          )}
        </div>
        {/* Hidden while expanded — the size rows below show the same ladder,
            so keeping it here duplicated every deal on screen. */}
        {showDeals && !expanded && repMonths.length > 0 && (
          <div className="prod-card-deals">
            <DealLadder months={repMonths} pack={repPack}
              unitVolume={rep?.unit_volume} unitType={rep?.unit_type} />
          </div>
        )}
        <div className="prod-card-right">
          <BestQdSticker s={repRow ?? range?.lo ?? first} />
          {range && (
            <>
              <CardPriceLine s={range.lo} repRow={repRow} />
              {range.hi !== range.lo && <CardPriceLine s={range.hi} repRow={repRow} />}
            </>
          )}
          <div className="prod-card-options">
            {anyDisc && <span className="prod-card-deal prod-deal-qd">QD</span>}
            {anyRip && <span className="prod-card-deal prod-deal-rip">RIP</span>}
            {comboUrl && (
              <Link to={comboUrl} className="prod-combo-sticker" onClick={e => e.stopPropagation()}
                title="Part of a combo bundle — view the combo">🎁 Combo</Link>
            )}
            <span className="prod-card-sizes">{optionCount} size{optionCount === 1 ? '' : 's'}</span>
          </div>
        </div>
        <ChevronDown size={20} className={`prod-card-chev${expanded ? ' is-open' : ''}`} />
      </div>
      {expanded && (
        <div className="prod-card-body">
          {isFetching && fullSizes.length === 0 && <div className="prod-size-loading">Loading all sizes…</div>}
          {group.flat ? (
            // Flat mode: one card == one distributor+size; no nesting needed.
            sizes.map((size, i) => (
              <SizeRow key={`${size.product_name}|${size.upc ?? ''}|${size.unit_volume ?? ''}|${i}`}
                size={size} cart={cart} updateQty={updateQty} primaryName={group.displayName} showDeals={showDeals} />
            ))
          ) : (
            // Grouped (CELR family) card: Distributor -> Distributor Product Name -> sizes.
            nestByDistributor(sizes, group.wholesaler).map((d, di) => (
              <div className={`prod-dist-group${di % 2 === 1 ? ' prod-dist-group--alt' : ''}`} key={d.wholesaler}>
                <div className="prod-dist-head">
                  <Store size={13} /> <span className="prod-dist-name">{distributorName(d.wholesaler)}</span>
                  <span className="prod-dist-count">
                    {d.products.reduce((n, p) => n + p.sizes.length, 0)} size{d.products.reduce((n, p) => n + p.sizes.length, 0) === 1 ? '' : 's'}
                  </span>
                </div>
                {d.products.map((p, pi) => (
                  <div className="prod-distprod-group" key={`${p.name}|${pi}`}>
                    {/* Distributor's own product name — shown when it differs from
                        the CELR family header (same UPC, different catalogue name). */}
                    {p.name && p.name.trim().toUpperCase() !== (group.displayName ?? '').trim().toUpperCase() && (
                      <div className="prod-distprod-head">{p.name}</div>
                    )}
                    {p.sizes.map((size, i) => (
                      <SizeRow key={`${size.upc ?? ''}|${size.unit_volume ?? ''}|${i}`}
                        size={size} cart={cart} updateQty={updateQty} primaryName={p.name}
                        showDeals={showDeals} hideDist />
                    ))}
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

interface Props {
  items: Product[];
  cart: CartState;
  updateQty: (key: string, field: 'cases' | 'units', value: number) => void;
  showDeals?: boolean;
  // "Group products" toggle. Default (false) shows one row per distributor +
  // size (UPC variants collapsed to the best price). True restores the
  // cross-distributor family cards.
  grouped?: boolean;
  // Start every card expanded (used on an active product search).
  expandAll?: boolean;
}

export default function ProductsGrid({ items, cart, updateQty, showDeals = true, grouped = false, expandAll = false }: Props) {
  const groups = useMemo(() => groupByProduct(items, grouped), [items, grouped]);

  if (groups.length === 0) {
    return <div className="prod-empty">No products match the current search and filters.</div>;
  }

  return (
    <div className="prod-grid">
      {groups.map(g => (
        <Fragment key={g.key}>
          <ProductCard group={g} cart={cart} updateQty={updateQty} showDeals={showDeals} defaultExpanded={expandAll} />
        </Fragment>
      ))}
    </div>
  );
}

// Exposed so the page header can show "Showing N …" matching the cards.
export function countProductGroups(items: Product[], grouped = false): number {
  const seen = new Set<string>();
  for (const it of items) {
    const fam = (it.product_group && it.product_group.trim()) ? it.product_group : it.product_name;
    seen.add(grouped ? fam : `${it.wholesaler}|${fam}|${it.unit_volume ?? ''}|${normPack(it.unit_qty)}`);
  }
  return seen.size;
}
