import { Link } from 'react-router-dom';
import type { CatalogAiProduct, AssistantTier, CatalogTier } from '../lib/api';
import { distributorName } from '../lib/distributors';
import AddToCartButton from './AddToCartButton';
import AddToListButton from './AddToListButton';
import FavoriteButton from './FavoriteButton';
import MonthEffectiveSparkline from './MonthEffectiveSparkline';
import { buildSparkProps } from '../lib/promotionsSparkline';
import { useProductQuickView } from './ProductQuickView';

interface Props {
  products: CatalogAiProduct[];
  /** Catalog deep-link to the same set of UPCs the table shows. Optional. */
  screenPath?: string;
  screenLabel?: string;
  /** Standalone Ask page: product names open the Product Modal and a this->next
   *  pricing sparkline (same popover as the Catalog) is shown per row. */
  standalone?: boolean;
}

const money = (v?: number | null) => (v == null ? '—' : `$${Number(v).toFixed(2)}`);
const fmtSavingsPct = (front?: number | null, eff?: number | null) => {
  if (front == null || eff == null || front <= 0) return null;
  // A $0 / near-free row is a "free-with-purchase" stocking deal, not a normal
  // discount. Showing "100% off" misreads the data, so don't render a % here
  // (the backend already filters these out of browse/deal results).
  if (eff <= 0 || eff < front * 0.1) return null;
  const pct = ((front - eff) / front) * 100;
  return pct > 0 ? `${pct.toFixed(0)}%` : null;
};

/** Short label for a tier: "5cs · -$20.00", "60btl · -$8.00". */
function tierChip(t: AssistantTier): string {
  const qty = t.qty;
  const unit = (t.unit || '').toLowerCase().startsWith('b') ? 'btl' : 'cs';
  const amt = Number(t.amount || 0).toFixed(2);
  return `${qty}${unit} · -$${amt}`;
}

/**
 * Side-by-side decision table the Celar Assistant renders inline when 3+
 * products are returned. Shows the full decision pack: product, distributor,
 * size, vintage, frontline /cs, effective /cs, savings %, all CPL discount
 * tiers and all RIP tiers. Below the table, a deep-link opens the same set
 * in the Catalog (filtered by exact UPCs).
 */
export default function AssistantComparisonTable({ products, screenPath, screenLabel, standalone }: Props) {
  const { open } = useProductQuickView();
  return (
    <div className="celar-compare-wrap">
      <div className="celar-compare-scroll">
        <table className="celar-compare-table">
          <thead>
            <tr>
              <th>Product</th>
              <th>Distributor</th>
              <th>Size</th>
              <th>Vintage</th>
              <th className="right">Frontline /cs</th>
              <th className="right">Effective /cs</th>
              <th className="right">Save</th>
              {standalone && <th>Trend</th>}
              <th>Discount tiers</th>
              <th>RIP tiers</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {products.map((p, i) => {
              const savingsPct = fmtSavingsPct(p.frontline_case_price, p.effective_case_price);
              const disc = p.discount_tiers ?? [];
              const rips = p.rip_tiers ?? [];
              const openModal = () => open(p.product_name, p.wholesaler, undefined, {
                upc: p.upc ?? undefined, unitVolume: p.unit_volume ?? undefined,
                unitQty: p.unit_qty ?? undefined, vintage: (p.vintage as string | null) ?? undefined,
              });
              return (
                <tr key={`${p.wholesaler}-${p.upc ?? p.product_name}-${i}`}>
                  <td className="celar-compare-name">
                    {standalone
                      ? <button type="button" className="celar-compare-namelink" onClick={openModal}>{p.product_name}</button>
                      : p.product_name}
                  </td>
                  <td>{distributorName(p.wholesaler)}</td>
                  <td>{p.unit_volume ?? '—'}</td>
                  <td>{p.vintage && p.vintage !== '0' ? p.vintage : '—'}</td>
                  <td className="right">{money(p.frontline_case_price)}</td>
                  <td className="right"><strong>{money(p.effective_case_price)}</strong></td>
                  <td className="right">{savingsPct ?? '—'}</td>
                  {standalone && (
                    <td className="celar-compare-spark">
                      <MonthEffectiveSparkline {...buildSparkProps({
                        unit_qty: p.unit_qty,
                        unit_volume: p.unit_volume,
                        price_3mo: p.price_3mo,
                      })} />
                    </td>
                  )}
                  <td>
                    {disc.length === 0 ? <span className="celar-compare-empty">—</span> : (
                      <div className="celar-compare-chips">
                        {disc.map((t, ti) => <span key={ti} className="celar-compare-chip celar-compare-chip-disc">{tierChip(t)}</span>)}
                      </div>
                    )}
                  </td>
                  <td>
                    {rips.length === 0 ? <span className="celar-compare-empty">—</span> : (
                      <div className="celar-compare-chips">
                        {rips.map((t, ti) => <span key={ti} className="celar-compare-chip celar-compare-chip-rip">{tierChip(t)}</span>)}
                      </div>
                    )}
                  </td>
                  <td>
                    <div className="celar-compare-actions">
                      <FavoriteButton productName={p.product_name} wholesaler={p.wholesaler} upc={p.upc ?? undefined} unitVolume={p.unit_volume ?? undefined} />
                      <AddToCartButton productName={p.product_name} wholesaler={p.wholesaler} upc={p.upc ?? undefined} unitVolume={p.unit_volume ?? undefined} qtyCases={1} qtyUnits={0} />
                      <AddToListButton productName={p.product_name} wholesaler={p.wholesaler} upc={p.upc ?? undefined} unitVolume={p.unit_volume ?? undefined} />
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {screenPath && (
        <div className="celar-compare-link">
          <Link to={screenPath} className="celar-compare-link-btn">
            Open {screenLabel || 'full list'} in Catalog →
          </Link>
        </div>
      )}
    </div>
  );
}
