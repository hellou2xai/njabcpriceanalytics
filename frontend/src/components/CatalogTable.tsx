import { Fragment } from 'react';
import { Link } from 'react-router-dom';
import FavoriteButton from './FavoriteButton';
import ProductThumb from './ProductThumb';
import AddToCartButton from './AddToCartButton';
import AddToListButton from './AddToListButton';
import { RowMenuButton } from './ContextMenu';
import { distributorName } from '../lib/distributors';
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
}

/**
 * The shared product catalog table: a parent row per product plus expandable
 * DISC/RIP tier sub-rows ("Buy N = $X", save/case, price-after, ROI). Used by
 * the Catalog screen and the Order Analysis screen so they render identically.
 */
export default function CatalogTable({ items, open, cart, updateQty, sortControls, comboLink, showIntroduced }: Props) {
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
            <th>Distributor</th>
            <th>Type</th>
            <th>Size</th>
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
            const cartKey = `${item.product_name}|${item.wholesaler}`;
            const reactKey = `${cartKey}|${item.upc}|${rowIdx}`;
            const qty = cart[cartKey] ?? { cases: 0, units: 0 };
            const tiers: CatalogTier[] = item.tiers ?? [];
            const hasTiers = tiers.length > 0;
            return (
              <Fragment key={reactKey}>
                <tr className="catalog-row-main"
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
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 600 }}>{item.product_name}</div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                          {item.upc}
                          {item.vintage != null && String(item.vintage) !== '0' && String(item.vintage).trim() !== '' && (
                            <span className="tag" style={{ marginLeft: 6, fontSize: 10 }}
                                  title="Vintage year. The same barcode can cover several vintages, each priced separately.">Vintage {item.vintage}</span>
                          )}
                          {item.multi_distributor && (
                            <span className="tag tag-blue" style={{ marginLeft: 6, fontSize: 10 }}
                                  title={`Same product is carried by ${item.distributor_count ?? 'several'} distributors`}>Multiple distributors</span>
                          )}
                        </div>
                        {comboLink && (() => {
                          const url = comboLink(item);
                          return url
                            ? <a href={url} className="combo-link-badge"
                                 onClick={e => { e.preventDefault(); e.stopPropagation(); window.open(url, 'combo-bundle', 'popup,width=940,height=780'); }}
                                 title="This product is part of a combo bundle — open in a popup">🎁 In combo</a>
                            : null;
                        })()}
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
                        {/* Order facility lives in the product cell so it stays visible at any width. */}
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
                      </div>
                    </div>
                  </td>
                  <td data-label="Distributor"><span className="cell-distributor-badge">{distributorName(item.wholesaler)}</span></td>
                  <td data-label="Type">{item.product_type}</td>
                  <td data-label="Size">{item.unit_volume}</td>
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
                  return (
                    <tr key={`${reactKey}_${idx}`} className="catalog-row-sub" data-tier-met={tierMet}>
                      <td></td>
                      <td colSpan={showIntroduced ? 7 : 6} style={{ paddingLeft: 24 }} className="card-title-cell">
                        <span className={`source-badge source-${t.source}`}>{t.source === 'discount' ? 'DISC' : 'RIP'}</span>
                        <span className={`rip-tier-badge ${t.source === 'discount' ? 'rip-tier-curr' : 'rip-tier-next'}`} style={{ marginLeft: 8 }}>
                          Buy {t.qty} {shortUnit(t.unit)} = <strong>${t.amount.toFixed(2)}</strong>
                        </span>
                        {t.description && <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 8 }}>{t.description}</span>}
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
            <tr><td colSpan={showIntroduced ? 11 : 10} className="empty">No products</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
