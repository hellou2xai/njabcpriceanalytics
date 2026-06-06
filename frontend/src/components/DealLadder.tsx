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

const unitWord = (u: string) => (/btl|bottle/i.test(u) ? 'btl' : 'cs');

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
