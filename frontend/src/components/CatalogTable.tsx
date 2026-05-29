import { Fragment, useMemo } from 'react';
import { Link } from 'react-router-dom';
import FavoriteButton from './FavoriteButton';
import ProductThumb from './ProductThumb';
import AddToCartButton from './AddToCartButton';
import AddToListButton from './AddToListButton';
import { RowMenuButton } from './ContextMenu';
import MonthEffectiveSparkline from './MonthEffectiveSparkline';
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
}

/**
 * The shared product catalog table: a parent row per product plus expandable
 * DISC/RIP tier sub-rows ("Buy N = $X", save/case, price-after, ROI). Used by
 * the Catalog screen and the Order Analysis screen so they render identically.
 */
export default function CatalogTable({ items, open, cart, updateQty, sortControls, comboLink, showIntroduced }: Props) {
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
            const cartKey = `${item.product_name}|${item.wholesaler}`;
            const reactKey = `${cartKey}|${item.upc}|${rowIdx}`;
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
            return (
              <Fragment key={reactKey}>
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
                                  <span
                                    key={c}
                                    className="catalog-rip-group-badge"
                                    title={isPrimary
                                      ? `Part of RIP rebate ${c}. Items sharing this code must be purchased together to qualify.`
                                      : `Also qualifies under RIP rebate ${c}.`}
                                    style={col
                                      ? { background: col.tint, color: col.text, border: `1px solid ${col.border}` }
                                      : undefined}
                                  >
                                    🔗 RIP {c}
                                  </span>
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
                      <td colSpan={showIntroduced ? 6 : 5} style={{ paddingLeft: 24 }} className="card-title-cell">
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
            <tr><td colSpan={showIntroduced ? 10 : 9} className="empty">No products</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
