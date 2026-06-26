/**
 * Two small sparklines per product, each tracking the last 3 EXISTING editions
 * (no future month is invented):
 *   - "1cs"  = case price after the 1-case (entry) CPL discount, no RIP
 *   - "RIP"  = best effective price with the best RIP applied
 * Hovering either chip reveals a popover with one month-block per edition; every
 * price is shown as case AND bottle (with the bottle size in brackets), e.g.
 * "$148.00/cs · $19.00 (750mL)".
 *
 * Pinning + drag: clicking the popover pins it (stays after mouseleave) and
 * makes it a draggable position:fixed panel. The hover popover is also
 * position:fixed anchored to the chip so it never gets clipped by a parent
 * table's overflow-x:auto.
 */
import { useRef, useState, useEffect, useLayoutEffect } from 'react';
import type { TierWindow } from '../lib/api';
import { windowBadge } from '../lib/dealDates';

export interface RipTier extends TierWindow {
  qty: number;
  unit: string;
  eff: number;
  // RIP tiers only: the per-case rebate this tier contributes (excludes the
  // stacked CPL discount). Used as the "this tier saves" number.
  ripOnlySave?: number | null;
  // Partial-month (time-sensitive) window marker.
  ts?: boolean;
  // RIP code this tier belongs to — lets the ladder group tiers by program so
  // two RIPs on one UPC don't read as one jumbled pile.
  code?: string | null;
  // Case-credit model (FOUNDATION 3.4.1): the REAL physical buy-in when a
  // half-case rule matched (qty stays the printed/qualifying quantity).
  qualifiedCases?: number | null;
  caseCredit?: number | null;
  // RIP sheet free-text (column M, rip_description) — the program scope: the
  // sizes/packs it covers and any "INCLUDES …" value-add note. Shown as the
  // SIZES cell in the product-detail RIP panel.
  description?: string | null;
}

export interface MonthBreakdown {
  edition: string | null;
  frontline: number | null;
  afterDiscount: number | null;   // best price after CPL discount (single number)
  discountTiers?: RipTier[];
  ripTiers: RipTier[];
  bestEff: number | null;         // best-RIP price -> the "RIP" sparkline series
  disc1?: number | null;          // 1-case-discount price -> the "1cs" series
  pack?: number | null;           // bottles per case (for $/btl)
  size?: string | null;           // unit_volume, shown in the bottle-price brackets
  future?: boolean;               // next-month preview (loaded early): on the chart, off the ladder
}

/** The block ladders/stickers treat as the current month: the newest block
 *  that is NOT a future (next-month preview) edition; falls back to the newest.
 *  The sparkline itself still plots every block, including the future one. */
export function currentMonth(months: MonthBreakdown[]): MonthBreakdown | null {
  if (!months || months.length === 0) return null;
  for (let i = months.length - 1; i >= 0; i--) if (!months[i].future) return months[i];
  return months[months.length - 1];
}

