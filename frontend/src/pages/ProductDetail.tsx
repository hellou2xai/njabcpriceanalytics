import { useEffect, useMemo, useState, useCallback } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { Store } from 'lucide-react';
import ProductThumb from '../components/ProductThumb';
import FavoriteButton from '../components/FavoriteButton';
import AddToCartButton from '../components/AddToCartButton';
import AddToListButton from '../components/AddToListButton';
import { QtyStepper, loadCart, saveCart, type CartState } from '../components/CatalogTable';
import PriceSparklines from '../components/PriceSparklines';
import { buildMonths } from '../lib/promotionsSparkline';
import { currentMonth, type MonthBreakdown } from '../components/MonthEffectiveSparkline';
import RipQdPanels, { money, afterOneCase, ozPerBottle } from '../components/RipQdPanels';
import { useProductSizes, bottlesPerCase, sizeToMl, stripHeaderVintage } from '../lib/productSizes';
import { distributorName, abgSku, skuLabel, perUnitNoun, priceUnitWord } from '../lib/distributors';
import type { Product } from '../lib/api';

// The price sparkline is hidden for now (the new detail design is the three
// panels only). Kept behind a flag so it can be switched back on without a
// rewrite — flip to true to restore the 3-month history chart in the summary.
const SHOW_SPARKLINE = false;

