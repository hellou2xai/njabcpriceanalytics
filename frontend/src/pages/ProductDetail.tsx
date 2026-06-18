import { useEffect, useMemo, useState, useCallback } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, Store, ChevronRight } from 'lucide-react';
import { catalog } from '../lib/api';
import { AI_EXPLAINERS_ENABLED } from '../lib/flags';
import ProductThumb from '../components/ProductThumb';
import FavoriteButton from '../components/FavoriteButton';
import AddToCartButton from '../components/AddToCartButton';
import AddToListButton from '../components/AddToListButton';
import { QtyStepper, loadCart, saveCart, type CartState } from '../components/CatalogTable';
import PriceSparklines from '../components/PriceSparklines';
import QuantityPriceCurve from '../components/QuantityPriceCurve';
import DealTimingSticker, { everyDayFromTiers, type DatedDeal } from '../components/DealTimingSticker';
import TierBadge from '../components/TierBadge';
import { buildMonths } from '../lib/promotionsSparkline';
import DealLadder from '../components/DealLadder';
import { currentMonth } from '../components/MonthEffectiveSparkline';
import { windowBadge, fmtDateRange } from '../lib/dealDates';

// Per-tier partial-month flag for the QD / Mix-RIP stacks on the detail page —
// a deal valid only on certain dates (not the full month). Full-month tiers
// render nothing.
function TierWin({ t }: { t: CatalogTier }) {
  const wb = windowBadge(t);
  if (!t.is_time_sensitive && !wb) return null;
  const range = fmtDateRange(t.from_date, t.to_date);
  // Partial deals always render in the prominent amber 'partial' style (red when
  // expiring), never the subtle blue 'upcoming' — so a partial QD can't be missed.
  const cls = t.is_time_sensitive ? (wb?.urgent ? 'win-partial urgent' : 'win-partial') : (wb?.cls ?? 'win-partial');
  return (
    <span className={`win-badge ${cls}`}
      title={`Partial-month — only valid ${range || 'on limited dates'}. Applies only on these dates.`}>
      {t.is_time_sensitive ? `⏱ Partial · ${range || 'limited'}` : wb?.label}{t.is_time_sensitive && wb ? ` · ${wb.label}` : ''}
    </span>
  );
}
import { useProductSizes, bottlesPerCase, sizeToMl, stripHeaderVintage } from '../lib/productSizes';
import DistCompareChip from '../components/DistCompareChip';
import { useComboLink } from '../lib/comboLink';
import { distributorName, abgSku, skuLabel, containerTitle, containerNoun, packLabel, packPhrase, priceUnit, perUnitNoun } from '../lib/distributors';
import type { Product, CatalogTier } from '../lib/api';

// ---- size / oz helpers ----
// One canonical size parser (handles bare "LITER", "1.75L", "750ML", …).
const toMl = sizeToMl;
function ozPerBottle(uv?: string | null): number | null {
  const ml = toMl(uv);
  return ml === Number.MAX_SAFE_INTEGER ? null : ml / 29.5735;
}
function oz(v: number | null | undefined): string {
  return v == null ? '' : ` ($${v.toFixed(2)}/oz)`;
}
// Bottle vs case unit. Canonical rule (rip_utils.is_bottle_unit): ANY unit
// starting with 'b' is a bottle — Fedway abbreviates bottles as a single "B",
// which /btl|bottle/ missed, so a "3 bottles" RIP tier mislabeled as "3 cases".
const isBottleUnit = (unit?: string | null) => /^\s*b/i.test(String(unit ?? ''));
const unitWord = (qty: number, unit: string) =>
  isBottleUnit(unit) ? (qty === 1 ? 'bottle' : 'bottles') : (qty === 1 ? 'case' : 'cases');

// Build the /product deep link for a related product card.
function detailUrl(p: { wholesaler: string; product_name: string; upc?: string | null }): string {
  const q = new URLSearchParams({ w: p.wholesaler, n: p.product_name });
  if (p.upc) q.set('u', String(p.upc));
  return `/product?${q.toString()}`;
}

// Price after the 1-CASE quantity discount (the realistic price for buying a
// single case to join a Mix-RIP) — NOT the deepest RIP. Reachable-at-1-case
// discount tiers only; falls back to frontline when there's no 1-case QD.
function oneCaseQdPrice(p: Product, pack: number | null): number | null {
  const front = p.frontline_case_price ?? null;
  const disc = (p.discount_tiers ?? p.tiers ?? []).filter(
    t => t.source !== 'rip' && t.price_after != null);
  const reachable = disc.filter(t => {
    const isBtl = /^b/i.test(t.unit || '');
    return isBtl ? (pack ? t.qty <= pack : false) : t.qty <= 1;
  });
  if (reachable.length) return Math.min(...reachable.map(t => t.price_after as number));
  return front;
}

