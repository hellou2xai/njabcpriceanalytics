/**
 * DealLadder — the ONE reusable quantity-discount + RIP tier ladder.
 *
 * Renders, for the current month, every QD and RIP tier as
 *   "QD/RIP  Buy N cs → $price/cs · $price/btl (−$savings)"
 * driven from the SAME `buildMonths(price_3mo)` data the sparkline uses, so the
 * inline numbers can never disagree with the chart or the price-schedule
 * tooltip. The savings shown is the TOTAL off list (list − net price) — the
 * same figure the tooltip shows — never a confusing RIP-only increment and
 * never an invented "best RIP".
 *
 * Used by the Products list expanded size rows AND the collapsed product card,
 * so there is exactly one place that turns canonical tiers into UI.
 */
import type { MonthBreakdown, RipTier } from './MonthEffectiveSparkline';
import { windowBadge, fmtDateRange } from '../lib/dealDates';

const unitWord = (u: string) => (/btl|bottle/i.test(u) ? 'btl' : 'cs');

// Partial-month (time-sensitive) RIP/discount flag with its date window — so a
// deal that's only valid part of the month is never mistaken for the dependable
// full-month price. Full-month / evergreen tiers render nothing.
function PartialFlag({ t }: { t: RipTier }) {
  const wb = windowBadge(t);
  if (!t.ts && !wb) return null;
  const range = fmtDateRange(t.from_date, t.to_date);
  const cls = wb ? wb.cls : 'win-partial';
  const label = t.ts ? `Partial · ${range || 'limited dates'}` : (wb?.label ?? '');
  return (
    <span className={`win-badge ${cls}${wb?.urgent ? ' urgent' : ''}`}
      title={`Partial-month RIP — only valid ${range || 'on limited dates'}${wb ? ` (${wb.label})` : ''}. Not part of the full-month price.`}>
      {label}{t.ts && wb ? ` · ${wb.label}` : ''}
    </span>
  );
}

export default function DealLadder({ months, pack, emptyText }: {
  months: MonthBreakdown[];
  pack: number | null;
  // When set, renders this note if there are no deals; when omitted, renders
  // nothing (so callers that only want the ladder stay clean).
  emptyText?: string;
}) {
  const cur = months.length ? months[months.length - 1] : null;
  const frontline = cur?.frontline ?? null;
  const disc = [...(cur?.discountTiers ?? [])].sort((a, b) => a.qty - b.qty);
  const rip = [...(cur?.ripTiers ?? [])].sort((a, b) => a.qty - b.qty);
  const btlOf = (c?: number | null) => (pack && c != null ? c / pack : null);

  if (disc.length === 0 && rip.length === 0) {
    return emptyText ? <span className="prod-deals-none">{emptyText}</span> : null;
  }

  const line = (kind: 'qd' | 'rip', t: RipTier, i: number) => {
    const b = btlOf(t.eff);
    const off = frontline != null && t.eff < frontline ? frontline - t.eff : null;
    return (
      <div key={`${kind}${i}`} className="prod-deal-line">
        <span className={`prod-deal-badge prod-deal-${kind}`}>{kind === 'qd' ? 'QD' : 'RIP'}</span>{' '}
        Buy {t.qty} {unitWord(t.unit)} → <strong>${t.eff.toFixed(2)}/cs</strong>
        {b != null && <span className="prod-deal-btl"> · ${b.toFixed(2)}/btl</span>}
        {off != null && off > 0.005 && <span className="prod-deal-off"> (−${off.toFixed(2)})</span>}
        <PartialFlag t={t} />
      </div>
    );
  };

  return (
    <>
      {disc.map((t, i) => line('qd', t, i))}
      {rip.map((t, i) => line('rip', t, i))}
    </>
  );
}
