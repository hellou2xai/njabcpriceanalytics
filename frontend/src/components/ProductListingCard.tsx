/**
 * ProductListingCard — the ONE shared product-listing block.
 *
 * Renders, for a single SKU listing (size + distributor), the uniform layout
 * used on the product detail page AND the Products list expanded rows:
 *
 *   Summary card (Image #5)  — big image, title, "#item | size | per pack |
 *                              Cost Per Ounce", CASE/BOTTLE Price (after the
 *                              1-case QD) + Next Month, add to cart / list.
 *   RIP + QD panels          — the shared RipQdPanels (RIP details + prices
 *                              chart), so QD/RIP read identically everywhere.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Store, ChevronDown } from 'lucide-react';
import ProductThumb from './ProductThumb';
import FavoriteButton from './FavoriteButton';
import AddToCartButton from './AddToCartButton';
import AddToListButton from './AddToListButton';
import { QtyStepper, type CartState } from './CatalogTable';
import { buildMonths } from '../lib/promotionsSparkline';
import { currentMonth, type MonthBreakdown } from './MonthEffectiveSparkline';
import RipQdPanels, { money, afterOneCase, ozPerBottle } from './RipQdPanels';
import { bottlesPerCase, stripHeaderVintage } from '../lib/productSizes';
import { distributorName, abgSku, skuLabel, perUnitNoun, priceUnitWord } from '../lib/distributors';
import type { Product } from '../lib/api';

// Detail-page deep link for a listing (exact distributor + UPC + size).
function detailUrl(size: Product): string {
  const q = new URLSearchParams({ w: size.wholesaler, n: size.product_name });
  if (size.upc) q.set('u', String(size.upc));
  if (size.unit_volume) q.set('s', String(size.unit_volume));
  return `/product?${q.toString()}`;
}

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
  const hasVintage = size.vintage != null && !['', '0', 'nv'].includes(String(size.vintage).trim().toLowerCase());

  const PricePair = ({ label, now, nxt }: { label: string; now: number | null; nxt: number | null }) => (
    <div className="pdx-price-block">
      <div className="pdx-price-k">{label}</div>
      <div className="pdx-price-vals">
        <div className="pdx-price-now">Price: <strong>{money(now) ?? '—'}</strong></div>
        {nxt != null && (
          <div className={`pdx-price-next${now != null && nxt < now - 0.005 ? ' pdx-price-next--down' : ''}`}>
            Next Month: {money(nxt)}
          </div>
        )}
      </div>
    </div>
  );

  return (
    <>
      <Link to={detailUrl(size)} className="pdx-sum-imglink" aria-label={size.product_name}>
        <ProductThumb src={size.image_url} alt={size.product_name} size={160} expandable />
      </Link>
      <div className="pdx-sum-meta">
        {/* Distributor on top, bigger and bold — easiest thing to identify. */}
        <div className="pdx-sum-dist-top"><Store size={16} /> {distributorName(size.wholesaler)}</div>
        <div className="pdx-sum-titlerow">
          <FavoriteButton productName={size.product_name} wholesaler={size.wholesaler}
            upc={size.upc} unitVolume={size.unit_volume} />
          <Link to={detailUrl(size)} className="pdx-sum-title-link">
            <h2 className="pdx-sum-title">
              {stripHeaderVintage(size.product_name || name, size.product_type)}
              {size.unit_volume && <span className="pdx-sum-title-size"> ({size.unit_volume})</span>}
            </h2>
          </Link>
        </div>
        <div className="pdx-sum-specs">
          {idNum && <span>#{idNum}</span>}
          {size.unit_volume && <span>{size.unit_volume}</span>}
          {pack != null && <span>{pack} Per Pack</span>}
          {costPerOz != null && <span>Cost Per Ounce {money(costPerOz)}</span>}
          {hasVintage && <span>Vintage {size.vintage}</span>}
        </div>
        <div className="pdx-sum-ids">
          {abgSku(size.wholesaler, size.abg_sku) && <span className="pdx-sum-sku">SKU: {skuLabel(size.wholesaler)} {size.abg_sku}</span>}
          {size.upc && <span className="pdx-sum-upc">UPC: {size.upc}</span>}
        </div>
      </div>
      <div className="pdx-sum-prices">
        <PricePair label={csWord.toUpperCase()} now={caseThis} nxt={caseNext} />
        <PricePair label={btlWord.toUpperCase()} now={btlThis} nxt={btlNext} />
      </div>
    </>
  );
}

export default function ProductListingCard({ size, name, cart, updateQty, showPanels = true }: {
  size: Product;
  name?: string;
  cart: CartState;
  updateQty: (key: string, field: 'cases' | 'units', value: number) => void;
  // Summary view (Products page "Summary" toggle) hides the RIP/QD panels and
  // shows only the summary card + order actions; Price-details view shows them.
  showPanels?: boolean;
}) {
  const pname = name ?? size.product_name;
  const pack = bottlesPerCase(pname, size.unit_qty);
  const months = useMemo(() => buildMonths(size), [size]);
  const cur = currentMonth(months);
  const next = months.find(m => m.future) ?? null;
  const btlWord = perUnitNoun(size.unit_volume, size.unit_type);

  const cartKey = `${size.product_name}|${size.wholesaler}|${size.upc ?? ''}|${size.unit_volume ?? ''}`;
  const qty = cart[cartKey] ?? { cases: 0, units: 0 };

  // In Summary mode (showPanels=false) the RIP/QD panels are collapsed; each
  // line can be expanded individually to see its details, like the detail view.
  const [expanded, setExpanded] = useState(false);
  const panelsVisible = showPanels || expanded;

  return (
    <div className="pdx-listing">
      {/* One row: image · meta · prices · order — the order fills the space to
          the right of the prices instead of sitting on its own line below. */}
      <div className="pdx-summary">
        <SummaryCard size={size} name={pname} cur={cur} next={next} pack={pack} />
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
            {!showPanels && (
              <button type="button" className="pdx-expand-toggle" onClick={() => setExpanded(e => !e)}>
                {expanded ? 'Hide details' : 'View details'}
                <ChevronDown size={15} className={`pdx-expand-chev${expanded ? ' open' : ''}`} />
              </button>
            )}
          </div>
        </div>
      </div>
      {panelsVisible && <RipQdPanels size={size} name={pname} />}
    </div>
  );
}
