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
import { Fragment, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, CheckCircle2, Store } from 'lucide-react';
import FavoriteButton from './FavoriteButton';
import ProductThumb from './ProductThumb';
import AddToCartButton from './AddToCartButton';
import AddToListButton from './AddToListButton';
import { QtyStepper, type CartState } from './CatalogTable';
import PriceSparklines from './PriceSparklines';
import { buildMonths } from '../lib/promotionsSparkline';
import { useProductSizes, bottlesPerCase } from '../lib/productSizes';
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
  productName: string;
  productType: string;
  brand?: string;
  imageUrl?: string | null;
  sizes: Product[];          // one Product row per size, sorted small -> large
}

function groupByProduct(items: Product[]): ProductGroup[] {
  const map = new Map<string, ProductGroup>();
  const order: string[] = [];
  for (const it of items) {
    const key = `${it.wholesaler}|${it.product_name}`;
    let g = map.get(key);
    if (!g) {
      g = {
        key,
        wholesaler: it.wholesaler,
        productName: it.product_name,
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
    g.sizes.sort((a, b) => toMl(a.unit_volume) - toMl(b.unit_volume));
  }
  return order.map(k => map.get(k)!);
}

// "$0.83 (50mL) – $19.29 (1.75L)" — the per-bottle price range across the
// product's sizes, each end labelled with its own size. Front-page pricing
// (which deal to surface) is intentionally simple here; it'll be refined later.
function priceRange(sizes: Product[]): { lo: Product; hi: Product } | null {
  const priced = sizes.filter(s => s.frontline_unit_price != null);
  if (priced.length === 0) return null;
  let lo = priced[0], hi = priced[0];
  for (const s of priced) {
    if (s.frontline_unit_price < lo.frontline_unit_price) lo = s;
    if (s.frontline_unit_price > hi.frontline_unit_price) hi = s;
  }
  return { lo, hi };
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
  const hasDeal = size.has_discount || size.has_rip;
  const sku = abgSku(size.wholesaler, size.abg_sku) ? `${skuLabel(size.wholesaler)} ${size.abg_sku}` : size.upc;
  const btlPrice = pack ? size.effective_case_price / pack : size.frontline_unit_price;
  return (
    <div className="prod-size-row">
      <Link to={detailUrl(size.wholesaler, size.product_name, size.upc)} className="prod-size-id"
        title="Open full product details">
        <div className="prod-size-name">{size.unit_volume || '—'} Bottle</div>
        {primaryName && size.product_name && size.product_name !== primaryName && (
          <div className="prod-size-variant">{size.product_name}</div>
        )}
        <div className="prod-size-pack">{pack ? `${pack} bottles/case` : 'single unit'}</div>
        {sku && <div className="prod-size-sku">SKU: {sku}</div>}
        {size.vintage != null && String(size.vintage) !== '0' && String(size.vintage).trim() !== '' && (
          <span className="tag tag-blue prod-size-vintage">Vintage {size.vintage}</span>
        )}
      </Link>
      <div className="prod-size-price">
        {hasDeal && (
          <span className="prod-deal-badge">Deal</span>
        )}
        <div className="prod-size-amounts">
          <span className="prod-size-btl">${btlPrice.toFixed(2)}/bottle</span>
          <span className="prod-size-case">${size.effective_case_price.toFixed(2)}/case</span>
        </div>
        <PriceSparklines wholesaler={size.wholesaler} productName={size.product_name}
          upc={size.upc} unitVolume={size.unit_volume} unitQty={size.unit_qty} vintage={size.vintage}
          months={buildMonths(size)} />
      </div>
      <div className="prod-size-order">
        <span className="prod-instock"><CheckCircle2 size={13} /> Available</span>
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
  const anyDeal = group.sizes.some(s => s.has_discount || s.has_rip);
  const first = group.sizes[0];

  // The list is paginated by SKU, so a product's sizes can be split across
  // pages. On expand, fetch the FULL size set via the shared "products by size"
  // tool (handles spirits' inconsistent names + wine's vintages) so every size
  // always shows regardless of where the page boundary fell.
  const { sizes: fullSizes, isFetching } = useProductSizes(
    group.wholesaler, group.productName, first?.upc, expanded);
  const sizes = fullSizes.length ? fullSizes : group.sizes;
  const optionCount = sizes.length;

  return (
    <div className={`prod-card${expanded ? ' is-expanded' : ''}`}>
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
            {group.productName}
          </Link>
          <div className="prod-card-type">{[group.productType, group.brand].filter(Boolean).join(' · ')}</div>
          <div className="prod-card-dist">
            <Store size={12} className="prod-card-dist-icon" />
            {distributorName(group.wholesaler)}
          </div>
        </div>
        <div className="prod-card-right">
          {range && (
            <div className="prod-card-range">
              ${range.lo.frontline_unit_price.toFixed(2)} <span className="prod-card-range-size">({range.lo.unit_volume})</span>
              {range.hi !== range.lo && (
                <> – ${range.hi.frontline_unit_price.toFixed(2)} <span className="prod-card-range-size">({range.hi.unit_volume})</span></>
              )}
            </div>
          )}
          <div className="prod-card-options">
            {anyDeal && <span className="prod-card-deal">Deal</span>}
            <span className="prod-card-instock"><CheckCircle2 size={13} /> {optionCount} option{optionCount === 1 ? '' : 's'} in stock</span>
          </div>
          {(range?.lo ?? first) && (
            <span onClick={e => e.stopPropagation()}>
              <PriceSparklines wholesaler={group.wholesaler} productName={(range?.lo ?? first).product_name}
                upc={(range?.lo ?? first).upc} unitVolume={(range?.lo ?? first).unit_volume}
                unitQty={(range?.lo ?? first).unit_qty} vintage={(range?.lo ?? first).vintage} />
            </span>
          )}
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
  for (const it of items) seen.add(`${it.wholesaler}|${it.product_name}`);
  return seen.size;
}
