/**
 * Two-point sparkline (this month -> next month) showing the best effective
 * case price per product, used by RIP Products and the Catalog. Hovering
 * the sparkline reveals a structured popover with Frontline -> After Discount
 * -> RIP Tiers for both months side by side. Hover target is the entire
 * coloured chip so it's easy to land on; the popover renders above the chip
 * with a small arrow tail (or flips below when there isn't room above).
 *
 * Pinning + drag: clicking anywhere on the popover "pins" it so it stays
 * visible after mouseleave AND becomes freely draggable to anywhere on the
 * screen. A small X button in the header dismisses and resets to the
 * default chip-anchored position.
 */
import { useRef, useState, useEffect } from 'react';

export interface RipTier {
  qty: number;
  unit: string;
  eff: number;
  // RIP tiers only: the per-case rebate amount the RIP itself contributes
  // at this tier (excluding the stacked CPL discount that auto-applies).
  // When present, the popover shows this as the savings number for the row
  // — that's what "this RIP tier saves" actually means. Without it the
  // popover would fall back to (best-discount-price − this-tier-price),
  // which produces a meaningless negative for early RIP tiers that don't
  // beat the deepest CPL discount alone.
  ripOnlySave?: number | null;
  // True when this tier's source row has a partial-month validity window
  // (time-sensitive). Rendered with a small "TS" marker; derive.py has
  // already excluded these from effective_case_price.
  ts?: boolean;
}

export interface MonthBreakdown {
  edition: string | null;
  frontline: number | null;
  afterDiscount: number | null;   // best price after CPL discount, before RIP (single number)
  discountTiers?: RipTier[];      // every CPL discount option for this month (optional detail)
  ripTiers: RipTier[];            // every RIP option for this month
  bestEff: number | null;         // headline price the sparkline plots
}

interface Props {
  curr: MonthBreakdown;
  next: MonthBreakdown;
}

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function fmtMonth(ed: string | null): string {
  if (!ed) return '';
  const m = /^(\d{4})-(\d{1,2})/.exec(ed);
  if (!m) return ed;
  return `${MONTHS[parseInt(m[2], 10) - 1] ?? ''} ${m[1]}`.trim();
}

const fmt = (v: number | null) => v == null ? '—' : `$${v.toFixed(2)}/cs`;

