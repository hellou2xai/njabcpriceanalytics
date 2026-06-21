import type { OfferRow } from '../lib/api';
import { distributorName } from '../lib/distributors';

// The distributor cell becomes a dropdown of EVERY distributor carrying the same
// item in this edition, each with its own net price + RIP flag (from the
// precomputed comparison grid, UPC-driven with a name fallback). Picking a
// different one switches the line IN PLACE. Shared by the Cart and Lists.
export function DistributorPicker({ wholesaler, comparison, onSwitch, busy }: {
  wholesaler: string;
  comparison?: OfferRow[] | null;
  onSwitch: (ws: string) => void;
  busy?: boolean;
}) {
  const cmp = comparison ?? [];
  // Fewer than two houses carry it → nothing to switch to; render plain text.
  if (cmp.length < 2) return <>{distributorName(wholesaler)}</>;
  // Cross-distributor RIP check: does another house pay a bigger RIP than the
  // current line's? (Switching there auto-assigns its best RIP.)
  const mine = cmp.find(c => c.wholesaler === wholesaler);
  const myRip = mine?.rip_per_case ?? 0;
  const betterRip = cmp
    .filter(c => c.wholesaler !== wholesaler && (c.rip_per_case ?? 0) > myRip + 0.005)
    .sort((a, b) => (b.rip_per_case ?? 0) - (a.rip_per_case ?? 0))[0];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <select
        value={wholesaler}
        disabled={busy}
        title="Switch this line to another distributor that carries the same product. Net/case includes that distributor's own RIP rebate; switching auto-assigns the target's best RIP."
        style={{ fontSize: 11, padding: '1px 4px', maxWidth: '100%', border: '1px solid var(--border)', borderRadius: 4, background: 'var(--surface)' }}
        onChange={e => { if (e.target.value && e.target.value !== wholesaler) onSwitch(e.target.value); }}
      >
        {cmp.map(c => {
          const net = c.effective_case_price;
          const cur = c.wholesaler === wholesaler;
          const rip = c.rip_per_case ?? 0;
          return (
            <option key={c.wholesaler} value={c.wholesaler}>
              {distributorName(c.wholesaler)} · {net != null ? `$${net.toFixed(2)}` : '—'}/cs
              {rip > 0 ? ` (RIP $${rip.toFixed(2)}/cs)` : ''}
              {!cur && c.is_cheapest_net ? ' ◆ cheapest' : ''}
              {cur ? ' (current)' : ''}
            </option>
          );
        })}
      </select>
      {betterRip && (
        <button type="button"
          title={`${distributorName(betterRip.wholesaler)} pays a bigger RIP ($${(betterRip.rip_per_case ?? 0).toFixed(2)}/cs vs $${myRip.toFixed(2)}/cs). Switch to auto-assign its best RIP.`}
          style={{ fontSize: 10, fontWeight: 700, color: 'hsl(150 60% 30%)', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', padding: 0 }}
          onClick={() => onSwitch(betterRip.wholesaler)}>
          ★ Better RIP at {distributorName(betterRip.wholesaler)} (${(betterRip.rip_per_case ?? 0).toFixed(2)}/cs)
        </button>
      )}
    </div>
  );
}
