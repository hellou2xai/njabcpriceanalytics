/**
 * DealLadder — the ONE reusable quantity-discount + RIP tier ladder.
 *
 * Renders, for the current month, every QD and RIP tier as
 *   "QD/RIP  Buy N cs → $price/cs · $price/btl (−$savings)"
 * driven from the SAME `buildMonths(price_3mo)` data the sparkline uses, so the
 * inline numbers can never disagree with the chart or the price-schedule
 * tooltip. The savings figure differs BY KIND on purpose:
 *   - QD rows show the discount off list (list − net price at that tier).
 *   - RIP rows show the REBATE ALONE (rip_only_save_per_case) — the number on
 *     the RIP sheet and in the rep's quote. The net price already includes any
 *     stacked case discount, but folding that $ into the RIP's parenthetical
 *     made a $42 rebate read as "−$48", which confused everyone.
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
  // Always the prominent amber 'partial' style (red when expiring) — never the
  // subtle blue 'upcoming' — so a partial deal can't be overlooked.
  const cls = t.ts ? (wb?.urgent ? 'win-partial urgent' : 'win-partial') : (wb?.cls ?? 'win-partial');
  const label = t.ts ? `⏱ Partial · ${range || 'limited dates'}` : (wb?.label ?? '');
  return (
    <span className={`win-badge ${cls}`}
      title={`Partial-month deal — only valid ${range || 'on limited dates'}${wb ? ` (${wb.label})` : ''}. Not part of the full-month price.`}>
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
  // Sort by the deal's EFFECTIVE WINDOW first (evergreen/full-month before
  // dated; earlier windows before later), then by qty — so a month split into
  // back-to-back dated codes reads as two coherent blocks instead of the
  // windows interleaving tier by tier.
  const byWindow = (a: RipTier, b: RipTier) =>
    (a.from_date ?? '0000').localeCompare(b.from_date ?? '0000')
    || (a.to_date ?? '9999').localeCompare(b.to_date ?? '9999')
    || a.qty - b.qty;
  const disc = [...(cur?.discountTiers ?? [])].sort(byWindow);
  const rip = [...(cur?.ripTiers ?? [])].sort(byWindow);
  const btlOf = (c?: number | null) => (pack && c != null ? c / pack : null);

  if (disc.length === 0 && rip.length === 0) {
    return emptyText ? <span className="prod-deals-none">{emptyText}</span> : null;
  }

  // When the item is 1 bottle/case, a bottle-unit tier IS a case tier — show 'cs'
  // so QD (cases) and RIP (bottles) don't read with different units.
  const uw = (u: string) => (pack === 1 ? 'cs' : unitWord(u));
  const line = (kind: 'qd' | 'rip', t: RipTier, i: number) => {
    const b = btlOf(t.eff);
    const off = frontline != null && t.eff < frontline ? frontline - t.eff : null;
    // RIP rows: the rebate ALONE (the RIP-sheet number), never rebate+QD mixed.
    const ripSave = kind === 'rip' ? (t.ripOnlySave ?? null) : null;
    return (
      <div key={`${kind}${i}`} className="prod-deal-line">
        <span className={`prod-deal-badge prod-deal-${kind}`}>{kind === 'qd' ? 'QD' : 'RIP'}</span>{' '}
        Buy {t.qty} {uw(t.unit)} → <strong>${t.eff.toFixed(2)}/cs</strong>
        {b != null && <span className="prod-deal-btl"> · ${b.toFixed(2)}/btl</span>}
        {kind === 'rip' && ripSave != null && ripSave > 0.005 && (
          <span className="prod-deal-off"
            title="The RIP rebate alone, per case — the number on the RIP sheet. The price shown already includes any stacked case discount.">
            {' '}(RIP −${ripSave.toFixed(2)}/cs)
          </span>
        )}
        {kind === 'qd' && off != null && off > 0.005 && (
          <span className="prod-deal-off"> (−${off.toFixed(2)})</span>
        )}
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