interface Props {
  /** Up to 3 month-blocks, oldest -> newest. */
  months: MonthBreakdown[];
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function fmtMonth(ed: string | null): string {
  if (!ed) return '';
  const m = /^(\d{4})-(\d{1,2})/.exec(ed);
  if (!m) return ed;
  return `${MONTHS[parseInt(m[2], 10) - 1] ?? ''} ${m[1]}`.trim();
}

// Inline window-status badge for a single tier (Active now / Expires / Starts).
function TierWin({ t }: { t: RipTier }) {
  const wb = windowBadge(t);
  if (wb) return <span className={`win-badge ${wb.cls}${wb.urgent ? ' urgent' : ''}`}>{wb.label}</span>;
  if (t.ts) return <span className="mes-ts-badge" title="Time-sensitive: window is not a full month. Not counted in effective price.">TS</span>;
  return null;
}

// One small N-point line for a monthly series. Colour reads from the buyer's
// view of the HISTORY: price lower now than 3 months ago = green (good), higher
// = red, flat = grey. Missing months are skipped (no future month invented).
function Chip({ values, futures, label, title }: { values: (number | null | undefined)[]; futures?: boolean[]; label: string; title: string }) {
  const real = values
    .map((v, i) => ({ v, i }))
    .filter((p): p is { v: number; i: number } => p.v != null);
  if (real.length === 0) return null;
  const W = 96, H = 38, PAD = 7, TOP = 6, BOTTOM = 23;
  const n = Math.max(values.length, 1);
  const xs = (i: number) => (n <= 1 ? W / 2 : PAD + (i / (n - 1)) * (W - 2 * PAD));
  const vals = real.map(p => p.v);
  const min = Math.min(...vals), max = Math.max(...vals), range = Math.max(max - min, 0.01);
  const ys = (v: number) => BOTTOM - ((v - min) / range) * (BOTTOM - TOP);
  // The HEADLINE number is the CURRENT month — the newest NON-future point. A
  // next-month edition loaded early is plotted as a trailing point but must not
  // become the headline (it would show next month's price as "now"). Falls back
  // to the latest real point if every point is future.
  const curPt = (() => {
    for (let k = real.length - 1; k >= 0; k--) {
      if (!(futures && futures[real[k].i])) return real[k];
    }
    return real[real.length - 1];
  })();
  const headVal = curPt.v, oldest = vals[0];
  // Cheaper now than 3 months ago = green (compare the CURRENT point, not a
  // future preview, to the oldest).
  const colour = headVal < oldest - 0.005 ? '#16a34a' : headVal > oldest + 0.005 ? '#dc2626' : '#6b7280';
  const poly = real.map(p => `${xs(p.i).toFixed(1)},${ys(p.v).toFixed(1)}`).join(' ');
  return (
    <span className="mes-chip2" title={title}>
      <svg width={W} height={H} aria-hidden>
        {real.length > 1 && <polyline points={poly} fill="none" stroke={colour} strokeWidth={1.75} />}
        {real.map(p => <circle key={p.i} cx={xs(p.i)} cy={ys(p.v)} r={2.4}
          fill={futures && futures[p.i] ? '#fff' : colour} stroke={colour} strokeWidth={futures && futures[p.i] ? 1.2 : 0} />)}
        <text x={2} y={H - 4} fontSize="9.5" fontWeight="600" fill="var(--text-muted, #64748b)">{label}</text>
        <text x={W - 2} y={H - 4} fontSize="10" fontWeight="700" fill={colour} textAnchor="end">${headVal.toFixed(0)}</text>
      </svg>
    </span>
  );
}

function MonthBlock({ b }: { b: MonthBreakdown }) {
  const hasDiscTiers = (b.discountTiers ?? []).length > 0;
  const showDiscSummary = !hasDiscTiers
    && b.afterDiscount != null
    && b.frontline != null
    && b.afterDiscount < b.frontline - 0.005;
  const ripVsDisc = b.afterDiscount ?? b.frontline ?? null;
  const sortedDisc = [...(b.discountTiers ?? [])].sort((a, c) => a.qty - c.qty);
  const sortedRip = [...b.ripTiers].sort((a, c) => (a.ripOnlySave ?? 0) - (c.ripOnlySave ?? 0) || a.qty - c.qty);
  const bestDiscEff = sortedDisc.length ? Math.min(...sortedDisc.map(t => t.eff)) : null;
  const bestRipEff = sortedRip.length ? Math.min(...sortedRip.map(t => t.eff)) : null;

  const tierLabel = (t: RipTier) => `Buy ${t.qty} ${/^\s*b/i.test(t.unit) ? 'btl' : 'cs'}`;
  const dollars = (n: number) => `$${n.toFixed(2)}`;
  // Always show BOTH case and bottle, the bottle with its size in brackets.
  const priceCB = (caseVal: number | null | undefined) => {
    if (caseVal == null) return <>&mdash;</>;
    const cs = <strong>${caseVal.toFixed(2)}/cs</strong>;
    if (b.pack && b.pack > 0) {
      const btl = (caseVal / b.pack).toFixed(2);
      return <>{cs} <span className="mes-btl">&middot; ${btl}{b.size ? ` (${b.size})` : '/btl'}</span></>;
    }
    return cs;
  };

  return (
    <div className="mes-block">
      <div className="mes-block-head">{fmtMonth(b.edition) || 'Month'}{b.future ? ' · next' : ''}</div>
      <table className="mes-table">
        <tbody>
          <tr><td>Frontline</td><td className="mes-num">{priceCB(b.frontline)}</td></tr>

          {hasDiscTiers && b.frontline != null && (
            <>
              <tr className="mes-section"><td colSpan={2}><span className="mes-section-pill is-discount">Discount</span></td></tr>
              {sortedDisc.map((t, i) => {
                const save = b.frontline! - t.eff;
                const isBest = t.eff === bestDiscEff;
                return (
                  <tr key={`d${i}`} className={`${isBest ? 'mes-row-best' : ''} ${t.ts ? 'mes-row-ts' : ''}`}>
                    <td>{tierLabel(t)}{' '}<TierWin t={t} /></td>
                    <td className="mes-num">
                      <span className="mes-save">−{dollars(save)}</span>
                      <span className="mes-arrow"> = </span>
                      {priceCB(t.eff)}
                    </td>
                  </tr>
                );
              })}
            </>
          )}
          {showDiscSummary && (
            <>
              <tr className="mes-section"><td colSpan={2}><span className="mes-section-pill is-discount">Discount</span></td></tr>
              <tr className="mes-row-best">
                <td>applied</td>
                <td className="mes-num">
                  <span className="mes-save">−{dollars(b.frontline! - b.afterDiscount!)}</span>
                  <span className="mes-arrow"> = </span>
                  {priceCB(b.afterDiscount!)}
                </td>
              </tr>
            </>
          )}

          {b.ripTiers.length > 0 && ripVsDisc != null && (
            <>
              <tr className="mes-section"><td colSpan={2}><span className="mes-section-pill is-rip">RIP {hasDiscTiers || showDiscSummary ? '(stacks)' : ''}</span></td></tr>
              {sortedRip.map((t, i) => {
                const save = (t.ripOnlySave != null && Number.isFinite(t.ripOnlySave))
                  ? Number(t.ripOnlySave)
                  : (ripVsDisc != null && b.frontline != null
                      ? (b.frontline - t.eff) - (b.frontline - ripVsDisc)
                      : 0);
                const isBest = t.eff === bestRipEff;
                return (
                  <tr key={`r${i}`} className={`${isBest ? 'mes-row-best' : ''} ${t.ts ? 'mes-row-ts' : ''}`}>
                    <td>{tierLabel(t)}{' '}<TierWin t={t} /></td>
                    <td className="mes-num">
                      <span className="mes-save">−{dollars(Math.max(0, save))}</span>
                      <span className="mes-arrow"> = </span>
                      {priceCB(t.eff)}
                    </td>
                  </tr>
                );
              })}
            </>
          )}

          <tr className="mes-best">
            <td>Best</td>
            <td className="mes-num">{priceCB(b.bestEff)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/** Short prose comparing the two newest existing months. */
function ComparisonSummary({ prior, latest, labP, labL }:
  { prior: MonthBreakdown; latest: MonthBreakdown; labP: string; labL: string }) {
  const lines: { text: string; important: boolean }[] = [];
  const dollars = (n: number) => `$${Math.abs(n).toFixed(2)}`;
  if (prior.bestEff != null && latest.bestEff != null) {
    const d = latest.bestEff - prior.bestEff;
    if (Math.abs(d) < 0.01) lines.push({ text: `Best price held at ${dollars(latest.bestEff)}/cs from ${labP} to ${labL}.`, important: false });
    else if (d < 0) lines.push({ text: `Best price fell ${dollars(d)}/cs from ${labP} to ${labL} (now ${dollars(latest.bestEff)}/cs).`, important: true });
    else lines.push({ text: `Best price rose ${dollars(d)}/cs from ${labP} to ${labL} (now ${dollars(latest.bestEff)}/cs).`, important: true });
  }
  if (prior.disc1 != null && latest.disc1 != null) {
    const d = latest.disc1 - prior.disc1;
    if (Math.abs(d) >= 0.01) lines.push({ text: `1-case price ${d < 0 ? 'dropped' : 'rose'} ${dollars(d)}/cs vs ${labP}.`, important: false });
  }
  if (lines.length === 0) return null;
  return (
    <div className="mes-summary">
      <div className="mes-summary-head">What it means</div>
      <ul className="mes-summary-list">
        {lines.map((l, i) => <li key={i} className={l.important ? 'mes-summary-important' : undefined}>{l.text}</li>)}
      </ul>
    </div>
  );
}

export default function MonthEffectiveSparkline({ months }: Props) {
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const popRef = useRef<HTMLSpanElement | null>(null);
  const [placeBelow, setPlaceBelow] = useState(false);
  // Chip rect captured on hover; the hover popover renders position:fixed
  // anchored to it so it escapes any parent overflow:auto clip.
  const [hoverRect, setHoverRect] = useState<DOMRect | null>(null);
  // Final clamped position, computed from the MEASURED popover size (the
  // popover can be 3 stacked month blocks tall, so a fixed flip threshold
  // is never right). Keeps the whole box inside the viewport and reserves
  // a right-edge gutter so the window's vertical scrollbar stays reachable.
  const [hoverPos, setHoverPos] = useState<{ left: number; top: number } | null>(null);
  const [pinned, setPinned] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);

  const onWrapEnter = () => {
    if (pinned) return;
    const el = wrapRef.current;
    if (!el) return;
    setHoverRect(el.getBoundingClientRect());
  };

  // Measure-and-clamp, before paint so there is no jump. Above the chip when
  // it fits, otherwise below; then clamp into the viewport with an 8px margin
  // and a 28px right gutter (the window scrollbar must never be covered).
  useLayoutEffect(() => {
    if (!hoverRect || pinned) return;
    const el = popRef.current;
    if (!el) return;
    const M = 8, GUTTER = 28;
    const W = el.offsetWidth, H = el.offsetHeight;
    const vw = window.innerWidth, vh = window.innerHeight;
    const below = hoverRect.top - M - H < M;
    let left = hoverRect.left + hoverRect.width / 2 - W / 2;
    left = Math.max(M, Math.min(left, vw - GUTTER - W));
    let top = below ? hoverRect.bottom + M : hoverRect.top - M - H;
    top = Math.max(M, Math.min(top, vh - M - H));
    setPlaceBelow(below);
    setHoverPos({ left, top });
  }, [hoverRect, pinned]);

  const onPopMouseDown = (e: React.MouseEvent<HTMLSpanElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest('.mes-popover-close')) return;
    const el = popRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    dragRef.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    setPinned(true);
    setPos({ x: rect.left, y: rect.top });
    e.preventDefault();
  };

  useEffect(() => {
    if (!pinned) return;
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      setPos({ x: e.clientX - d.dx, y: e.clientY - d.dy });
    };
    const onUp = () => { dragRef.current = null; };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closePinned(); };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('keydown', onKey);
    };
  }, [pinned]);

  const closePinned = () => { setPinned(false); setPos(null); dragRef.current = null; };

  // The two chips read from their OWN tier type so each is honest: the QD chip
  // is the best quantity-discount price (deepest non-time-sensitive discount
  // tier), the RIP chip is the best RIP price (deepest RIP tier). On a product
  // with no RIP the RIP chip is empty rather than echoing the QD-driven
  // effective price (which read as a wrong/"hardcoded" RIP number).
  const qdOf = (m: MonthBreakdown): number | null => {
    const ds = (m.discountTiers ?? []).filter(t => !t.ts && t.eff > 0);
    return ds.length ? Math.min(...ds.map(t => t.eff)) : null;
  };
  const ripOf = (m: MonthBreakdown): number | null => {
    const rs = (m.ripTiers ?? []).filter(t => t.eff > 0);
    return rs.length ? Math.min(...rs.map(t => t.eff)) : null;
  };

  // Backend feeds oldest -> newest. The CHART reads left -> right in time
  // (Apr, May, Jun) like any price chart; the POPOVER lists newest first
  // (Jun, May, Apr) so the current month is the first thing the buyer reads.
  const chrono = (months ?? []).filter(m => qdOf(m) != null || ripOf(m) != null || m.frontline != null);
  const blocks = [...chrono].reverse();   // newest-first, popover + summary
  if (blocks.length === 0) return null;

  const popStyle: React.CSSProperties | undefined = pinned && pos
    ? { position: 'fixed', left: pos.x, top: pos.y, transform: 'none', bottom: 'auto' }
    : hoverRect && hoverPos
      ? { position: 'fixed', left: hoverPos.left, top: hoverPos.top, bottom: 'auto', transform: 'none' }
      : hoverRect
        ? (placeBelow
            ? { position: 'fixed', left: hoverRect.left + hoverRect.width / 2, top: hoverRect.bottom + 8, bottom: 'auto', transform: 'translateX(-50%)' }
            : { position: 'fixed', left: hoverRect.left + hoverRect.width / 2, top: hoverRect.top - 8, bottom: 'auto', transform: 'translate(-50%, -100%)' })
        : undefined;

  // Newest-first: latest = blocks[0], prior = the month behind it.
  const latest = blocks[0];
  const prior = blocks.length >= 2 ? blocks[1] : null;

  return (
    <span className={`mes-wrap${placeBelow ? ' mes-wrap-below' : ''}${pinned ? ' mes-wrap-pinned' : ''}`}
          ref={wrapRef} onMouseEnter={onWrapEnter}>
      <span className="mes-chips2">
        <Chip values={chrono.map(qdOf)} futures={chrono.map(m => !!m.future)} label="QD" title="Best price after quantity discount, last 3 months" />
        <Chip values={chrono.map(ripOf)} futures={chrono.map(m => !!m.future)} label="RIP" title="Best price after RIP rebate, last 3 months" />
        {/* Month-name stickers under the chips, chronological (Apr, May, Jun)
            to match the chip points, so the buyer can read which point is which. */}
        <span className="mes-months">
          {chrono.map((m, i) => {
            const mm = /^(\d{4})-(\d{1,2})/.exec(m.edition ?? '');
            const lab = mm ? (MONTHS[parseInt(mm[2], 10) - 1] ?? '') : '';
            return <span key={i} className={`mes-month-sticker${m.future ? ' mes-month-next' : ''}`}
              title={m.future ? 'Next month (loaded early)' : undefined}>{lab}{m.future ? '*' : ''}</span>;
          })}
        </span>
      </span>
      <span className={`mes-popover${pinned ? ' mes-popover-pinned' : ''}`}
            role={pinned ? 'dialog' : 'tooltip'}
            ref={popRef}
            style={popStyle}
            onMouseDown={onPopMouseDown}>
        {pinned && (
          <button type="button" className="mes-popover-close" aria-label="Close" title="Close (Esc)"
                  onMouseDown={e => e.stopPropagation()}
                  onClick={closePinned}>×</button>
        )}
        <div className="mes-blocks">
          {blocks.map((m, i) => <MonthBlock key={i} b={m} />)}
        </div>
        {prior && (
          <ComparisonSummary prior={prior} latest={latest}
            labP={(fmtMonth(prior.edition).split(' ')[0]) || 'prior'}
            labL={(fmtMonth(latest.edition).split(' ')[0]) || 'now'} />
        )}
      </span>
    </span>
  );
}