// ---- a related-product mini card (case-mix RIP siblings / more from brand) ----
function MiniCard({ p, actions = false }: { p: Product; actions?: boolean }) {
  const [cases, setCases] = useState(1);   // quick-add case qty (hover actions)
  const sku = abgSku(p.wholesaler, p.abg_sku) ? `${skuLabel(p.wholesaler)} ${p.abg_sku}` : null;
  const pack = bottlesPerCase(p.product_name, p.unit_qty);
  const eff = oneCaseQdPrice(p, pack);
  const perBtl = eff != null && pack ? eff / pack : null;
  const hasVintage = p.vintage != null && !['', '0', 'nv'].includes(String(p.vintage).trim().toLowerCase());
  return (
    <Link to={detailUrl(p)} className="pd-mini">
      <ProductThumb src={p.image_url} alt={p.product_name} size={72} />
      <div className="pd-mini-name">{p.product_name}</div>
      {/* Size / volume + pack — every product card must say what size it is, so
          buyers can tell the 750mL from the 1.75L at a glance. */}
      <div className="pd-mini-size">
        {p.unit_volume || '-'}{packLabel(p.unit_volume, pack, p.unit_type) ? ` · ${packLabel(p.unit_volume, pack, p.unit_type)}` : ''}{hasVintage ? ` · ${p.vintage}` : ''}
      </div>
      <div className="pd-mini-dist"><Store size={11} /> {distributorName(p.wholesaler)}</div>
      {/* UPC + vendor SKU — shown on every product display, per spec. */}
      {(sku || p.upc) && (
        <div className="pd-mini-ids">
          {sku && <span>SKU: {sku}</span>}
          {p.upc && <span>UPC: {p.upc}</span>}
        </div>
      )}
      <div className="pd-mini-price" title="Price after the 1-case quantity discount">
        {eff != null ? (
          <>
            <span>${eff.toFixed(2)}/{priceUnit(p.unit_volume, p.unit_type)}</span>
            {perBtl != null && <span className="pd-mini-btl">${perBtl.toFixed(2)}/{perUnitNoun(p.unit_volume, p.unit_type)}</span>}
          </>
        ) : <span className="pd-mini-noprice">Price not available</span>}
      </div>
      <PriceSparklines wholesaler={p.wholesaler} productName={p.product_name}
        upc={p.upc} unitVolume={p.unit_volume} unitQty={p.unit_qty} vintage={p.vintage} />
      {/* Quick add — revealed on hover so it never crowds the card or the
          sparkline. onClickCapture preventDefault cancels the card's <Link>
          navigation while the buttons (which stopPropagation) still fire. */}
      {actions && (
        <div className="pd-mini-actions" onClickCapture={e => e.preventDefault()}>
          <QtyStepper label="Cases" value={cases} onChange={setCases} />
          <div className="pd-mini-btns">
            <AddToCartButton productName={p.product_name} wholesaler={p.wholesaler}
              upc={p.upc ?? undefined} unitVolume={p.unit_volume ?? undefined} qtyCases={cases} />
            <AddToListButton productName={p.product_name} wholesaler={p.wholesaler}
              upc={p.upc ?? undefined} unitVolume={p.unit_volume ?? undefined} />
          </div>
        </div>
      )}
    </Link>
  );
}

// ---- "Other products in this Case Mix RIP" — one section PER program ----
// exclude_name limits the exclusion to THIS listing, so sibling SKUs and
// other vintages sharing this product's barcode still show as members.
function RipMembersSection({ wholesaler, code, upc, name, edition }: {
  wholesaler: string;
  code: string;
  upc?: string | null;
  name?: string | null;
  edition?: string | null;
}) {
  const { data } = useQuery({
    enabled: !!code && !!wholesaler,
    // RIP codes recycle monthly — scope to this product's edition.
    queryKey: ['pd-rip-siblings', wholesaler, code, upc, name, edition ?? ''],
    queryFn: () => catalog.ripSiblings(wholesaler, code, {
      edition: edition ?? undefined,
      exclude_upc: upc ?? undefined, exclude_name: name || undefined,
    }),
  });
  const items = (data?.items ?? []) as Product[];
  if (items.length === 0) return null;
  return (
    <section className="pd-section">
      <h2>Other products in this Case Mix RIP <span className="pd-rip-tag">RIP {code}</span></h2>
      <p className="pd-section-sub">Buy these together to qualify for the RIP.</p>
      <div className="pd-related-grid">
        {items.map((p, i) => <MiniCard key={`${p.upc}|${i}`} p={p} actions />)}
      </div>
    </section>
  );
}

