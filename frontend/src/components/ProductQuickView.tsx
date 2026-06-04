import { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { catalog, notes } from '../lib/api';
import PriceChart from './PriceChart';
import PriceBreakdown from './PriceBreakdown';
import PriceWaterfall from './PriceWaterfall';
import FavoriteButton from './FavoriteButton';
import ProductThumb from './ProductThumb';
import AddToCartButton from './AddToCartButton';
import { distributorName, abgSku, skuLabel } from '../lib/distributors';
import { windowBadge } from '../lib/dealDates';
import type { TierWindow } from '../lib/api';

// Inline window-status badge (Active now / Expires in N days / Starts DD MMM)
// for a single RIP / discount tier. Returns null for whole-month / evergreen.
function WinBadge({ tier }: { tier: TierWindow }) {
  const b = windowBadge(tier);
  if (!b) return null;
  return (
    <span className={`win-badge ${b.cls}${b.urgent ? ' urgent' : ''}`} style={{ marginTop: 3 }}>
      {b.label}
    </span>
  );
}

// Stable colour hue for a RIP code so the same rebate gets the same swatch
// everywhere (here and on the cart's RIP-grouped view).
export function ripHue(code: string): number {
  let h = 0;
  for (let i = 0; i < code.length; i++) h = (h * 31 + code.charCodeAt(i)) % 360;
  return h;
}

interface CompareSide {
  productName: string;
  wholesaler: string;
  upc?: string;
  unitVolume?: string;
  unitQty?: string;
  vintage?: string;
}

interface MonthCompare { curr: string; next: string }

interface QuickViewCtx {
  open: (
    productName: string,
    wholesaler: string,
    compareWith?: CompareSide,
    opts?: { upc?: string; unitVolume?: string; unitQty?: string; vintage?: string; months?: MonthCompare; ripCode?: string },
  ) => void;
  close: () => void;
}

const Ctx = createContext<QuickViewCtx>({ open: () => {}, close: () => {} });
export const useProductQuickView = () => useContext(Ctx);

export function ProductQuickViewProvider({ children }: { children: React.ReactNode }) {
  const [target, setTarget] = useState<
    { productName: string; wholesaler: string; upc?: string; unitVolume?: string; unitQty?: string; vintage?: string; months?: MonthCompare; compareWith?: CompareSide; ripCode?: string } | null
  >(null);

  const open = useCallback(
    (
      productName: string,
      wholesaler: string,
      compareWith?: CompareSide,
      opts?: { upc?: string; unitVolume?: string; unitQty?: string; vintage?: string; months?: MonthCompare; ripCode?: string },
    ) => setTarget({ productName, wholesaler, ...opts, compareWith }),
    []
  );
  const close = useCallback(() => setTarget(null), []);

  return (
    <Ctx.Provider value={{ open, close }}>
      {children}
      {target && (
        <QuickViewModal
          productName={target.productName}
          wholesaler={target.wholesaler}
          upc={target.upc}
          unitVolume={target.unitVolume}
          unitQty={target.unitQty}
          vintage={target.vintage}
          months={target.months}
          compareWith={target.compareWith}
          ripCodeOverride={target.ripCode}
          onClose={close}
        />
      )}
    </Ctx.Provider>
  );
}

function QuickViewModal({
  productName, wholesaler, upc, unitVolume, unitQty, vintage, months, compareWith, ripCodeOverride, onClose,
}: {
  productName: string;
  wholesaler: string;
  upc?: string;
  unitVolume?: string;
  unitQty?: string;
  vintage?: string;
  months?: MonthCompare;
  compareWith?: CompareSide;
  ripCodeOverride?: string;
  onClose: () => void;
}) {
  // Draggable modal: offset from its centered position. Lets the user pull it
  // clear of the docked assistant (or anything else) instead of being overlapped.
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ sx: number; sy: number; bx: number; by: number } | null>(null);
  useEffect(() => { setDragOffset({ x: 0, y: 0 }); }, [productName, wholesaler]);  // recenter on new product
  const onDragDown = (e: React.PointerEvent) => {
    dragRef.current = { sx: e.clientX, sy: e.clientY, bx: dragOffset.x, by: dragOffset.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onDragMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    setDragOffset({ x: d.bx + (e.clientX - d.sx), y: d.by + (e.clientY - d.sy) });
  };
  const onDragUp = (e: React.PointerEvent) => {
    dragRef.current = null;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* */ }
  };

  const { data: detail } = useQuery({
    // ripCodeOverride is included so a click from a multi-RIP catalog row
    // re-fetches the detail bound to THAT cluster's tier ladder, not the
    // canonical cpl rip_code (which may be a different cluster entirely).
    queryKey: ['product-detail', wholesaler, productName, upc, unitVolume, unitQty, vintage, months?.curr, ripCodeOverride],
    queryFn: () => catalog.product(wholesaler, productName, { edition: months?.curr, upc, unit_volume: unitVolume, unit_qty: unitQty, vintage, rip_code: ripCodeOverride }),
  });

  // Auto-derive a current/next edition pair from whatever this page loaded,
  // so EVERY product detail shows two charts (this month + next month) even
  // when the opener didn't pass `months` explicitly. nextYM bumps a YYYY-MM
  // string by one calendar month with year roll-over.
  const nextYM = (ym?: string | null): string | null => {
    if (!ym) return null;
    const m = /^(\d{4})-(\d{1,2})$/.exec(ym);
    if (!m) return null;
    const y = parseInt(m[1], 10); const mo = parseInt(m[2], 10);
    const ny = mo === 12 ? y + 1 : y;
    const nm = mo === 12 ? 1 : mo + 1;
    return `${ny}-${String(nm).padStart(2, '0')}`;
  };
  const prevYM = (ym?: string | null): string | null => {
    if (!ym) return null;
    const m = /^(\d{4})-(\d{1,2})$/.exec(ym);
    if (!m) return null;
    const y = parseInt(m[1], 10); const mo = parseInt(m[2], 10);
    const py = mo === 1 ? y - 1 : y;
    const pm = mo === 1 ? 12 : mo - 1;
    return `${py}-${String(pm).padStart(2, '0')}`;
  };
  const detailEd = detail?.product?.edition ?? null;
  const effectiveMonths: MonthCompare | undefined = months
    ? months
    : (detailEd ? { curr: detailEd, next: nextYM(detailEd) ?? detailEd } : undefined);
  const prevEd = prevYM(effectiveMonths?.curr ?? null);

  // Next-month edition of the SAME SKU, for month-over-month breakdown.
  // Fires as soon as we know which edition the current detail belongs to,
  // so the two-chart layout is the default for every page using quick view.
  const { data: detailNext } = useQuery({
    enabled: !!effectiveMonths?.next && effectiveMonths.next !== effectiveMonths.curr,
    queryKey: ['product-detail', wholesaler, productName, upc, unitVolume, unitQty, vintage, effectiveMonths?.next],
    queryFn: () => catalog.product(wholesaler, productName, { edition: effectiveMonths!.next, upc, unit_volume: unitVolume, unit_qty: unitQty, vintage }),
  });
  // Prior-month edition. Needed on the price-movers modal so a rise that
  // happened last→this (and is now flat into next) is visible at a glance —
  // without this the user sees two identical waterfalls and wonders why the
  // product is on the Price Increase page.
  const { data: detailPrev } = useQuery({
    enabled: !!prevEd && prevEd !== effectiveMonths?.curr,
    queryKey: ['product-detail', wholesaler, productName, upc, unitVolume, unitQty, vintage, prevEd],
    queryFn: () => catalog.product(wholesaler, productName, { edition: prevEd!, upc, unit_volume: unitVolume, unit_qty: unitQty, vintage }),
  });

  const { data: history } = useQuery({
    queryKey: ['price-history', wholesaler, productName, upc, unitVolume, unitQty, vintage],
    queryFn: () => catalog.priceHistory(wholesaler, productName, { upc, unit_volume: unitVolume, unit_qty: unitQty, vintage }),
  });

  const { data: breakdown } = useQuery({
    queryKey: ['product-breakdown', wholesaler, productName, upc, unitVolume, unitQty, vintage],
    queryFn: () => catalog.productBreakdown(wholesaler, productName, { upc, unit_volume: unitVolume, unit_qty: unitQty, vintage }),
  });

  // RIP siblings: every other product sharing this product's rip_code in the
  // latest edition. RIP rebates qualify on combined quantity across the group,
  // so we surface the full list with per-row Add to Cart. When the caller
  // pinned a specific cluster via ripCodeOverride (e.g. a click on a
  // group-by-RIP catalog row), use THAT code so the siblings panel matches
  // the cluster the user came from.
  const ripCodeRaw = ripCodeOverride || detail?.product?.rip_code;
  const ripCode = ripCodeRaw && !['None', 'nan', '0', ''].includes(String(ripCodeRaw)) ? String(ripCodeRaw) : null;
  const { data: ripSiblings } = useQuery({
    enabled: !!ripCode,
    queryKey: ['rip-siblings', wholesaler, ripCode, upc],
    queryFn: () => catalog.ripSiblings(wholesaler, ripCode!, { exclude_upc: upc }),
  });

  // Optional second distributor for side-by-side comparison
  const { data: detailB } = useQuery({
    enabled: !!compareWith,
    queryKey: ['product-detail', compareWith?.wholesaler, compareWith?.productName, compareWith?.upc, compareWith?.unitVolume, compareWith?.unitQty, compareWith?.vintage],
    queryFn: () => catalog.product(compareWith!.wholesaler, compareWith!.productName, {
      upc: compareWith!.upc, unit_volume: compareWith!.unitVolume, unit_qty: compareWith!.unitQty, vintage: compareWith!.vintage,
    }),
  });
  const { data: breakdownB } = useQuery({
    enabled: !!compareWith,
    queryKey: ['product-breakdown', compareWith?.wholesaler, compareWith?.productName, compareWith?.upc, compareWith?.unitVolume, compareWith?.unitQty, compareWith?.vintage],
    queryFn: () => catalog.productBreakdown(compareWith!.wholesaler, compareWith!.productName, {
      upc: compareWith!.upc, unit_volume: compareWith!.unitVolume, unit_qty: compareWith!.unitQty, vintage: compareWith!.vintage,
    }),
  });
  const { data: historyB } = useQuery({
    enabled: !!compareWith,
    queryKey: ['price-history', compareWith?.wholesaler, compareWith?.productName, compareWith?.upc, compareWith?.unitVolume, compareWith?.unitQty, compareWith?.vintage],
    queryFn: () => catalog.priceHistory(compareWith!.wholesaler, compareWith!.productName, {
      upc: compareWith!.upc, unit_volume: compareWith!.unitVolume, unit_qty: compareWith!.unitQty, vintage: compareWith!.vintage,
    }),
  });

  const p = detail?.product;
  const pB = detailB?.product;

  // Sort state for the All Editions Breakdown table
  const [bSort, setBSort] = useState<{ key: string; dir: 'asc' | 'desc' }>({ key: 'edition', dir: 'asc' });
  const toggleSort = (key: string) =>
    setBSort(s => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));
  const sortArrow = (key: string) => (bSort.key === key ? (bSort.dir === 'asc' ? ' ▲' : ' ▼') : '');

  const monthLabel = (ym: string) => {
    const [, m] = ym.split('-');
    const names = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const idx = parseInt(m, 10) - 1;
    return idx >= 0 && idx < 12 ? `${names[idx]} ${ym.split('-')[0]}` : ym;
  };

  const compactTier = (qty: number, unit: string, amt: number) => {
    const u = unit.toLowerCase().startsWith('case') || unit.toLowerCase() === 'c' ? 'cs' : 'btl';
    return `${qty}${u} = $${amt}`;
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} onKeyDown={e => e.key === 'Escape' && onClose()}
           style={{ transform: `translate(${dragOffset.x}px, ${dragOffset.y}px)` }}>
        <div className="modal-drag-handle" title="Drag to move"
             onPointerDown={onDragDown} onPointerMove={onDragMove} onPointerUp={onDragUp}>
          ⠿ drag
        </div>
        <button className="modal-close" onClick={onClose}>✕</button>

        {!p ? <p>Loading...</p> : (
          <>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, marginBottom: 8 }}>
              <ProductThumb src={detail?.enrichment?.image_url} alt={p.product_name} size={180} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <FavoriteButton productName={productName} wholesaler={wholesaler} unitVolume={p.unit_volume} upc={p.upc} />
                  <h3 style={{ margin: 0 }}>{p.product_name}</h3>
                </div>
                <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: '6px 0 0' }}>
                  {p.wholesaler} · {p.product_type} · {p.unit_volume} · {p.upc}
                  {abgSku(p.wholesaler, p.abg_sku) && <> · {skuLabel(p.wholesaler)} {p.abg_sku}</>}
                  {vintage && <span className="tag tag-blue" style={{ marginLeft: 8, fontSize: 11 }}>Vintage {vintage}</span>}
                </p>
                {detail?.enrichment && (detail.enrichment.brand || detail.enrichment.region) && (
                  <p style={{ color: 'var(--text-muted)', fontSize: 12, margin: '4px 0 0' }}>
                    {[detail.enrichment.brand, detail.enrichment.region].filter(Boolean).join(' · ')}
                  </p>
                )}
              </div>
            </div>

            {detail?.enrichment && (() => {
              const en = detail.enrichment;
              const specs = en.specs ? Object.entries(en.specs).filter(([, v]) => v != null && String(v) !== '') : [];
              const path = en.category_path?.filter(Boolean) ?? [];
              const hasDesc = en.description && en.description !== 'No description found.';
              if (!hasDesc && specs.length === 0 && path.length === 0 && !en.region) return null;
              return (
                <div className="panel" style={{ padding: 10, marginTop: 8, marginBottom: 8, fontSize: 13 }}>
                  {path.length > 0 && (
                    <div style={{ color: 'var(--text-muted)', fontSize: 11, marginBottom: 6 }}>
                      {path.join(' › ')}
                    </div>
                  )}
                  {hasDesc && <p style={{ margin: '0 0 8px' }}>{en.description}</p>}
                  {specs.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 16px' }}>
                      {specs.map(([k, v]) => (
                        <span key={k} style={{ fontSize: 12 }}>
                          <span style={{ color: 'var(--text-muted)' }}>{k}: </span>{String(v)}
                        </span>
                      ))}
                    </div>
                  )}
                  {(en.region || en.brand) && (
                    <div style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 6 }}>
                      {[en.brand, en.region].filter(Boolean).join(' · ')}
                    </div>
                  )}
                </div>
              );
            })()}

            {detail?.ai_blurb && (
              <div className="pv-ai-blurb">
                <div className="pv-ai-blurb-head">
                  <span className="pv-ai-blurb-icon" aria-hidden="true">✨</span>
                  <span>What this means in plain English</span>
                  <span className="pv-ai-blurb-tag">AI explainer</span>
                </div>
                <p>{detail.ai_blurb}</p>
              </div>
            )}

            {compareWith && pB ? (
              <div style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: 12,
                marginTop: 12,
                marginBottom: 8,
              }}>
                {[{ side: p, ws: wholesaler, label: 'A' }, { side: pB, ws: compareWith.wholesaler, label: 'B' }].map(({ side, ws }) => {
                  const cheaper = (p.effective_case_price ?? 0) === (pB.effective_case_price ?? 0)
                    ? null
                    : (side === p
                        ? (p.effective_case_price! < pB.effective_case_price! ? 'cheaper' : null)
                        : (pB.effective_case_price! < p.effective_case_price! ? 'cheaper' : null));
                  return (
                    <div key={ws} className="panel" style={{ padding: 12, borderColor: cheaper === 'cheaper' ? 'var(--green)' : undefined }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <strong>{distributorName(ws)}</strong>
                        {cheaper === 'cheaper' && (
                          <span className="tag tag-green" style={{ fontSize: 10 }}>CHEAPER</span>
                        )}
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>
                        {side.product_name}
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, fontSize: 13 }}>
                        <div><strong>Case (Btl) Cost:</strong> ${side.frontline_case_price?.toFixed(2)}{Number(side.unit_qty) > 1 ? <span className="text-muted" style={{ fontWeight: 400 }}> (${side.frontline_unit_price?.toFixed(2)}/btl)</span> : ''}</div>
                        <div><strong>Best Disc:</strong> {side.has_discount ? <span className="text-green">${side.total_savings_per_case}/cs</span> : '—'}</div>
                        <div>
                          <strong>Case Cost after RIP:</strong>{' '}
                          <span className="text-green font-bold">
                            ${side.effective_case_price?.toFixed(2)}
                          </span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="detail-grid" style={{ marginTop: 12 }}>
                {/* Frontline / list, bottle-first with case in parens. */}
                <div><strong>Bottle (Case) Cost:</strong>{' '}
                  {Number(p.unit_qty) > 1
                    ? <>${p.frontline_unit_price}/btl <span className="text-muted" style={{ fontWeight: 400 }}>(${p.frontline_case_price}/cs)</span></>
                    : <>${p.frontline_case_price} <span className="text-muted" style={{ fontWeight: 400 }}>(single unit)</span></>}
                </div>
                {Number(p.unit_qty) > 1 && <div><strong>Bottle Cost:</strong> ${p.frontline_unit_price}</div>}
                <div><strong>Best Discount:</strong> {p.has_discount ? <span className="text-green">${p.total_savings_per_case}/case</span> : '—'}</div>
                {/* Case cost after the case (CPL) discount, before RIP — highlighted. */}
                {(() => {
                  const caseAfterDisc = (p.best_case_price && p.best_case_price > 0) ? p.best_case_price : p.frontline_case_price;
                  return (
                    <div style={{ background: 'color-mix(in srgb, var(--accent) 10%, var(--bg))', padding: '3px 8px', borderRadius: 6 }}>
                      <strong>Case Cost:</strong> ${caseAfterDisc}
                      {Number(p.unit_qty) > 1 && <span className="text-muted" style={{ fontWeight: 400 }}> (${(caseAfterDisc / Number(p.unit_qty)).toFixed(2)}/btl)</span>}
                      <span className="text-muted" style={{ fontWeight: 400 }}> (after 1-cs discount)</span>
                    </div>
                  );
                })()}
                <div className="detail-after-rip"><strong>Case Cost after RIP:</strong> ${p.effective_case_price}{Number(p.unit_qty) > 1 ? <span className="text-muted" style={{ fontWeight: 400 }}> (${(p.effective_case_price / Number(p.unit_qty)).toFixed(2)}/btl)</span> : ''}</div>
                {p.live_better_than_month && p.live_effective_case_price != null && (
                  <div className="detail-after-rip" style={{ marginTop: 2 }}>
                    <strong>Live now:</strong>{' '}
                    <span className="live-price">${p.live_effective_case_price.toFixed(2)}/cs</span>{' '}
                    <span className="live-price-strike">${p.effective_case_price}</span>{' '}
                    <span className="text-muted" style={{ fontSize: 11, fontWeight: 400 }}>
                      (a dated RIP active today beats the month price by ${(p.effective_case_price - p.live_effective_case_price).toFixed(2)}/cs)
                    </span>
                  </div>
                )}
              </div>
            )}

            {p && (() => {
              const side = (prod: typeof p, label: string, rips: typeof detail.rip_tiers, discs: typeof detail.discount_tiers) => ({
                label,
                list: prod.frontline_case_price ?? 0,
                afterDiscount: prod.best_case_price || prod.frontline_case_price || 0,
                effective: prod.effective_case_price ?? prod.frontline_case_price ?? 0,
                pack: Number(prod.unit_qty) || 0,
                ripTiers: rips ?? [],
                discountTiers: discs ?? [],
              });
              // Month-over-month: this edition vs next edition of the same SKU.
              // Auto-on whenever we have both editions loaded; the explicit
              // `months` prop is no longer required.
              const monthMode = !!effectiveMonths && !!detailNext?.product;
              // A prior-month panel is added when we successfully fetched the
              // edition before "this month" — this is what lets the user see
              // a last→this rise on products that are flat this→next (and
              // would otherwise look unchanged in the two-panel view).
              const hasPrev = !!detailPrev?.product && !!prevEd;
              let sides;
              if (monthMode && detailNext && effectiveMonths) {
                sides = [];
                if (hasPrev && detailPrev) {
                  sides.push(side(detailPrev.product, `Last month · ${monthLabel(prevEd!)}`, detailPrev.rip_tiers, detailPrev.discount_tiers));
                }
                sides.push(side(p, `This month · ${monthLabel(effectiveMonths.curr)}`, detail.rip_tiers, detail.discount_tiers));
                sides.push(side(detailNext.product, `Next month · ${monthLabel(effectiveMonths.next)}`, detailNext.rip_tiers, detailNext.discount_tiers));
              } else {
                sides = [side(p, distributorName(wholesaler), detail.rip_tiers, detail.discount_tiers)];
                if (compareWith && pB && detailB) sides.push(side(pB, distributorName(compareWith.wholesaler), detailB.rip_tiers, detailB.discount_tiers));
              }
              const hasStory = sides.some(s => s.list - s.effective > 0.01);
              if (!hasStory && !compareWith && !monthMode) return null;
              const wfColors = ['#6366f1', '#0ea5e9', '#10b981'];
              const headerNote = monthMode
                ? (hasPrev
                    ? 'last month · this month · next month — list → discount → RIP → price after RIP'
                    : 'this month vs next month — list → discount → RIP → price after RIP')
                : 'current edition — list → discount → RIP → price after RIP';
              // Shared Y ceiling so paired waterfalls are visually comparable
              // (List is the tallest bar in each). Round up to a tidy number.
              const rawMax = Math.max(...sides.map(s => s.list), 0);
              const wfMax = (() => {
                const t = rawMax * 1.05;
                if (t <= 0) return undefined;
                const mag = Math.pow(10, Math.floor(Math.log10(t)));
                return Math.ceil(t / (mag / 2)) * (mag / 2);
              })();
              return (
                <>
                  <h4>Price Breakdown <span className="text-muted" style={{ fontSize: 11, fontWeight: 400 }}>({headerNote})</span></h4>
                  <div className={`pb-waterfalls ${sides.length === 3 ? 'pb-waterfalls-three' : sides.length > 1 ? 'pb-waterfalls-two' : ''}`}>
                    {sides.map((s, i) => (
                      <div key={s.label}>
                        <div className="pb-wf-title" style={{ color: wfColors[i] }}>{s.label}</div>
                        <PriceWaterfall list={s.list} afterDiscount={s.afterDiscount} effective={s.effective} yMax={wfMax} />
                      </div>
                    ))}
                  </div>
                  <div className="pb-wf-legend">
                    <span><i style={{ background: '#2e9e6e' }} /> Total (list / price after RIP)</span>
                    <span><i style={{ background: '#e0695a' }} /> Reduction (discount / RIP)</span>
                  </div>
                  <PriceBreakdown sides={sides} />
                </>
              );
            })()}

            {ripCode && ripSiblings && ripSiblings.items.length > 0 && (() => {
              const items = ripSiblings.items;
              const hue = ripHue(ripCode);
              const bandBg = `hsl(${hue} 75% 95%)`;
              const bandFg = `hsl(${hue} 65% 28%)`;
              const bandBorder = `hsl(${hue} 60% 78%)`;
              const ripDesc = detail.rip_tiers?.[0]?.description ?? null;
              return (
                <>
                  <h4>
                    Other Products in this RIP{' '}
                    <span className="source-badge source-rip" style={{ marginLeft: 6 }}>RIP {ripCode}</span>
                    <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--text-muted)', marginLeft: 8 }}>
                      buy these together to qualify for the rebate · {items.length} item{items.length === 1 ? '' : 's'}
                    </span>
                  </h4>
                  {ripDesc && (
                    <div style={{
                      padding: '6px 10px', marginBottom: 8, borderRadius: 6, fontSize: 12,
                      background: bandBg, color: bandFg, border: `1px solid ${bandBorder}`,
                    }}>
                      {ripDesc}
                    </div>
                  )}
                  <div className="rip-siblings-list">
                    {items.map((sib, i) => {
                      const eff = sib.effective_case_price ?? sib.frontline_case_price ?? null;
                      const list = sib.frontline_case_price ?? null;
                      const saveCs = sib.total_savings_per_case ?? null;
                      return (
                        <div
                          key={`${sib.wholesaler}|${sib.upc}|${sib.unit_volume}|${i}`}
                          className="rip-sibling-row"
                          style={{ borderLeft: `4px solid hsl(${hue} 65% 55%)` }}
                        >
                          <ProductThumb src={sib.image_url ?? null} alt={sib.product_name} size={44} />
                          <div className="rip-sibling-meta">
                            <div className="rip-sibling-name">{sib.product_name}</div>
                            <div className="rip-sibling-sub">
                              {[sib.unit_volume, sib.unit_qty ? `${sib.unit_qty} btl/cs` : null, sib.upc]
                                .filter(Boolean).join(' · ')}
                            </div>
                          </div>
                          <div className="rip-sibling-price">
                            {eff != null && (
                              <div>
                                <span className="text-green font-bold">${eff.toFixed(2)}/cs</span>
                                {list != null && eff < list - 0.005 && (
                                  <span className="text-muted" style={{ textDecoration: 'line-through', marginLeft: 6, fontWeight: 400 }}>
                                    ${list.toFixed(2)}
                                  </span>
                                )}
                              </div>
                            )}
                            {saveCs != null && saveCs > 0 && (
                              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>save ${saveCs.toFixed(2)}/cs</div>
                            )}
                          </div>
                          <AddToCartButton
                            productName={sib.product_name}
                            wholesaler={sib.wholesaler}
                            upc={sib.upc ?? undefined}
                            unitVolume={sib.unit_volume ?? undefined}
                            qtyCases={1}
                          />
                        </div>
                      );
                    })}
                  </div>
                </>
              );
            })()}

            {breakdown && breakdown.editions.length > 0 && (() => {
              type RowWithWs = (typeof breakdown.editions[number]) & { _ws: string };
              const rows: RowWithWs[] = breakdown.editions.map(e => ({ ...e, _ws: wholesaler }));
              if (compareWith && breakdownB) {
                rows.push(...breakdownB.editions.map(e => ({ ...e, _ws: compareWith.wholesaler })));
              }
              const sortVal = (e: RowWithWs): string | number => {
                switch (bSort.key) {
                  case 'vintage': return e.vintage ?? '';
                  case 'distributor': return e._ws;
                  case 'frontline_case_price': return e.frontline_case_price;
                  case 'best_discount_per_case': return e.best_discount_per_case;
                  case 'best_rip_per_case': return e.best_rip_per_case;
                  case 'effective': return e.effective_case_price ?? e.frontline_case_price;
                  case 'total_save_per_case': return e.total_save_per_case;
                  default: return e.edition;
                }
              };
              const dir = bSort.dir === 'asc' ? 1 : -1;
              rows.sort((a, b) => {
                const va = sortVal(a), vb = sortVal(b);
                let c = typeof va === 'number' && typeof vb === 'number'
                  ? va - vb
                  : String(va).localeCompare(String(vb));
                if (c === 0) c = a.edition.localeCompare(b.edition) || a._ws.localeCompare(b._ws) || String(a.vintage ?? '').localeCompare(String(b.vintage ?? ''));
                return c * dir;
              });
              // Wine/sparkling reuse one UPC across vintages — surface it so a
              // price difference between editions is read as a vintage change,
              // not a real move.
              const showVintage = rows.some(r => r.vintage);
              // Cheapest effective price across all editions so each row can
              // wear a "Best deal" sticker (or a "+$X vs best" indicator) and
              // the buyer can spot at a glance whether this month or next
              // month wins without scanning the column manually.
              const effOf = (e: typeof rows[number]) => e.effective_case_price ?? e.frontline_case_price;
              const bestEff = rows.length ? Math.min(...rows.map(effOf)) : 0;
              return (
              <>
                <h4>All Editions Breakdown <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--text-muted)' }}>(click a header to sort)</span></h4>
                <div style={{ overflowX: 'auto' }}>
                  <table className="breakdown-table breakdown-sortable">
                    <thead>
                      <tr>
                        <th onClick={() => toggleSort('edition')}>Edition{sortArrow('edition')}</th>
                        {showVintage && <th onClick={() => toggleSort('vintage')}>Vintage{sortArrow('vintage')}</th>}
                        {compareWith && <th onClick={() => toggleSort('distributor')}>Distributor{sortArrow('distributor')}</th>}
                        <th className="right" onClick={() => toggleSort('frontline_case_price')}>Case Price{sortArrow('frontline_case_price')}</th>
                        <th className="right" onClick={() => toggleSort('best_discount_per_case')}>Best Disc{sortArrow('best_discount_per_case')}</th>
                        <th className="right" onClick={() => toggleSort('best_rip_per_case')}>RIP/Case{sortArrow('best_rip_per_case')}</th>
                        <th className="right" onClick={() => toggleSort('effective')}>Case Cost after RIP{sortArrow('effective')}</th>
                        <th className="right" onClick={() => toggleSort('total_save_per_case')}>Save/Case{sortArrow('total_save_per_case')}</th>
                        <th>Discount Tiers</th>
                        <th>RIP Tiers</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map(e => (
                        <tr key={e.edition + '|' + e._ws + '|' + e.upc + '|' + (e.vintage ?? '')}>
                          <td>{monthLabel(e.edition)}</td>
                          {showVintage && <td>{e.vintage ?? '—'}</td>}
                          {compareWith && (
                            <td>
                              <span className="cell-distributor-badge">{distributorName(e._ws)}</span>
                            </td>
                          )}
                          <td className="right">${e.frontline_case_price.toFixed(2)}</td>
                          <td className="right">
                            {e.best_discount_per_case > 0
                              ? <span className="text-green">${e.best_discount_per_case.toFixed(2)}</span>
                              : <span className="text-muted">&mdash;</span>}
                          </td>
                          <td className="right">
                            {e.best_rip_per_case > 0
                              ? <span className="text-green">${e.best_rip_per_case.toFixed(2)}</span>
                              : <span className="text-muted">&mdash;</span>}
                          </td>
                          <td className="right" style={{ fontWeight: 600 }}>
                            ${(e.effective_case_price ?? e.frontline_case_price).toFixed(2)}
                            {(() => {
                              // Derive pack (btl/cs) from this edition's own list prices.
                              const pack = e.frontline_unit_price && e.frontline_unit_price > 0
                                ? e.frontline_case_price / e.frontline_unit_price : 0;
                              const eff = e.effective_case_price ?? e.frontline_case_price;
                              return pack > 1
                                ? <div style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 400 }}>${(eff / pack).toFixed(2)}/btl</div>
                                : null;
                            })()}
                            {(() => {
                              // Sticker so the buyer can tell at a glance whether
                              // this edition is the cheapest, or by how much it
                              // misses the best one. Tolerance of 1c shields us
                              // from float rounding.
                              if (rows.length < 2) return null;
                              const eff = effOf(e);
                              if (eff <= bestEff + 0.01) {
                                return (
                                  <div style={{ marginTop: 3 }}>
                                    <span className="ed-best-pill" title="Cheapest effective price across all editions">★ Best deal</span>
                                  </div>
                                );
                              }
                              return (
                                <div style={{ marginTop: 3 }}>
                                  <span className="ed-vs-best-pill" title={`Best effective is $${bestEff.toFixed(2)}/cs in another edition`}>
                                    +${(eff - bestEff).toFixed(2)} vs best
                                  </span>
                                </div>
                              );
                            })()}
                          </td>
                          <td className="right">
                            {e.total_save_per_case > 0
                              ? <span className="text-green font-bold">${e.total_save_per_case.toFixed(2)}</span>
                              : <span className="text-muted">&mdash;</span>}
                          </td>
                          <td>
                            {e.discount_tiers.length === 0
                              ? <span className="text-muted">&mdash;</span>
                              : (
                                <div className="catalog-tier-badges">
                                  {e.discount_tiers.map((t, i) => (
                                    <span key={i} className="source-badge source-discount">
                                      {compactTier(t.qty, t.unit, t.amount)}
                                    </span>
                                  ))}
                                </div>
                              )}
                          </td>
                          <td>
                            {e.rip_tiers.length === 0
                              ? <span className="text-muted">&mdash;</span>
                              : (
                                <div className="catalog-tier-badges">
                                  {e.rip_tiers.map((t, i) => (
                                    <span key={i} className="source-badge source-rip">
                                      {compactTier(t.qty, t.unit, t.amount)}
                                    </span>
                                  ))}
                                </div>
                              )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
              );
            })()}

            {(() => {
              const sides = compareWith && detailB
                ? [
                    { tiers: detail.discount_tiers ?? [], label: distributorName(wholesaler), key: wholesaler },
                    { tiers: detailB.discount_tiers ?? [], label: distributorName(compareWith.wholesaler), key: compareWith.wholesaler },
                  ]
                : [{ tiers: detail.discount_tiers ?? [], label: distributorName(wholesaler), key: wholesaler }];
              const any = sides.some(s => s.tiers.length > 0);
              if (!any) return null;
              const maxTiers = Math.max(...sides.map(s => s.tiers.length), 0);
              return (
                <>
                  <h4>Discount Tiers <span className="source-badge source-discount" style={{ marginLeft: 6 }}>Discount</span></h4>
                  <div style={{ overflowX: 'auto' }}>
                    <table className="breakdown-table">
                      <thead>
                        <tr>
                          <th>Distributor</th>
                          {Array.from({ length: maxTiers }).map((_, i) => (
                            <th key={i}>Tier {i + 1}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {sides.map(s => (
                          <tr key={s.key}>
                            <td>
                              <span className="cell-distributor-badge">{s.label}</span>
                            </td>
                            {Array.from({ length: maxTiers }).map((_, i) => {
                              const t = s.tiers[i];
                              if (!t) return <td key={i}><span className="text-muted">&mdash;</span></td>;
                              return (
                                <td key={i}>
                                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{t.quantity}+</div>
                                  <div className="text-green" style={{ fontWeight: 700 }}>-${t.amount_per_case}/cs</div>
                                  <div style={{ fontSize: 11 }}>${t.price_after}/cs</div>
                                  <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                                    ROI: <strong style={{ color: 'var(--green)' }}>{t.roi_pct}%</strong>
                                  </div>
                                  <div><WinBadge tier={t} /></div>
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              );
            })()}

            {(() => {
              const sides = compareWith && detailB
                ? [
                    { tiers: detail.rip_tiers ?? [], label: distributorName(wholesaler), key: wholesaler },
                    { tiers: detailB.rip_tiers ?? [], label: distributorName(compareWith.wholesaler), key: compareWith.wholesaler },
                  ]
                : [{ tiers: detail.rip_tiers ?? [], label: distributorName(wholesaler), key: wholesaler }];
              const any = sides.some(s => s.tiers.length > 0);
              if (!any) return null;
              const maxTiers = Math.max(...sides.map(s => s.tiers.length), 0);
              return (
                <>
                  <h4>RIP Tiers <span className="source-badge source-rip" style={{ marginLeft: 6 }}>RIP</span></h4>
                  <div style={{ overflowX: 'auto' }}>
                    <table className="breakdown-table">
                      <thead>
                        <tr>
                          <th>Distributor</th>
                          <th>Description</th>
                          {Array.from({ length: maxTiers }).map((_, i) => (
                            <th key={i}>Tier {i + 1}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {sides.map(s => (
                          <tr key={s.key}>
                            <td style={{ verticalAlign: 'top' }}>
                              <span className="cell-distributor-badge">{s.label}</span>
                            </td>
                            <td className="rip-desc-cell" title={s.tiers[0]?.description ?? ''}>
                              {s.tiers[0]?.description ?? '—'}
                            </td>
                            {Array.from({ length: maxTiers }).map((_, i) => {
                              const t = s.tiers[i];
                              if (!t) return <td key={i} style={{ verticalAlign: 'top' }}><span className="text-muted">&mdash;</span></td>;
                              return (
                                <td key={i} style={{ verticalAlign: 'top', whiteSpace: 'nowrap' }}>
                                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                                    Buy {t.qty} {t.unit}
                                  </div>
                                  <div className="text-green" style={{ fontWeight: 700 }}>-${t.amount} bundle</div>
                                  <div style={{ fontSize: 11 }}>-${t.per_case_savings}/cs &middot; ${t.price_after}/cs</div>
                                  <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                                    Cost: ${t.bundle_cost} · ROI: <strong style={{ color: 'var(--green)' }}>{t.roi_pct}%</strong>
                                  </div>
                                  <div><WinBadge tier={t} /></div>
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              );
            })()}

            {history && history.history.length > 0 && (
              <>
                <h4>Price History{compareWith ? ' — Effective Cost Trend' : ''}</h4>
                <PriceChart
                  data={history.history}
                  labelA={distributorName(wholesaler)}
                  compare={compareWith && historyB
                    ? { data: historyB.history, labelB: distributorName(compareWith.wholesaler) }
                    : null}
                />
                {compareWith && historyB ? (() => {
                  // Head-to-head: compare effective cost per edition.
                  const labA = distributorName(wholesaler);
                  const labB = distributorName(compareWith.wholesaler);
                  const aBy = Object.fromEntries(history.history.map(p => [p.edition, p]));
                  const bBy = Object.fromEntries(historyB.history.map(p => [p.edition, p]));
                  const eds = Array.from(new Set([...Object.keys(aBy), ...Object.keys(bBy)])).sort();
                  let aWins = 0, bWins = 0;
                  for (const ed of eds) {
                    const a = aBy[ed]?.effective_case_price, b = bBy[ed]?.effective_case_price;
                    if (a == null || b == null) continue;
                    if (a < b) aWins++; else if (b < a) bWins++;
                  }
                  const latestEd = eds[eds.length - 1];
                  const la = aBy[latestEd]?.effective_case_price, lb = bBy[latestEd]?.effective_case_price;
                  const gap = (la != null && lb != null) ? Math.abs(la - lb) : null;
                  const cheaperNow = (la != null && lb != null) ? (la < lb ? labA : lb < la ? labB : 'Tie') : '—';
                  return (
                    <div className="price-story">
                      <span className="price-stat">
                        <span className="price-stat-label">Cheaper now</span>
                        <span className="price-stat-val text-green">{cheaperNow}{gap && gap > 0 ? ` · $${gap.toFixed(2)}` : ''}</span>
                      </span>
                      <span className="price-stat">
                        <span className="price-stat-label">{labA} cheaper</span>
                        <span className="price-stat-val">{aWins} / {eds.length} mo</span>
                      </span>
                      <span className="price-stat">
                        <span className="price-stat-label">{labB} cheaper</span>
                        <span className="price-stat-val">{bWins} / {eds.length} mo</span>
                      </span>
                      <span className="price-stat">
                        <span className="price-stat-label">{labA} now</span>
                        <span className="price-stat-val">{la != null ? `$${la.toFixed(2)}` : '—'}</span>
                      </span>
                      <span className="price-stat">
                        <span className="price-stat-label">{labB} now</span>
                        <span className="price-stat-val">{lb != null ? `$${lb.toFixed(2)}` : '—'}</span>
                      </span>
                    </div>
                  );
                })() : (() => {
                  const h = history.history;
                  const best = h.reduce((a, b) => (b.effective_case_price < a.effective_case_price ? b : a), h[0]);
                  const saver = h.reduce((a, b) => {
                    const sa = a.frontline_case_price - a.effective_case_price;
                    const sb = b.frontline_case_price - b.effective_case_price;
                    return sb > sa ? b : a;
                  }, h[0]);
                  const maxSave = saver.frontline_case_price - saver.effective_case_price;
                  const latest = h[h.length - 1];
                  const ml = (ym: string) => monthLabel(ym).replace(/ \d{4}$/, '');
                  // When every month has the same effective price / savings there is
                  // no single "best" month — don't arbitrarily name one.
                  const effs = h.map(p => p.effective_case_price);
                  const effFlat = h.length > 1 && Math.max(...effs) - Math.min(...effs) < 0.01;
                  const saves = h.map(p => p.frontline_case_price - p.effective_case_price);
                  const saveFlat = h.length > 1 && Math.max(...saves) - Math.min(...saves) < 0.01;
                  const trendTone = history.stats?.trend === 'rising' ? 'text-red'
                    : history.stats?.trend === 'falling' ? 'text-green' : '';
                  return (
                    <div className="price-story">
                      <span className="price-stat">
                        <span className="price-stat-label">Trend</span>
                        <span className={`price-stat-val ${trendTone}`}>{history.stats?.trend ?? '—'}</span>
                      </span>
                      <span className="price-stat">
                        <span className="price-stat-label">Best month</span>
                        <span className="price-stat-val text-green">
                          {effFlat ? `Any · $${best.effective_case_price.toFixed(2)}` : `${ml(best.edition)} · $${best.effective_case_price.toFixed(2)}`}
                        </span>
                      </span>
                      <span className="price-stat">
                        <span className="price-stat-label">Biggest savings</span>
                        <span className="price-stat-val text-green">{maxSave > 0 ? `$${maxSave.toFixed(2)}/cs ${saveFlat ? '(every month)' : `(${ml(saver.edition)})`}` : '—'}</span>
                      </span>
                      <span className="price-stat">
                        <span className="price-stat-label">Now vs list</span>
                        <span className="price-stat-val">
                          ${latest.effective_case_price.toFixed(2)}
                          {latest.effective_case_price < latest.frontline_case_price && (
                            <span className="text-muted" style={{ textDecoration: 'line-through', marginLeft: 6, fontWeight: 400 }}>
                              ${latest.frontline_case_price.toFixed(2)}
                            </span>
                          )}
                        </span>
                      </span>
                      <span className="price-stat">
                        <span className="price-stat-label">Range</span>
                        <span className="price-stat-val">${history.stats?.min_price}–${history.stats?.max_price}</span>
                      </span>
                    </div>
                  );
                })()}
              </>
            )}

            <ProductNotes wholesaler={wholesaler} productName={productName} />
          </>
        )}
      </div>
    </div>
  );
}

function ProductNotes({ wholesaler, productName }: { wholesaler: string; productName: string }) {
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const { data: list } = useQuery({
    queryKey: ['notes', wholesaler, productName],
    queryFn: () => notes.forProduct(wholesaler, productName),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['notes'] }); // refreshes this + dashboard tile
  const addMut = useMutation({
    mutationFn: () => notes.add({ product_name: productName, wholesaler, note: text.trim() }),
    onSuccess: () => { refresh(); setText(''); },
  });
  const removeMut = useMutation({
    mutationFn: (id: number) => notes.remove(id),
    onSuccess: refresh,
  });
  const items = list ?? [];
  return (
    <>
      <h4>Notes</h4>
      <div className="pv-notes">
        {items.length === 0 && <p className="text-muted" style={{ fontSize: 12, margin: '2px 0 8px' }}>No notes yet for this product.</p>}
        {items.map(n => (
          <div key={n.id} className="pv-note">
            <span>{n.note}</span>
            <button className="btn-icon" title="Delete note" onClick={() => removeMut.mutate(n.id)}>
              <Trash2 size={14} />
            </button>
          </div>
        ))}
        <div className="pv-note-add">
          <textarea
            value={text}
            onChange={e => setText(e.target.value)}
            placeholder="Add a note about this product..."
            rows={2}
          />
          <button className="btn btn-sm" disabled={!text.trim() || addMut.isPending} onClick={() => addMut.mutate()}>
            {addMut.isPending ? 'Saving...' : 'Add note'}
          </button>
        </div>
      </div>
    </>
  );
}
