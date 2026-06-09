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
import { buildMonths } from '../lib/promotionsSparkline';
import { catalog } from '../lib/api';
import { useProductSizes, bottlesPerCase } from '../lib/productSizes';
import { useComboLink } from '../lib/comboLink';
import { distributorName, abgSku, skuLabel } from '../lib/distributors';
import type { Product } from '../lib/api';

// Full-page product-detail deep link for a product family.
function detailUrl(wholesaler: string, productName: string, upc?: string | null): string {
  const q = new URLSearchParams({ w: wholesaler, n: productName });
  if (upc) q.set('u', String(upc));
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

interface ProductGroup {
  key: string;
  wholesaler: string;
  productName: string;        // a representative SKU name (detail link / expand seed)
  displayName: string;        // clean family title shown on the card
  productType: string;
  brand?: string;
  imageUrl?: string | null;
  sizes: Product[];          // one Product row per size, sorted small -> large
}

// Group by the server-provided product family key so a product's
// differently-named sizes (GLENFID MALT 12Y 12P / 12YR / 6P …) collapse into
// ONE card. The key is DISTRIBUTOR-AGNOSTIC (product_group = brand|enrichment
// core, shared across distributors by UPC), so the same product carried by
// several distributors merges into one card and each distributor's listing
// shows as its own size row — instead of a separate card per distributor.
function groupByProduct(items: Product[]): ProductGroup[] {
  const map = new Map<string, ProductGroup>();
  const order: string[] = [];
  for (const it of items) {
    const fam = (it.product_group && it.product_group.trim()) ? it.product_group : it.product_name;
    const key = fam;
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
        sizes: [],
      };
      map.set(key, g);
      order.push(key);
    }
    if (!g.imageUrl && it.image_url) g.imageUrl = it.image_url;
    g.sizes.push(it);
  }
  for (const g of map.values()) {
    // size ascending, then by distributor so a product's listings group cleanly
    g.sizes.sort((a, b) =>
      toMl(a.unit_volume) - toMl(b.unit_volume) || a.wholesaler.localeCompare(b.wholesaler));
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

// True per-bottle list price, correcting slash-multipacks (unit_qty = trays)
// the same way every other per-bottle surface does.
function bottleUnitPrice(s: Product): number | null {
  const pack = bottlesPerCase(s.product_name, s.unit_qty);
  if (pack && s.frontline_case_price != null) return s.frontline_case_price / pack;
  return s.frontline_unit_price ?? null;
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

function SizeRow({ size, cart, updateQty, primaryName }: {
  size: Product;
  cart: CartState;
  updateQty: (key: string, field: 'cases' | 'units', value: number) => void;
  primaryName?: string;
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
      <Link to={detailUrl(size.wholesaler, size.product_name, size.upc)} className="prod-size-id"
        title="Open full product details">
        <div className="prod-size-name">{size.unit_volume || '—'} Bottle</div>
        {primaryName && size.product_name && size.product_name !== primaryName && (
          <div className="prod-size-variant">{size.product_name}</div>
        )}
        <div className="prod-size-dist"><Store size={11} /> {distributorName(size.wholesaler)}</div>
        <div className="prod-size-pack">{pack ? `${pack} bottles/case` : 'single unit'}</div>
        {sku && <div className="prod-size-sku">SKU: {sku}</div>}
        {size.vintage != null && String(size.vintage) !== '0' && String(size.vintage).trim() !== '' && (
          <span className="tag tag-blue prod-size-vintage">Vintage {size.vintage}</span>
        )}
      </Link>
      <div className="prod-size-price">
        <span className="prod-size-badges">
          {size.has_discount && <span className="prod-deal-badge prod-deal-qd">QD</span>}
          {size.has_rip && <span className="prod-deal-badge prod-deal-rip">RIP</span>}
          <DealTimingSticker deals={size.deal_windows ?? []} gaps={size.rip_gaps}
            everyDay={everyDayFromTiers(size.tiers, size.frontline_case_price)} />
          {comboUrl && (
            <Link to={comboUrl} className="prod-combo-sticker" onClick={e => e.stopPropagation()}
              title="This product is part of a combo bundle — view the combo">🎁 Combo</Link>
          )}
        </span>
        {/* Case price first (the buying unit), then bottle — both on one line. */}
        <div className="prod-size-amounts">
          <span className="prod-size-case">${caseP.toFixed(2)}/case</span>
          <span className="prod-size-btl">${btlPrice.toFixed(2)}/bottle</span>
        </div>
        <PriceSparklines wholesaler={size.wholesaler} productName={size.product_name}
          upc={size.upc} unitVolume={size.unit_volume} unitQty={size.unit_qty} vintage={size.vintage}
          months={months} />
      </div>
      {/* Inline RIP + quantity-discount tiers for the current month — one shared
          DealLadder (tier qty, total $ off, price-after for BOTH case + bottle)
          so the numbers always match the sparkline tooltip. */}
      <div className="prod-size-deals">
        <DealLadder months={months} pack={pack} emptyText="No deals this month" />
      </div>
      <div className="prod-size-order">
        <div className="prod-size-steppers">
          <QtyStepper label="Bottles" value={qty.units} onChange={v => updateQty(cartKey, 'units', v)} />
          <QtyStepper label="Cases" value={qty.cases} onChange={v => updateQty(cartKey, 'cases', v)} />
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

function ProductCard({ group, cart, updateQty }: {
  group: ProductGroup;
  cart: CartState;
  updateQty: (key: string, field: 'cases' | 'units', value: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
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
    enabled: inView && !!rep?.wholesaler && !!rep?.upc,
    staleTime: 5 * 60_000,
    queryKey: ['rep-tiers', rep?.wholesaler, rep?.upc],
    queryFn: () => catalog.search({ wholesaler: rep!.wholesaler, upcs: String(rep!.upc), include_tiers: true, limit: 1 }),
  });
  const repRow = (repTierData?.items?.[0] as Product | undefined) ?? rep;
  const repMonths = repRow ? buildMonths(repRow) : [];

  // The list is paginated by SKU, so a product's sizes can be split across
  // pages. On expand, fetch the FULL size set via the shared "products by size"
  // tool (handles spirits' inconsistent names + wine's vintages) so every size
  // always shows regardless of where the page boundary fell.
  const { sizes: fullSizes, isFetching } = useProductSizes(
    group.wholesaler, group.productName, first?.upc, expanded);
  // Distinct distributors carrying this product (one row per distributor's
  // listing). When >1, keep the search rows (they already span distributors) —
  // the single-distributor "all sizes" fetch would otherwise drop the others.
  const distSlugs = useMemo(() => [...new Set(group.sizes.map(s => s.wholesaler))], [group.sizes]);
  const multiDist = distSlugs.length > 1;
  // For a multi-distributor product, refetch the listings BY UPC across all
  // distributors WITH tiers (the list rows lack tiers/price_3mo, which left the
  // deal ladder empty — "No deals this month" — and the headline at frontline).
  const groupUpcs = useMemo(
    () => [...new Set(group.sizes.map(s => s.upc).filter(Boolean) as string[])], [group.sizes]);
  const { data: multiData } = useQuery({
    enabled: expanded && multiDist && groupUpcs.length > 0,
    staleTime: 5 * 60_000,
    queryKey: ['multidist-sizes', groupUpcs.join(',')],
    queryFn: () => catalog.search({ upcs: groupUpcs.join(','), include_tiers: true, limit: 200, sort: 'product_name', order: 'asc' }),
  });
  const sizes = useMemo(() => {
    const base = multiDist
      ? ((multiData?.items as Product[] | undefined) ?? group.sizes)
      : (fullSizes.length ? fullSizes : group.sizes);
    return [...base].sort((a, b) =>
      toMl(a.unit_volume) - toMl(b.unit_volume) || a.wholesaler.localeCompare(b.wholesaler));
  }, [multiDist, multiData, fullSizes, group.sizes]);
  const optionCount = sizes.length;

  return (
    <div className={`prod-card${expanded ? ' is-expanded' : ''}`} ref={cardRef}>
      <div className="prod-card-head" onClick={() => setExpanded(e => !e)}>
        <div className="prod-card-fav" onClick={e => e.stopPropagation()}>
          <FavoriteButton productName={group.productName} wholesaler={group.wholesaler}
            upc={first?.upc} unitVolume={first?.unit_volume} />
        </div>
        <Link to={detailUrl(group.wholesaler, group.productName, first?.upc)}
          className="prod-card-thumb-link" onClick={e => e.stopPropagation()}>
          <ProductThumb src={group.imageUrl} alt={group.productName} size={56} />
        </Link>
        <div className="prod-card-meta">
          <Link to={detailUrl(group.wholesaler, group.productName, first?.upc)}
            className="prod-card-name" onClick={e => e.stopPropagation()}
            title="Open full product details">
            {group.displayName}
          </Link>
          <div className="prod-card-type">{[group.productType, group.brand].filter(Boolean).join(' · ')}</div>
          <div className="prod-card-dist"
            title={multiDist ? distSlugs.map(distributorName).join(', ') : undefined}>
            <Store size={12} className="prod-card-dist-icon" />
            {multiDist ? `Sold by ${distSlugs.length} distributors` : distributorName(group.wholesaler)}
          </div>
          <div className="prod-card-stickers" onClick={e => e.stopPropagation()}>
            <DealTimingSticker deals={repRow?.deal_windows ?? []} gaps={repRow?.rip_gaps}
              everyDay={everyDayFromTiers(repRow?.tiers, repRow?.frontline_case_price)} />
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
        {repMonths.length > 0 && (
          <div className="prod-card-deals">
            <DealLadder months={repMonths} pack={repPack} />
          </div>
        )}
        <div className="prod-card-right">
          {range && (
            <div className="prod-card-range">
              ${range.loPrice.toFixed(2)} <span className="prod-card-range-size">({range.lo.unit_volume})</span>
              {range.hi !== range.lo && (
                <> – ${range.hiPrice.toFixed(2)} <span className="prod-card-range-size">({range.hi.unit_volume})</span></>
              )}
            </div>
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
          {sizes.map((size, i) => (
            <SizeRow key={`${size.product_name}|${size.upc ?? ''}|${size.unit_volume ?? ''}|${i}`}
              size={size} cart={cart} updateQty={updateQty} primaryName={group.productName} />
          ))}
        </div>
      )}
    </div>
  );
}

interface Props {
  items: Product[];
  cart: CartState;
  updateQty: (key: string, field: 'cases' | 'units', value: number) => void;
}

export default function ProductsGrid({ items, cart, updateQty }: Props) {
  const groups = useMemo(() => groupByProduct(items), [items]);

  if (groups.length === 0) {
    return <div className="prod-empty">No products match the current search and filters.</div>;
  }

  return (
    <div className="prod-grid">
      {groups.map(g => (
        <Fragment key={g.key}>
          <ProductCard group={g} cart={cart} updateQty={updateQty} />
        </Fragment>
      ))}
    </div>
  );
}

// Exposed so the page header can show "Showing N products" matching the cards.
export function countProductGroups(items: Product[]): number {
  const seen = new Set<string>();
  for (const it of items) {
    const fam = (it.product_group && it.product_group.trim()) ? it.product_group : it.product_name;
    seen.add(fam);
  }
  return seen.size;
}
