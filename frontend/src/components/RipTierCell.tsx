import type { OrderRipTier } from '../lib/api';
import { fmt, parseNum } from '../lib/orderMath';

/**
 * RIP-by-case tier display. Green "UNLOCKED" = reached at the line's quantity,
 * blue "BEST VALUE" = the best tier not yet reached, grey = the rest.
 */
export default function RipTierCell({ tiers, qtyCases }: { tiers?: OrderRipTier[]; qtyCases: number }) {
  if (!tiers || tiers.length === 0) {
    return <span style={{ color: 'var(--text-muted)' }}>&mdash;</span>;
  }
  const sorted = [...tiers].sort((a, b) => b.tier_cases - a.tier_cases);
  const bestUnmet = sorted.find(t => qtyCases < t.tier_cases);

  return (
    <div className="rip-tier-cell">
      {tiers.map((tier, i) => {
        const met = qtyCases >= tier.tier_cases;
        const isBest = !met && tier === bestUnmet;
        const save = parseNum(tier.save_amount);
        const rowClass = met ? 'rip-tier-row rip-tier-met' : isBest ? 'rip-tier-row rip-tier-best' : 'rip-tier-row';
        const badgeBg = met ? 'color-mix(in srgb, var(--green) 18%, transparent)'
          : isBest ? 'color-mix(in srgb, var(--accent) 16%, transparent)'
          : 'color-mix(in srgb, var(--text-muted) 14%, transparent)';
        const tone = met ? 'var(--green)' : isBest ? 'var(--accent)' : 'var(--text-muted)';
        return (
          <div key={i} className={rowClass}>
            <span className="rip-tier-badge" style={{ background: badgeBg, color: tone }}>{tier.tier}</span>
            <span style={{ fontSize: 12, fontFamily: 'var(--font-mono)', color: met ? 'var(--green)' : isBest ? 'var(--accent)' : 'var(--text)' }}>
              save {fmt(save)}/cs
            </span>
            {met && <span style={{ color: 'var(--green)', fontWeight: 700, fontSize: 10 }}>&#10003; UNLOCKED</span>}
            {isBest && <span style={{ color: 'var(--accent)', fontSize: 10, fontWeight: 700 }}>BEST VALUE</span>}
          </div>
        );
      })}
    </div>
  );
}
