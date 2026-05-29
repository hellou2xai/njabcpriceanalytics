/**
 * Two-point sparkline (this month -> next month) showing the best effective
 * case price per product, used by RIP Products and the Catalog. Colour
 * reflects direction (green = drop, red = rise, muted = flat). The native
 * title carries the full per-tier breakdown for both months so the buyer
 * can audit which discount/RIP combo produces the best price.
 */

export type SparkOpt = {
  source: 'discount' | 'rip';
  qty: number;
  unit: string;
  eff: number;
};

interface Props {
  currEff: number | null;
  nextEff: number | null;
  currOpts: SparkOpt[];
  nextOpts: SparkOpt[];
  currEd: string | null;
  nextEd: string | null;
}

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function fmtMonth(ed: string | null): string {
  if (!ed) return '';
  const m = /^(\d{4})-(\d{1,2})/.exec(ed);
  if (!m) return ed;
  return MONTHS[parseInt(m[2], 10) - 1] ?? ed;
}

export default function MonthEffectiveSparkline({
  currEff, nextEff, currOpts, nextOpts, currEd, nextEd,
}: Props) {
  if (currEff == null && nextEff == null) return null;

  const W = 130, H = 34, PAD = 5;
  const values: number[] = [];
  if (currEff != null) values.push(currEff);
  if (nextEff != null) values.push(nextEff);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(max - min, 0.01);
  const y = (v: number) => H - PAD - ((v - min) / range) * (H - 2 * PAD);
  const x0 = PAD + 18, x1 = W - PAD - 4;
  const goingDown = currEff != null && nextEff != null && nextEff < currEff - 0.005;
  const goingUp   = currEff != null && nextEff != null && nextEff > currEff + 0.005;
  const colour = goingDown ? '#16a34a' : goingUp ? '#dc2626' : '#6b7280';

  const monC = fmtMonth(currEd);
  const monN = fmtMonth(nextEd);
  const optLine = (o: SparkOpt) =>
    `  ${o.source === 'discount' ? 'Discount' : 'RIP'} ${o.qty} ${o.unit} -> $${o.eff.toFixed(2)}`;
  const lines: string[] = [];
  if (currEff != null) {
    lines.push(`${monC || 'This month'} (best $${currEff.toFixed(2)}/cs)`);
    if (currOpts.length) {
      [...currOpts].sort((a, b) => a.eff - b.eff).forEach(o => lines.push(optLine(o)));
    } else {
      lines.push('  no active deal');
    }
    lines.push('');
  }
  if (nextEff != null) {
    lines.push(`${monN || 'Next month'} (best $${nextEff.toFixed(2)}/cs)`);
    if (nextOpts.length) {
      [...nextOpts].sort((a, b) => a.eff - b.eff).forEach(o => lines.push(optLine(o)));
    } else {
      lines.push('  no active deal');
    }
  }
  const tooltip = lines.join('\n');

  return (
    <span className="rip-month-spark" title={tooltip}>
      <svg width={W} height={H} aria-hidden>
        {currEff != null && nextEff != null && (
          <line x1={x0} y1={y(currEff)} x2={x1} y2={y(nextEff)} stroke={colour} strokeWidth={2} />
        )}
        {currEff != null && <circle cx={x0} cy={y(currEff)} r={3} fill={colour} />}
        {nextEff != null && <circle cx={x1} cy={y(nextEff)} r={3} fill={colour} />}
        <text x={2} y={y(currEff ?? nextEff ?? 0) + 4} fontSize="9" fill="#6b7280">{monC || '-'}</text>
        <text x={W - PAD - 2} y={H - 1} fontSize="9" fill="#6b7280" textAnchor="end">{monN || '-'}</text>
      </svg>
      <span className="rip-month-spark-val" style={{ color: colour }}>
        ${(nextEff ?? currEff ?? 0).toFixed(0)}
        {goingDown && ' ↓'}{goingUp && ' ↑'}
      </span>
    </span>
  );
}