// ---- one size section in the right rail ----
function SizeSection({ size, view, cart, updateQty, primaryName, alt }: {
  size: Product;
  view: 'deals' | 'bottles';
  cart: CartState;
  updateQty: (key: string, field: 'cases' | 'units', value: number) => void;
  primaryName?: string;
  // Zebra striping so individual sizes are easy to tell apart at a glance.
  alt?: boolean;
}) {
  const [dealsOpen, setDealsOpen] = useState(true);
  const cartKey = `${size.product_name}|${size.wholesaler}|${size.upc ?? ''}|${size.unit_volume ?? ''}`;
  const qty = cart[cartKey] ?? { cases: 0, units: 0 };
  // True bottles-per-case (corrects slash-multipacks where unit_qty is trays).
  const pack = bottlesPerCase(size.product_name, size.unit_qty);
  const ozB = ozPerBottle(size.unit_volume);
  const tiers: CatalogTier[] = size.tiers ?? [];
  const discTiers = tiers.filter(t => t.source === 'discount').sort((a, b) => a.qty - b.qty);
  // ascending by RIP rebate amount (qty mixes cases + bottles, so it sorted oddly)
  const ripTiers = tiers.filter(t => t.source === 'rip')
    .sort((a, b) => (a.amount ?? 0) - (b.amount ?? 0));
  const sku = abgSku(size.wholesaler, size.abg_sku) ? `${skuLabel(size.wholesaler)} ${size.abg_sku}` : size.upc;
  const hasVintage = size.vintage != null && !['', '0', 'nv'].includes(String(size.vintage).trim().toLowerCase());
  const comboLink = useComboLink();
  const comboUrl = comboLink(size.wholesaler, size.upc);
  // Per-bottle from the corrected pack (so a 50mL 120-pack reads $2.99, not $35.90).
  const btl = (caseVal: number | null | undefined) => (caseVal != null && pack ? caseVal / pack : null);
  // Consistent buy-unit: when the item is 1 bottle/case, "Buy 1 bottle" and
  // "Buy 1 case" are the SAME thing, so the QD (cases) and RIP (bottles) source
  // units mustn't read differently — show everything as the ordering unit (case).
  const buyUnit = (qty: number, unit: string) =>
    (pack === 1 ? (qty === 1 ? 'case' : 'cases') : unitWord(qty, unit));

  const headlineCase = size.frontline_case_price;
  const headlineBtl = btl(headlineCase) ?? size.frontline_unit_price;
  const caseOz = ozB && pack ? headlineCase / (ozB * pack) : null;
  const btlOz = ozB ? headlineBtl / ozB : null;
  const showDeals = view === 'deals';

  return (
    <div className={`pd-size${alt ? ' pd-size--alt' : ''}`}>
      <div className="pd-size-head">
        <div>
          <div className="pd-size-title">
            {hasVintage && <span className="pd-size-vintage-lead">{size.vintage}</span>}
            {size.unit_volume || '-'} {containerTitle(size.unit_volume, size.unit_type)}
          </div>
          {/* Variant / edition name (e.g. "...250TH", a Festive pack) so the
              buyer can tell same-size SKUs apart and order the right one. */}
          {primaryName && size.product_name && size.product_name !== primaryName && (
            <div className="pd-size-variant">{size.product_name}</div>
          )}
          <div className="pd-size-dist"><Store size={11} /> {distributorName(size.wholesaler)}</div>
          <div className="pd-size-pack">{packPhrase(pack, size.unit_volume, size.unit_type)}</div>
          <div className="pd-size-ids">
            {sku && <span>SKU: {sku}</span>}
            {size.upc && <span className="pd-size-upc">UPC: {size.upc}</span>}
            {hasVintage && <span className="tag tag-blue">Vintage {size.vintage}</span>}
            {comboUrl && (
              <Link to={comboUrl} className="prod-combo-sticker"
                title="Part of a combo bundle — view the combo">🎁 Combo</Link>
            )}
          </div>
        </div>
      </div>

      <div className="pd-size-cols">
      <div className="pd-size-main">
      {showDeals && discTiers.length > 0 && (
        <div className="pd-deals">
          <button type="button" className="pd-deals-toggle" onClick={() => setDealsOpen(o => !o)}>
            {discTiers.length} Deal{discTiers.length === 1 ? '' : 's'}
            <ChevronDown size={13} className={`pd-deals-chev${dealsOpen ? ' is-open' : ''}`} />
          </button>
          {dealsOpen && (
            <div className="pd-deals-body">
              {/* These are quantity-DISCOUNT tiers (QD), not just "quantity". */}
              <div className="pd-deals-label">
                <TierBadge kind="qd" /> Quantity Discount
              </div>
              {discTiers.map((t, i) => {
                const tb = btl(t.price_after) ?? t.btl_price_after;
                const tBtlOz = ozB && tb != null ? tb / ozB : null;
                return (
                  <div key={i} className="pd-deal-line">
                    Buy {t.qty} {buyUnit(t.qty, t.unit)} – <strong>${(t.price_after ?? 0).toFixed(2)}/case</strong>
                    {t.save_per_case > 0 && <span className="pd-deal-off"> (${t.save_per_case.toFixed(2)} off)</span>}
                    {tb != null && <> - ${tb.toFixed(2)}/{perUnitNoun(size.unit_volume, size.unit_type)}{size.unit_volume ? ` (${size.unit_volume})` : ''}</>}
                    {tBtlOz != null && <span className="pd-oz">{oz(tBtlOz)}</span>}
                    {' '}<TierWin t={t} />
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      <div className="pd-size-price">
        <div className="pd-price-line">
          <strong>${headlineBtl.toFixed(2)}/{perUnitNoun(size.unit_volume, size.unit_type)}</strong><span className="pd-oz">{oz(btlOz)}</span>
        </div>
        <div className="pd-price-line">
          <strong>${headlineCase.toFixed(2)}/case</strong><span className="pd-oz">{oz(caseOz)}</span>
        </div>
        {/* Two price sparklines (1-case-discount + best-RIP) with a hover
            tooltip exposing the 3-month schedule — replaces the old
            "See price schedule" link. */}
        <span className="pd-schedule-spark">
          <PriceSparklines wholesaler={size.wholesaler} productName={size.product_name}
            upc={size.upc} unitVolume={size.unit_volume} unitQty={size.unit_qty} vintage={size.vintage}
            months={buildMonths(size)} />
        </span>
      </div>

      {/* RIP tiers, ONE block PER RIP program. A UPC can sit under several
          rebates (a brand-mix RIP and a standalone product RIP) and they do
          not stack — the buyer picks the program that pays best for how much
          they buy, so each program shows its own code, scope and levels,
          mirroring the distributor-portal "Available RIPs" layout. */}
      {ripTiers.length > 0 && (() => {
        const groups: { code: string | null; desc: string | null; tiers: typeof ripTiers }[] = [];
        for (const t of ripTiers) {
          const code = t.code ?? size.rip_code ?? null;
          const g = groups.find(x => x.code === code);
          if (g) { g.tiers.push(t); if (!g.desc && t.description) g.desc = t.description; }
          else groups.push({ code, desc: t.description ?? null, tiers: [t] });
        }
        return (
          <>
            {groups.length > 1 && (
              <div className="pd-mixrip-pick">
                Qualifies under {groups.length} RIP programs. They don't stack — pick the one that fits your buy.
              </div>
            )}
            {groups.map((g, gi) => (
              <div key={`rip${gi}`} className="pd-mixrip">
                <div className="pd-mixrip-head">{groups.length > 1 ? 'RIP' : 'Mix RIP · RIP'}{g.code ? ` ${g.code}` : ''}</div>
                {g.desc && <div className="pd-mixrip-desc">{g.desc}</div>}
                {g.tiers.map((t, i) => (
                  <div key={i} className="pd-mixrip-line">
                    Buy {t.qty} {buyUnit(t.qty, t.unit)} – <strong>${t.amount.toFixed(2)} RIP</strong>
                    {' '}<TierWin t={t} />
                    {t.price_after != null && (() => {
                      const mb = btl(t.price_after) ?? t.btl_price_after;
                      return (
                        <span className="pd-mixrip-after">
                          {' → '}${t.price_after.toFixed(2)}/case
                          {mb != null && <> · ${mb.toFixed(2)}/{perUnitNoun(size.unit_volume, size.unit_type)}{size.unit_volume ? ` (${size.unit_volume})` : ''}</>}
                        </span>
                      );
                    })()}
                  </div>
                ))}
              </div>
            ))}
          </>
        );
      })()}
      </div>

      {/* Volume-pricing curve: per-case + per-bottle price vs case quantity,
          from the SAME canonical tiers (this UPC / vintage) as the ladders. */}
      <QuantityPriceCurve frontline={headlineCase} tiers={tiers} pack={pack}
        sizeLabel={`${size.unit_volume ?? ''}${hasVintage ? ` · ${size.vintage}` : ''}`} />
      </div>

      <div className="pd-size-order">
        <div className="pd-steppers">
          <QtyStepper label={`${containerNoun(size.unit_volume, size.unit_type).replace(/^./, c => c.toUpperCase())}s`} value={qty.units} onChange={v => updateQty(cartKey, 'units', v)} />
          <QtyStepper label="Cases" value={qty.cases} onChange={v => updateQty(cartKey, 'cases', v)} />
        </div>
        {/* Add-to-list sits directly under add-to-cart: the two "save this"
            actions live together instead of list hiding up in the header. */}
        <div className="pd-order-actions">
          <AddToCartButton productName={size.product_name} wholesaler={size.wholesaler}
            upc={size.upc} unitVolume={size.unit_volume} qtyCases={qty.cases} qtyUnits={qty.units} />
          <AddToListButton productName={size.product_name} wholesaler={size.wholesaler}
            upc={size.upc} unitVolume={size.unit_volume} />
        </div>
      </div>
    </div>
  );
}

export default function ProductDetail() {
  const [params] = useSearchParams();
  const wholesaler = params.get('w') ?? '';
  const name = params.get('n') ?? '';
  const upc = params.get('u') ?? undefined;

  const [cart, setCartState] = useState<CartState>(loadCart);
  const [view, setView] = useState<'deals' | 'bottles'>('deals');

  // Scroll to top whenever we navigate to a different product (related cards
  // reuse this same route with new query params).
  useEffect(() => { window.scrollTo({ top: 0 }); }, [wholesaler, name]);

  const setCart = useCallback((upd: CartState | ((p: CartState) => CartState)) => {
    setCartState(prev => {
      const next = typeof upd === 'function' ? upd(prev) : upd;
      saveCart(next);
      return next;
    });
  }, []);
  const updateQty = useCallback((key: string, field: 'cases' | 'units', value: number) => {
    setCart(prev => ({ ...prev, [key]: { cases: prev[key]?.cases ?? 0, units: prev[key]?.units ?? 0, [field]: value } }));
  }, [setCart]);

  // Enrichment + producer + ai blurb (one representative SKU).
  const { data: detail } = useQuery({
    enabled: !!wholesaler && !!name,
    queryKey: ['pd-detail', wholesaler, name, upc],
    queryFn: () => catalog.product(wholesaler, name, { upc }),
  });

  // Every size of this product — via the shared "products by size" tool
  // (spirits: name-core variant grouping; wine: grouped by name + vintage).
  // Keep the product's sizes together AND, when the same product is carried by
  // several distributors, show those too (allDistributors). Listed strictly by
  // physical size (LITER = 1 L = 1000 mL, so it follows 750 mL) and then by
  // distributor — the hook already returns this order.
  const { sizes, isLoading, isError, refetch } = useProductSizes(wholesaler, name, upc, true, true);
  // This is THIS distributor's product page, so within each physical size show
  // the page's own wholesaler FIRST (its prices/deals are what the buyer came
  // for), then other distributors, then newest vintage. The hook returns
  // size-then-alphabetical, which surfaced a sibling distributor (e.g. Allied)
  // above the page's own (Fedway) for a shared barcode.
  const orderedSizes = useMemo(() => {
    const vnum = (v: unknown) => { const n = parseInt(String(v ?? ''), 10); return Number.isFinite(n) ? n : -1; };
    return [...sizes].sort((a, b) =>
      sizeToMl(a.unit_volume) - sizeToMl(b.unit_volume)
      || (a.wholesaler === wholesaler ? 0 : 1) - (b.wholesaler === wholesaler ? 0 : 1)
      || a.wholesaler.localeCompare(b.wholesaler)
      || vnum(b.vintage) - vnum(a.vintage));
  }, [sizes, wholesaler]);

  const enrichment = detail?.enrichment;
  const product = detail?.product;
  const brand = enrichment?.brand ?? product?.brand ?? sizes[0]?.brand ?? null;
  // Pick the case-mix RIP code shared by the MOST sizes (the product's primary
  // rebate), not just the first size's — a single 100mL pack often carries a
  // different one-off code than the rest of the line.
  const ripCode = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of sizes) {
      const c = s.rip_group_code ?? s.rip_code;
      if (c && !['None', 'nan', '0', ''].includes(String(c))) {
        const k = String(c);
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
    }
    let best: string | null = null, n = 0;
    for (const [k, v] of counts) if (v > n) { best = k; n = v; }
    return best;
  }, [sizes]);
  // EVERY RIP program this product sits under (the CPL/group code plus each
  // per-tier code from the RIP sheet). A UPC can qualify under a brand-mix
  // RIP and a standalone RIP at once — one members section renders per
  // program so the buyer can weigh them against each other.
  const ripCodes = useMemo(() => {
    const out: string[] = [];
    const add = (c?: string | null) => {
      const k = String(c ?? '').trim();
      if (k && !['None', 'nan', '0'].includes(k) && !out.includes(k)) out.push(k);
    };
    add(ripCode);
    for (const s of sizes) for (const t of (s.tiers ?? [])) {
      if (t.source === 'rip') add(t.code);
    }
    return out;
  }, [sizes, ripCode]);

  // Edition the page is showing (the page wholesaler's size, else the first),
  // so the RIP members modal is scoped to this month — codes recycle monthly.
  const ripEdition = useMemo(
    () => (sizes.find(s => s.wholesaler === wholesaler) ?? sizes[0])?.edition ?? undefined,
    [sizes, wholesaler],
  );
  const anyDisc = sizes.some(s => s.has_discount);   // quantity discount
  const anyRip = sizes.some(s => s.has_rip);          // RIP
  // Half-case RIP: any size whose RIP tier counts a physical case as <1 toward
  // the qualifying quantity (rebate filed on a 375ML / 6-pack fraction-pack).
  const anyHalfCase = sizes.some(s => (s.tiers ?? []).some(
    t => t.source === 'rip' && t.case_credit != null && t.case_credit < 1));
  // Header deal-timing sticker: the product's dated deal windows + no-deal gaps
  // across all sizes (deduped).
  const headerDeals = useMemo(() => {
    const seen = new Set<string>(); const out: NonNullable<Product['deal_windows']> = [];
    for (const s of sizes) for (const d of (s.deal_windows ?? [])) {
      const k = `${d.kind}|${d.from}|${d.to}`; if (!seen.has(k)) { seen.add(k); out.push(d); }
    }
    return out;
  }, [sizes]);
  const headerGaps = useMemo(() => {
    const seen = new Set<string>(); const out: { from: string; to: string; days: number }[] = [];
    for (const s of sizes) for (const g of (s.rip_gaps ?? [])) {
      const k = `${g.from}|${g.to}`; if (!seen.has(k)) { seen.add(k); out.push(g); }
    }
    return out;
  }, [sizes]);
  // Best full-month (evergreen) deal across sizes — shown in the popover so the
  // buyer sees what covers the days between dated windows.
  const headerEveryDay = useMemo<DatedDeal | null>(() => {
    let best: DatedDeal | null = null;
    for (const s of sizes) {
      const e = everyDayFromTiers(s.tiers, s.frontline_case_price);
      if (e && (!best || (e.save ?? 0) > (best.save ?? 0))) best = e;
    }
    return best;
  }, [sizes]);
  const comboLink = useComboLink();
  const anyComboUrl = sizes.map(s => comboLink(s.wholesaler, s.upc)).find(Boolean) ?? null;

  // Members sections render per RIP program via RipMembersSection below.

  // More from the same manufacturer (brand).
  const { data: brandData } = useQuery({
    enabled: !!brand,
    queryKey: ['pd-brand', wholesaler, brand],
    // include_tiers so each tile can show the price after the 1-case QD (same as
    // the Mix-RIP tiles); 24 rows so the slower tier build is fine here.
    queryFn: () => catalog.search({ q: brand ?? '', brands: brand ?? undefined, limit: 24, sort: 'product_name', order: 'asc', include_tiers: true }),
  });
  const brandProducts = useMemo(() => {
    const rows = (brandData?.items ?? []) as Product[];
    const seen = new Set<string>();
    const out: Product[] = [];
    for (const r of rows) {
      if (r.product_name === name) continue;
      const k = `${r.wholesaler}|${r.product_name}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(r);
    }
    return out.slice(0, 12);
  }, [brandData, name]);

  // Breadcrumb from the enrichment category path, else the product type.
  const crumbs = useMemo(() => {
    const path = enrichment?.category_path?.filter(Boolean) ?? [];
    if (path.length) return path;
    return product?.product_type ? [product.product_type] : [];
  }, [enrichment, product]);

  // Enrichment specs, MINUS any size/pack keys — size is shown from the catalog
  // data below so it appears for every product, enriched or not (and never twice).
  const _isSizeKey = (k: string) => /^(package\s*)?size$|bottles?\s*per\s*case|unit\s*volume|^pack(\s*size)?$/i.test(k.trim());
  // Vintage/year are authoritative from our own catalog rows (per edition).
  // Go-UPC's enrichment vintage is often a stale/wrong year for a reused wine
  // barcode (e.g. it returns 2016 for a 2022 wine), so never show the
  // enrichment's vintage — the real one is rendered from the CPL rows below.
  const _isVintageKey = (k: string) => /^(vintage|year)$/i.test(k.trim());
  const specs = enrichment?.specs
    ? Object.entries(enrichment.specs).filter(([k, v]) => v != null && String(v) !== '' && !_isSizeKey(k) && !_isVintageKey(k))
    : [];
  // Package size(s) straight from the CPL — always present. One size shows its
  // pack; multiple sizes list them so the header reflects the whole product.
  const _sizeVals = Array.from(new Set((sizes ?? []).map(s => s.unit_volume).filter(Boolean) as string[]));
  const headerSize = _sizeVals.length === 0 ? null
    : _sizeVals.length === 1
      ? `${_sizeVals[0]}${packLabel(sizes[0]?.unit_volume, bottlesPerCase(name, sizes[0]?.unit_qty), sizes[0]?.unit_type) ? ` · ${packLabel(sizes[0]?.unit_volume, bottlesPerCase(name, sizes[0]?.unit_qty), sizes[0]?.unit_type)}` : ''}`
      : _sizeVals.join(' · ');
  // Vintage(s) straight from the CPL rows (authoritative, per edition). Wines
  // reuse one barcode across years, so show the distinct real vintage(s) here
  // instead of the enrichment's (which can be a wrong/stale year).
  const headerVintage = (() => {
    const vs = Array.from(new Set((sizes ?? [])
      .map(s => String(s.vintage ?? '').trim().replace(/\.0+$/, ''))
      .filter(v => v && !['0', 'nan', 'none', 'null', 'nv'].includes(v.toLowerCase()))));
    return vs.length ? vs.sort().join(' · ') : null;
  })();
  const hasDesc = !!enrichment?.description && enrichment.description !== 'No description found.';
  // UPC + vendor item code for the header, from the seed SKU the attributes
  // describe (its Size/Pack Size are already shown). Per-size codes still live
  // in each size section below.
  const headSku = product ?? sizes[0];
  const headerUpc = headSku?.upc ?? null;
  const headerVendorSku = headSku && abgSku(headSku.wholesaler, headSku.abg_sku)
    ? `${skuLabel(headSku.wholesaler)} ${headSku.abg_sku}` : null;

  // Next-month price box: the seed size's price_3mo carries the early-loaded
  // next edition (future block) when it's loaded. Reuse the SAME DealLadder the
  // Products page renders, in monthMode 'next', so the header shows next month's
  // full QD/RIP table. Hidden when no next edition is loaded.
  const primarySize = useMemo(() => {
    if (!sizes?.length) return null;
    const u = headSku?.upc, v = headSku?.unit_volume;
    return sizes.find(s => s.upc === u && s.unit_volume === v)
      ?? sizes.find(s => s.unit_volume === v) ?? sizes[0];
  }, [sizes, headSku]);
  const nextMonths = useMemo(() => (primarySize ? buildMonths(primarySize) : []), [primarySize]);
  const nextBlock = nextMonths.find(m => m.future) ?? null;
  const curBlock = currentMonth(nextMonths);
  const nextPack = primarySize ? bottlesPerCase(name, primarySize.unit_qty) : null;

  if (!wholesaler || !name) {
    return <div className="page"><p>Product not specified.</p><Link to="/products" className="link-btn">← Back to Products</Link></div>;
  }

  return (
    <div className="page pd-page">
      <nav className="pd-breadcrumb">
        <Link to="/">Home</Link>
        <Link to="/products">Products</Link>
        {crumbs.map((c, i) => (
          <span key={i} className="pd-crumb">{c}</span>
        ))}
      </nav>

      <div className="pd-layout">
        {/* ---- Left column: identity + info + related ---- */}
        <div className="pd-left">
          {anyDisc && <span className="pd-deal-badge pd-deal-qd">QD</span>}
          {anyRip && <span className="pd-deal-badge pd-deal-rip">RIP</span>}
          {anyHalfCase && (
            <span className="pd-deal-badge pd-deal-halfcase"
              title="Half-case RIP: the rebate is filed on a fraction-of-a-case pack (375ML or a 6-pack), so each physical case counts less than one toward the qualifying tier.">
              ½ Case RIP
            </span>
          )}
          {anyComboUrl && (
            <Link to={anyComboUrl} className="pd-deal-badge pd-deal-combo"
              title="Part of a combo bundle — view the combo">🎁 Combo</Link>
          )}
          {(headerDeals.length > 0 || headerGaps.length > 0) && (
            <DealTimingSticker deals={headerDeals} gaps={headerGaps} everyDay={headerEveryDay} />
          )}
          <div className="pd-identity">
            <ProductThumb src={enrichment?.image_url ?? sizes[0]?.image_url} alt={name} size={120} expandable />
            <div className="pd-identity-meta">
              <div className="pd-identity-titlerow">
                <FavoriteButton productName={name} wholesaler={wholesaler} upc={sizes[0]?.upc} unitVolume={sizes[0]?.unit_volume} />
                <h1 className="pd-title">
                  {stripHeaderVintage(name, product?.product_type)}
                  {(primarySize?.unit_volume ?? headSku?.unit_volume) && (
                    <span className="pd-title-size"> ({primarySize?.unit_volume ?? headSku?.unit_volume})</span>
                  )}
                </h1>
                {product?.celr_product_number && (
                  <span className="prod-card-cpn"
                    title="CELR Product Number: one identity for this product across all sizes, vintages and distributors. Searchable in any product search box.">
                    {product.celr_product_number}
                  </span>
                )}
              </div>
              {/* Cheaper-elsewhere chip: shows only when a distributor beats the
                  rest on landed price after ALL QD + RIP (current month). Hover
                  opens the side-by-side per-distributor ladder. */}
              <DistCompareChip sizes={sizes} />
              <dl className="pd-attrs">
                {/* Size ALWAYS shows — sourced from the catalog rows (sizes), not
                    from Go-UPC enrichment, so it appears even when the detail
                    endpoint can't resolve enrichment for this name. */}
                {headerSize && <div><dt>Package size</dt><dd>{headerSize}</dd></div>}
                {headerVintage && <div><dt>Vintage</dt><dd>{headerVintage}</dd></div>}
                {enrichment?.region && <div><dt>Region</dt><dd>{enrichment.region}</dd></div>}
                {specs.map(([k, v]) => (
                  <div key={k}><dt>{k}</dt><dd>{String(v)}</dd></div>
                ))}
                {headerVendorSku && <div><dt>Vendor item code</dt><dd>{headerVendorSku}</dd></div>}
                {headerUpc && <div><dt>UPC</dt><dd>{headerUpc}</dd></div>}
                {brand && <div><dt>Producer</dt><dd>{brand}</dd></div>}
                {brand && (
                  <div><dt></dt><dd><Link to={`/products?brands=${encodeURIComponent(brand)}`} className="pd-link">View all {brand}</Link></dd></div>
                )}
                <div><dt>Sold by</dt><dd><span className="pd-sold-by"><Store size={12} /> {distributorName(wholesaler)}</span></dd></div>
              </dl>
            </div>
          </div>

          {/* Next Month Price — the SAME QD/RIP tier table the Products page
              uses (DealLadder, monthMode='next'), shown only when next month's
              edition is loaded. List + full deal detail for next month. */}
          {nextBlock && (
            <section className="pd-section pd-nextmonth">
              <h2>Next Month Price{primarySize?.unit_volume ? ` · ${primarySize.unit_volume}` : ''}</h2>
              <div className="pd-nextmonth-list">
                List <strong>{nextBlock.frontline != null ? `$${nextBlock.frontline.toFixed(2)}` : '—'}</strong>/{priceUnit(primarySize?.unit_volume, primarySize?.unit_type)}
                {curBlock?.frontline != null && nextBlock.frontline != null && Math.abs(curBlock.frontline - nextBlock.frontline) > 0.005 && (
                  <span className="pd-nextmonth-delta">
                    {' '}({nextBlock.frontline > curBlock.frontline ? '+' : ''}${(nextBlock.frontline - curBlock.frontline).toFixed(2)} vs this month)
                  </span>
                )}
              </div>
              <DealLadder months={nextMonths} pack={nextPack} monthMode="next"
                unitVolume={primarySize?.unit_volume} unitType={primarySize?.unit_type}
                emptyText="No quantity or RIP deals next month" />
            </section>
          )}

          {hasDesc && (
            <section className="pd-section">
              <h2>Product information</h2>
              <p>{enrichment!.description}</p>
            </section>
          )}

          {AI_EXPLAINERS_ENABLED && detail?.ai_blurb && (
            <section className="pd-section pd-ai">
              <h2>What this means</h2>
              <p>{detail.ai_blurb}</p>
            </section>
          )}

          {/* Other products per RIP program — all visible, no "view all".
              One section per program the product qualifies under, so a
              brand-mix RIP and a standalone RIP each show their own members. */}
          {ripCodes.map(code => (
            <RipMembersSection key={code} wholesaler={wholesaler} code={code}
              upc={upc} name={name} edition={ripEdition} />
          ))}

          {/* More from the same manufacturer. */}
          {brandProducts.length > 0 && (
            <section className="pd-section">
              <h2 className="pd-section-head-row">
                <span>More from {brand}</span>
                {brand && <Link to={`/products?brands=${encodeURIComponent(brand)}`} className="pd-viewall">View All <ChevronRight size={14} /></Link>}
              </h2>
              <div className="pd-related-grid">
                {brandProducts.map((p, i) => <MiniCard key={`${p.wholesaler}|${p.product_name}|${i}`} p={p} />)}
              </div>
            </section>
          )}
        </div>

        {/* ---- Right column: per-size deals / bottles ---- */}
        <div className="pd-right">
          <div className="pd-right-tabs">
            <button type="button" className={`pd-tab${view === 'deals' ? ' is-active' : ''}`} onClick={() => setView('deals')}>
              Deals
            </button>
            <button type="button" className={`pd-tab${view === 'bottles' ? ' is-active' : ''}`} onClick={() => setView('bottles')}>
              Bottles
            </button>
          </div>
          <div className="pd-sizes">
            {isError ? (
                <div className="pd-loading">
                  <p>Couldn’t load sizes.</p>
                  <button type="button" className="btn btn-secondary" onClick={() => refetch()}>Retry</button>
                </div>
              )
              : isLoading ? <p className="pd-loading">Loading sizes…</p>
              : sizes.length === 0 ? <p className="pd-loading">No sizes found.</p>
              : orderedSizes.map((s, i) => (
                <SizeSection key={`${s.product_name}|${s.upc}|${s.unit_volume}|${i}`}
                  size={s} view={view} cart={cart} updateQty={updateQty} primaryName={name}
                  alt={i % 2 === 1} />
              ))}
          </div>
        </div>
      </div>
    </div>
  );
}