// ───────────────────────── Summary card (Image #5) ─────────────────────────
function SummaryCard({ size, name, cur, next, pack }: {
  size: Product; name: string; cur: MonthBreakdown | null; next: MonthBreakdown | null; pack: number | null;
}) {
  const ozB = ozPerBottle(size.unit_volume);
  // Cost per ounce = FRONTLINE single-bottle price ÷ fluid ounces (list-price
  // basis, deal-independent).
  const frontlineBtl = pack && size.frontline_case_price != null
    ? size.frontline_case_price / pack
    : (size.frontline_unit_price ?? null);
  const costPerOz = ozB && frontlineBtl != null ? frontlineBtl / ozB : null;

  const caseThis = afterOneCase(cur) ?? size.frontline_case_price ?? null;
  const caseNext = afterOneCase(next);
  const btlThis = caseThis != null && pack ? caseThis / pack : (size.frontline_unit_price ?? null);
  const btlNext = caseNext != null && pack ? caseNext / pack : null;

  const idNum = abgSku(size.wholesaler, size.abg_sku) ? size.abg_sku : size.upc;
  const csWord = priceUnitWord(size.unit_volume, size.unit_type);
  const btlWord = perUnitNoun(size.unit_volume, size.unit_type);

  const PricePair = ({ label, now, nxt }: { label: string; now: number | null; nxt: number | null }) => (
    <div className="pdx-price-block">
      <div className="pdx-price-k">{label}</div>
      <div className="pdx-price-now">Price: <strong>{money(now) ?? '—'}</strong></div>
      {nxt != null && (
        <div className={`pdx-price-next${now != null && nxt < now - 0.005 ? ' pdx-price-next--down' : ''}`}>
          Next Month: {money(nxt)}
        </div>
      )}
    </div>
  );

  return (
    <section className="pdx-panel pdx-summary">
      <Link to={`/product?w=${encodeURIComponent(size.wholesaler)}&n=${encodeURIComponent(size.product_name)}${size.upc ? `&u=${encodeURIComponent(size.upc)}` : ''}`}
        className="pdx-sum-imglink" aria-label={size.product_name}>
        <ProductThumb src={size.image_url} alt={size.product_name} size={160} expandable />
      </Link>
      <div className="pdx-sum-meta">
        <div className="pdx-sum-titlerow">
          <FavoriteButton productName={size.product_name} wholesaler={size.wholesaler}
            upc={size.upc} unitVolume={size.unit_volume} />
          <h2 className="pdx-sum-title">{stripHeaderVintage(size.product_name || name, size.product_type)}</h2>
        </div>
        <div className="pdx-sum-specs">
          {idNum && <span>#{idNum}</span>}
          {size.unit_volume && <span>{size.unit_volume}</span>}
          {pack != null && <span>{pack} Per Pack</span>}
          {costPerOz != null && <span>Cost Per Ounce {money(costPerOz)}</span>}
        </div>
        <div className="pdx-sum-ids">
          <span className="pdx-sum-dist"><Store size={12} /> {distributorName(size.wholesaler)}</span>
          {abgSku(size.wholesaler, size.abg_sku) && <span>SKU: {skuLabel(size.wholesaler)} {size.abg_sku}</span>}
          {size.upc && <span className="pdx-sum-upc">UPC: {size.upc}</span>}
        </div>
        {SHOW_SPARKLINE && (
          <span className="pdx-sum-spark">
            <PriceSparklines wholesaler={size.wholesaler} productName={size.product_name}
              upc={size.upc} unitVolume={size.unit_volume} unitQty={size.unit_qty} vintage={size.vintage}
              months={cur ? buildMonths(size) : undefined} />
          </span>
        )}
      </div>
      <div className="pdx-sum-prices">
        <PricePair label={csWord.toUpperCase()} now={caseThis} nxt={caseNext} />
        <PricePair label={btlWord.toUpperCase()} now={btlThis} nxt={btlNext} />
      </div>
    </section>
  );
}

// ───────────────────────── one listing (size + distributor) ─────────────────
function ListingBlock({ size, name, cart, updateQty }: {
  size: Product; name: string; cart: CartState;
  updateQty: (key: string, field: 'cases' | 'units', value: number) => void;
}) {
  const pack = bottlesPerCase(name, size.unit_qty);
  const months = useMemo(() => buildMonths(size), [size]);
  const cur = currentMonth(months);
  const next = months.find(m => m.future) ?? null;
  const btlWord = perUnitNoun(size.unit_volume, size.unit_type);

  const cartKey = `${size.product_name}|${size.wholesaler}|${size.upc ?? ''}|${size.unit_volume ?? ''}`;
  const qty = cart[cartKey] ?? { cases: 0, units: 0 };

  return (
    <div className="pdx-listing">
      <SummaryCard size={size} name={name} cur={cur} next={next} pack={pack} />

      <div className="pdx-order">
        <div className="pdx-order-steppers">
          <QtyStepper label={`${btlWord.charAt(0).toUpperCase()}${btlWord.slice(1)}s`}
            value={qty.units} onChange={v => updateQty(cartKey, 'units', v)} />
          <QtyStepper label="Cases" value={qty.cases} onChange={v => updateQty(cartKey, 'cases', v)} />
        </div>
        <div className="pdx-order-actions">
          <AddToCartButton productName={size.product_name} wholesaler={size.wholesaler}
            upc={size.upc} unitVolume={size.unit_volume}
            unitQty={size.unit_qty != null ? String(size.unit_qty) : undefined}
            vintage={size.vintage != null ? String(size.vintage) : undefined}
            qtyCases={qty.cases} qtyUnits={qty.units} />
          <AddToListButton productName={size.product_name} wholesaler={size.wholesaler}
            upc={size.upc} unitVolume={size.unit_volume}
            unitQty={size.unit_qty != null ? String(size.unit_qty) : undefined}
            vintage={size.vintage != null ? String(size.vintage) : undefined} />
        </div>
      </div>

      <RipQdPanels size={size} name={name} />
    </div>
  );
}

export default function ProductDetail() {
  const [params] = useSearchParams();
  const wholesaler = params.get('w') ?? '';
  const name = params.get('n') ?? '';
  const upc = params.get('u') ?? undefined;

  const [cart, setCartState] = useState<CartState>(loadCart);
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

  // Every size of this product (and the same product at other distributors),
  // each with its tiers + 3-month blocks for the RIP / QD panels.
  const { sizes, isLoading, isError, refetch } = useProductSizes(wholesaler, name, upc, true, true);
  const orderedSizes = useMemo(() => {
    const vnum = (v: unknown) => { const n = parseInt(String(v ?? ''), 10); return Number.isFinite(n) ? n : -1; };
    return [...sizes].sort((a, b) =>
      sizeToMl(a.unit_volume) - sizeToMl(b.unit_volume)
      || (a.wholesaler === wholesaler ? 0 : 1) - (b.wholesaler === wholesaler ? 0 : 1)
      || a.wholesaler.localeCompare(b.wholesaler)
      || vnum(b.vintage) - vnum(a.vintage));
  }, [sizes, wholesaler]);

  if (!wholesaler || !name) {
    return <div className="page"><p>Product not specified.</p><Link to="/products" className="link-btn">← Back to Products</Link></div>;
  }

  return (
    <div className="page pdx-page">
      <div className="pdx-top">
        <Link to="/products" className="pdx-back">← Products</Link>
        <h1 className="pdx-page-title">{stripHeaderVintage(name, orderedSizes[0]?.product_type)}</h1>
      </div>

      {isError ? (
        <div className="pdx-loading">
          <p>Couldn’t load this product.</p>
          <button type="button" className="btn btn-secondary" onClick={() => refetch()}>Retry</button>
        </div>
      ) : isLoading ? (
        <p className="pdx-loading">Loading…</p>
      ) : orderedSizes.length === 0 ? (
        <p className="pdx-loading">No listings found.</p>
      ) : (
        <div className="pdx-listings">
          {orderedSizes.map((s, i) => (
            <ListingBlock key={`${s.product_name}|${s.upc}|${s.unit_volume}|${s.wholesaler}|${i}`}
              size={s} name={name} cart={cart} updateQty={updateQty} />
          ))}
          <div className="pdx-end">End · {orderedSizes.length} listing{orderedSizes.length === 1 ? '' : 's'}</div>
        </div>
      )}
    </div>
  );
}
