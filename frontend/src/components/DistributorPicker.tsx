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
  return (
    <select
      value={wholesaler}
      disabled={busy}
      title="Switch this line to another distributor that carries the same product. Net/case includes that distributor's own RIP rebate."
      style={{ fontSize: 11, padding: '1px 4px', maxWidth: '100%', border: '1px solid var(--border)', borderRadius: 4, background: 'var(--surface)' }}
      onChange={e => { if (e.target.value && e.target.value !== wholesaler) onSwitch(e.target.value); }}
    >
      {cmp.map(c => {
        const net = c.effective_case_price;
        const cur = c.wholesaler === wholesaler;
        return (
          <option key={c.wholesaler} value={c.wholesaler}>
            {distributorName(c.wholesaler)} · {net != null ? `$${net.toFixed(2)}` : '—'}/cs
            {c.has_rip ? ' +RIP' : ''}
            {!cur && c.is_cheapest_net ? ' ◆ cheapest' : ''}
            {cur ? ' (current)' : ''}
          </option>
        );
      })}
    </select>
  );
}
