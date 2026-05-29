/**
 * Two-point sparkline (this month -> next month) showing the best effective
 * case price per product, used by RIP Products and the Catalog. Hovering
 * the sparkline reveals a structured popover with Frontline -> After Discount
 * -> RIP Tiers for both months side by side. Hover target is the entire
 * coloured chip so it's easy to land on; the popover renders above the chip
 * with a small arrow tail.
 */

export interface RipTier { qty: number; unit: string; eff: number; }

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

function MonthBlock({ label, b }: { label: string; b: MonthBreakdown }) {
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
                  <tr key={`d${i}`} className={isBest ? 'mes-row-best' : ''}>
                    <td>{tierLabel(t)}</td>
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
                const save = ripVsDisc - t.eff;
                const isBest = t.eff === bestRipEff;
                return (
                  <tr key={`r${i}`} className={isBest ? 'mes-row-best' : ''}>
                    <td>{tierLabel(t)}</td>
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

          <tr className="mes-best">
            <td>Best</td>
            <td className="mes-num">{fmt(b.bestEff)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

export default function MonthEffectiveSparkline({ curr, next }: Props) {
  const currEff = curr.bestEff;
  const nextEff = next.bestEff;
  if (currEff == null && nextEff == null) return null;

  const W = 140, H = 36, PAD = 5;
  const values: number[] = [];
  if (currEff != null) values.push(currEff);
  if (nextEff != null) values.push(nextEff);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(max - min, 0.01);
  const y = (v: number) => H - PAD - ((v - min) / range) * (H - 2 * PAD);
  const x0 = PAD + 22, x1 = W - PAD - 4;
  const goingDown = currEff != null && nextEff != null && nextEff < currEff - 0.005;
  const goingUp   = currEff != null && nextEff != null && nextEff > currEff + 0.005;
  const colour = goingDown ? '#16a34a' : goingUp ? '#dc2626' : '#6b7280';

  const monC = fmtMonth(curr.edition);
  const monN = fmtMonth(next.edition);
  const labC = monC.split(' ')[0] || '–';
  const labN = monN.split(' ')[0] || '–';

  return (
    <span className="mes-wrap">
      <span className="mes-chip">
        <svg width={W} height={H} aria-hidden>
          {currEff != null && nextEff != null && (
            <line x1={x0} y1={y(currEff)} x2={x1} y2={y(nextEff)} stroke={colour} strokeWidth={2} />
          )}
          {currEff != null && <circle cx={x0} cy={y(currEff)} r={3} fill={colour} />}
          {nextEff != null && <circle cx={x1} cy={y(nextEff)} r={3} fill={colour} />}
          <text x={2} y={H - 1} fontSize="9" fill="#6b7280">{labC}</text>
          <text x={W - PAD - 2} y={H - 1} fontSize="9" fill="#6b7280" textAnchor="end">{labN}</text>
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
      <span className="mes-popover" role="tooltip">
        <MonthBlock label={monC || 'This month'} b={curr} />
        <MonthBlock label={monN || 'Next month'} b={next} />
      </span>
    </span>
  );
}