function MonthBlock({ label, short, b }: { label: string; short?: string; b: MonthBreakdown }) {
  const hasDiscTiers = (b.discountTiers ?? []).length > 0;
  const showDiscSummary = !hasDiscTiers
    && b.afterDiscount != null
    && b.frontline != null
    && b.afterDiscount < b.frontline - 0.005;
  // Show savings amounts AND the calculation, so the buyer reads
  // "frontline - discount - RIP = effective" instead of just the end
  // prices. Discount savings are vs frontline; RIP savings stack on
  // top of the best applicable discount, so they're vs afterDiscount.
  // Rows render in ascending qty order so the smallest commitment
  // reads first (10 cs before 25 cs, 5 cs before 50 cs). The "best"
  // green highlight still marks the lowest effective price.
  const ripVsDisc = b.afterDiscount ?? b.frontline ?? null;
  const sortedDisc = [...(b.discountTiers ?? [])].sort((a, c) => a.qty - c.qty);
  const sortedRip = [...b.ripTiers].sort((a, c) => a.qty - c.qty);
  const bestDiscEff = sortedDisc.length
    ? Math.min(...sortedDisc.map(t => t.eff))
    : null;
  const bestRipEff = sortedRip.length
    ? Math.min(...sortedRip.map(t => t.eff))
    : null;

  const tierLabel = (t: RipTier) => `Buy ${t.qty} ${/btl|bottle/i.test(t.unit) ? 'btl' : 'cs'}`;
  const dollars = (n: number) => `$${n.toFixed(2)}`;

  return (
    <div className="mes-block">
      <div className="mes-block-head">{label}</div>
      <table className="mes-table">
        <tbody>
          <tr><td>Frontline</td><td className="mes-num">{fmt(b.frontline)}</td></tr>

          {hasDiscTiers && b.frontline != null && (
            <>
              <tr className="mes-section"><td colSpan={2}><span className="mes-section-pill is-discount">Discount</span></td></tr>
              {sortedDisc.map((t, i) => {
                const save = b.frontline! - t.eff;
                const isBest = t.eff === bestDiscEff;
                return (
                  <tr key={`d${i}`} className={`${isBest ? 'mes-row-best' : ''} ${t.ts ? 'mes-row-ts' : ''}`}>
                    <td>
                      {tierLabel(t)}
                      {t.ts && <span className="mes-ts-badge" title="Time-sensitive: window is not a full month. Not counted in effective price.">TS</span>}
                    </td>
                    <td className="mes-num">
                      <span className="mes-save">−{dollars(save)}</span>
                      <span className="mes-arrow"> = </span>
                      <strong>{dollars(t.eff)}</strong>
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
                  <strong>{dollars(b.afterDiscount!)}</strong>
                </td>
              </tr>
            </>
          )}

          {b.ripTiers.length > 0 && ripVsDisc != null && (
            <>
              <tr className="mes-section"><td colSpan={2}><span className="mes-section-pill is-rip">RIP {hasDiscTiers || showDiscSummary ? '(stacks)' : ''}</span></td></tr>
              {sortedRip.map((t, i) => {
                // The per-tier RIP rebate (canonical, from the backend) is
                // the only correct delta for THIS row — that's what the RIP
                // itself contributes. Falling back to (best-disc-price −
                // this-eff) was the old bug: early RIP tiers don't beat the
                // deepest CPL discount alone, so the diff came out negative
                // and rendered as "−$−24" through the "−$X" template.
                const save = (t.ripOnlySave != null && Number.isFinite(t.ripOnlySave))
                  ? Number(t.ripOnlySave)
                  : (ripVsDisc != null && b.frontline != null
                      ? (b.frontline - t.eff) - (b.frontline - ripVsDisc)
                      : 0);
                const isBest = t.eff === bestRipEff;
                return (
                  <tr key={`r${i}`} className={`${isBest ? 'mes-row-best' : ''} ${t.ts ? 'mes-row-ts' : ''}`}>
                    <td>
                      {tierLabel(t)}
                      {t.ts && <span className="mes-ts-badge" title="Time-sensitive: window is not a full month. Not counted in effective price.">TS</span>}
                    </td>
                    <td className="mes-num">
                      <span className="mes-save">−{dollars(Math.max(0, save))}</span>
                      <span className="mes-arrow"> = </span>
                      <strong>{dollars(t.eff)}</strong>
                    </td>
                  </tr>
                );
              })}
            </>
          )}

          <tr className="mes-best">
            {/* Prefix the month so a reader scanning side-by-side knows which
                column's best they're looking at ("May Best" vs "Jun Best"). */}
            <td>{short ? `${short} Best` : 'Best'}</td>
            <td className="mes-num">{fmt(b.bestEff)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/**
 * Plain-English comparison of the curr and next month tier ladders. Helps the
 * buyer read the popover without doing math: which qtys are unchanged, which
 * qty exists in only one month, and where the best price actually changed.
 *
 * Per tier qty (separately for discount and RIP), one of four classifications:
 *   - same     : both months offer the same effective at this qty
 *   - differs  : both months offer this qty, but eff differs (-> who wins, by $)
 *   - only-cur : qty only exists in curr (-> only available this month)
 *   - only-nxt : qty only exists in next (-> only available next month)
 *
 * Output is at most three short lines: (1) headline best-price comparison,
 * (2) groups of "same" qtys, (3) any per-qty advantages. Pure prose so a
 * buyer's eye doesn't have to map tier rows side-by-side.
 */
function ComparisonSummary({
  curr, next, labC, labN,
}: { curr: MonthBreakdown; next: MonthBreakdown; labC: string; labN: string }) {
  type Buckets = { same: number[]; differs: { qty: number; cur: number; nxt: number }[]; onlyCur: number[]; onlyNxt: number[] };
  const empty = (): Buckets => ({ same: [], differs: [], onlyCur: [], onlyNxt: [] });

  function classify(curTiers: RipTier[], nxtTiers: RipTier[]): Buckets {
    const cMap = new Map(curTiers.map(t => [t.qty, t.eff]));
    const nMap = new Map(nxtTiers.map(t => [t.qty, t.eff]));
    const qtys = Array.from(new Set([...cMap.keys(), ...nMap.keys()])).sort((a, b) => a - b);
    const b = empty();
    for (const q of qtys) {
      const c = cMap.get(q), n = nMap.get(q);
      if (c != null && n != null) {
        if (Math.abs(c - n) < 0.01) b.same.push(q);
        else b.differs.push({ qty: q, cur: c, nxt: n });
      } else if (c != null) b.onlyCur.push(q);
      else if (n != null) b.onlyNxt.push(q);
    }
    return b;
  }

  const disc = classify(curr.discountTiers ?? [], next.discountTiers ?? []);
  const rip = classify(curr.ripTiers, next.ripTiers);
  const dollars = (n: number) => `$${Math.abs(n).toFixed(2)}`;
  const csList = (qs: number[]) => qs.map(q => `${q}cs`).join(' / ');

  // Each line tagged as `important` when it's a CRITICAL difference the buyer
  // must act on (best-price gap, tier present in only one month, tier value
  // differs). Same-both-months and zero-gap lines are confirmation noise; we
  // still render them for completeness but in normal weight. The CSS renders
  // important lines in bold so the eye finds them.
  type Line = { text: string; important: boolean };
  const lines: Line[] = [];

  // Headline: best price difference between the two months.
  if (curr.bestEff != null && next.bestEff != null) {
    const d = curr.bestEff - next.bestEff;
    if (Math.abs(d) < 0.01) {
      lines.push({ text: `Best price is the same both months: ${dollars(curr.bestEff)}/cs.`, important: false });
    } else if (d < 0) {
      lines.push({ text: `${labC} is ${dollars(d)}/cs cheaper than ${labN} at best price.`, important: true });
    } else {
      lines.push({ text: `${labN} is ${dollars(d)}/cs cheaper than ${labC} at best price.`, important: true });
    }
  }

  // RIP differences usually carry the buy decision, so render those before
  // discount differences. Same-qty tiers are grouped into one line each.
  if (rip.same.length) lines.push({ text: `Buy ${csList(rip.same)}: same RIP both months.`, important: false });
  for (const d of rip.differs) {
    const better = d.cur < d.nxt ? labC : labN;
    const gap = Math.abs(d.cur - d.nxt);
    lines.push({ text: `Buy ${d.qty}cs: ${better} is ${dollars(gap)}/cs cheaper on RIP.`, important: true });
  }
  if (rip.onlyCur.length) lines.push({ text: `RIP tier${rip.onlyCur.length > 1 ? 's' : ''} ${csList(rip.onlyCur)}: only in ${labC}.`, important: true });
  if (rip.onlyNxt.length) lines.push({ text: `RIP tier${rip.onlyNxt.length > 1 ? 's' : ''} ${csList(rip.onlyNxt)}: only in ${labN}.`, important: true });

  if (disc.same.length) lines.push({ text: `Buy ${csList(disc.same)}: same discount both months.`, important: false });
  for (const d of disc.differs) {
    const better = d.cur < d.nxt ? labC : labN;
    const gap = Math.abs(d.cur - d.nxt);
    lines.push({ text: `Buy ${d.qty}cs: ${better} discount is ${dollars(gap)}/cs better.`, important: true });
  }
  if (disc.onlyCur.length) lines.push({ text: `Discount tier${disc.onlyCur.length > 1 ? 's' : ''} ${csList(disc.onlyCur)}: only in ${labC}.`, important: true });
  if (disc.onlyNxt.length) lines.push({ text: `Discount tier${disc.onlyNxt.length > 1 ? 's' : ''} ${csList(disc.onlyNxt)}: only in ${labN}.`, important: true });

  if (lines.length === 0) return null;
  return (
    <div className="mes-summary">
      <div className="mes-summary-head">What it means</div>
      <ul className="mes-summary-list">
        {lines.map((l, i) => (
          <li key={i} className={l.important ? 'mes-summary-important' : undefined}>{l.text}</li>
        ))}
      </ul>
    </div>
  );
}


export default function MonthEffectiveSparkline({ curr, next }: Props) {
  const currEff = curr.bestEff;
  const nextEff = next.bestEff;
  // The popover renders above the chip by default. If the chip sits near the
  // top of the viewport (e.g. the catalog has only one result), the popover
  // would overflow the top of the screen and the user only sees the bottom
  // half. On hover we measure the chip's bounding rect and flip the popover
  // BELOW when there isn't ~360px of room above. Pure-CSS solutions (anchor
  // positioning, popover API) don't have wide enough support yet.
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const popRef = useRef<HTMLSpanElement | null>(null);
  const [placeBelow, setPlaceBelow] = useState(false);
  // Pinned + drag state. When pinned: popover stays visible after mouseleave,
  // turns into a position-fixed floating panel at `pos`, draggable from
  // anywhere on its body. dragOffset stores the cursor-to-panel offset at
  // mousedown so the panel doesn't jump under the cursor.
  const [pinned, setPinned] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);

  const onWrapEnter = () => {
    if (pinned) return;
    const el = wrapRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const ROOM_NEEDED = 360;   // generous min height for the two-column popover
    setPlaceBelow(rect.top < ROOM_NEEDED);
  };

  // On any mousedown inside the popover (except the close button), pin and
  // start drag. We snapshot the panel's current screen position so the first
  // mousemove can compute the new (x, y) as (clientX - dx, clientY - dy).
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

  const closePinned = () => {
    setPinned(false);
    setPos(null);
    dragRef.current = null;
  };

  if (currEff == null && nextEff == null) return null;

  // Layout reserves a clear label band at the BOTTOM so the month names never
  // sit behind the line. The plot (line + dots) lives in the upper area only.
  const W = 140, H = 42, PAD = 5, PLOT_BOTTOM = 23;
  const values: number[] = [];
  if (currEff != null) values.push(currEff);
  if (nextEff != null) values.push(nextEff);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(max - min, 0.01);
  const y = (v: number) => PLOT_BOTTOM - ((v - min) / range) * (PLOT_BOTTOM - PAD);
  const x0 = PAD + 22, x1 = W - PAD - 22;
  const goingDown = currEff != null && nextEff != null && nextEff < currEff - 0.005;
  const goingUp   = currEff != null && nextEff != null && nextEff > currEff + 0.005;
  // BUYER's perspective: price rising next month -> buy NOW (green);
  // price falling next month -> wait, don't buy now (red); flat -> grey.
  const colour = goingUp ? '#16a34a' : goingDown ? '#dc2626' : '#6b7280';

  const monC = fmtMonth(curr.edition);
  const monN = fmtMonth(next.edition);
  const labC = monC.split(' ')[0] || '–';
  const labN = monN.split(' ')[0] || '–';

  // Build the popover style: anchored to chip by default; fixed at (pos.x,
  // pos.y) once the user pins + drags. transform is cleared in fixed mode
  // because the default centred translateX(-50%) belongs to the anchored
  // mode only.
  const popStyle: React.CSSProperties | undefined = pinned && pos
    ? { position: 'fixed', left: pos.x, top: pos.y, transform: 'none', bottom: 'auto' }
    : undefined;

  return (
    <span className={`mes-wrap${placeBelow ? ' mes-wrap-below' : ''}${pinned ? ' mes-wrap-pinned' : ''}`}
          ref={wrapRef} onMouseEnter={onWrapEnter}>
      <span className="mes-chip">
        <svg width={W} height={H} aria-hidden>
          {currEff != null && nextEff != null && (
            <line x1={x0} y1={y(currEff)} x2={x1} y2={y(nextEff)} stroke={colour} strokeWidth={2} />
          )}
          {currEff != null && <circle cx={x0} cy={y(currEff)} r={3} fill={colour} />}
          {nextEff != null && <circle cx={x1} cy={y(nextEff)} r={3} fill={colour} />}
          {/* Month labels in a dedicated bottom band — regular weight, not faded,
              and clear of the line above. */}
          <text x={2} y={H - 5} fontSize="11" fontWeight="400" fill="var(--text-muted, #475569)">{labC}</text>
          <text x={W - 2} y={H - 5} fontSize="11" fontWeight="400" fill="var(--text-muted, #475569)" textAnchor="end">{labN}</text>
        </svg>
        <span className="mes-val" style={{ color: colour }}>
          {/* Show the signed dollar delta between This and Next month so the
              user reads the *change*, not just the next-month price. Falls
              back to the absolute next/current price when only one edition
              is present and a delta isn't computable. */}
          {(() => {
            if (currEff != null && nextEff != null) {
              const d = nextEff - currEff;
              if (Math.abs(d) >= 0.5) {
                return `${d > 0 ? '+' : '−'}$${Math.abs(d).toFixed(0)}`;
              }
              return 'flat';
            }
            return `$${(nextEff ?? currEff ?? 0).toFixed(0)}`;
          })()}
          {goingDown && ' ↓'}{goingUp && ' ↑'}
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
          <MonthBlock label={monC || 'This month'} short={monC ? labC : undefined} b={curr} />
          <MonthBlock label={monN || 'Next month'} short={monN ? labN : undefined} b={next} />
        </div>
        <ComparisonSummary curr={curr} next={next} labC={labC} labN={labN} />
      </span>
    </span>
  );
}
