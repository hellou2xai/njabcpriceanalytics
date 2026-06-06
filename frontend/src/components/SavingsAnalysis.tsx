/**
 * SavingsAnalysis — the "Analyze for Savings" results panel, shared by the Cart
 * and the Lists page. Renders the headline totals (already saving / save more /
 * lock in before a rise) and the per-recommendation cards: quantity-discount &
 * RIP tier-gap nudges, case-mix qualification, buy-before-a-price-rise, and
 * cross-distributor swaps. Every number comes from the backend /analyze engine
 * (the canonical pricing tiers) — this component only presents and, on the cart,
 * lets the buyer APPLY a nudge (bump qty / switch distributor).
 */
import { TrendingUp, Layers, Repeat, CalendarClock, PiggyBank, Sparkles, Clock } from 'lucide-react';
import type { SavingsAnalysis as Analysis, SavingsRec } from '../lib/api';
import { distributorName } from '../lib/distributors';

const money = (n?: number | null) =>
  n == null ? '—' : `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const cs = (n?: number) => `${n} ${n === 1 ? 'case' : 'cases'}`;

function Expiry({ rec }: { rec: SavingsRec }) {
  if (rec.window_status !== 'active' || rec.days_to_expire == null || rec.days_to_expire > 14) return null;
  return (
    <span className="sav-expiry"><Clock size={11} /> expires in {rec.days_to_expire}d</span>
  );
}

function RecCard({ rec, context, onSetQty, onSwap, busy }: {
  rec: SavingsRec;
  context: 'cart' | 'list';
  onSetQty?: (lineId: number, cases: number) => void;
  onSwap?: (rec: SavingsRec) => void;
  busy?: boolean;
}) {
  if (rec.type === 'tier_gap') {
    const isRip = rec.kind === 'rip';
    return (
      <div className="sav-rec">
        <span className={`sav-ico ${isRip ? 'is-rip' : 'is-qd'}`}><TrendingUp size={15} /></span>
        <div className="sav-rec-body">
          <div className="sav-rec-head">
            <span className={`prod-deal-badge ${isRip ? 'prod-deal-rip' : 'prod-deal-qd'}`}>{isRip ? 'RIP' : 'QD'}</span>
            <strong>{rec.product_name}</strong>{rec.unit_volume ? ` · ${rec.unit_volume}` : ''}
            <Expiry rec={rec} />
          </div>
          <div className="sav-rec-text">
            Buy <strong>{cs(rec.target_qty)}</strong>{rec.current_cases ? ` (add ${rec.add_cases})` : ''} →{' '}
            <strong>{money(rec.new_case_price)}/cs</strong> · save {money(rec.save_per_case)}/cs
          </div>
        </div>
        <div className="sav-rec-right">
          <span className="sav-amt">+{money(rec.extra_savings)}</span>
          {context === 'cart' && rec.line_id != null && onSetQty && (
            <button className="btn btn-secondary btn-sm" disabled={busy}
              onClick={() => onSetQty(rec.line_id!, rec.target_qty!)}>
              Set to {rec.target_qty}
            </button>
          )}
        </div>
      </div>
    );
  }

  if (rec.type === 'case_mix') {
    return (
      <div className="sav-rec">
        <span className="sav-ico is-mix"><Layers size={15} /></span>
        <div className="sav-rec-body">
          <div className="sav-rec-head">
            <span className="prod-deal-badge prod-deal-rip">Case Mix</span>
            <strong>RIP {rec.rip_code}</strong> · {rec.members?.length} items
            {rec.description ? <span className="sav-rec-desc"> — {rec.description}</span> : null}
          </div>
          <div className="sav-rec-text">
            You have <strong>{rec.current_cases}</strong> of <strong>{rec.target_qty}</strong> cases across these —
            add <strong>{cs(rec.add_cases)}</strong> (mix any of them) to unlock the tier.
            <div className="sav-rec-members">{rec.members?.join(' · ')}</div>
          </div>
        </div>
        <div className="sav-rec-right"><span className="sav-amt">+{money(rec.extra_savings)}</span></div>
      </div>
    );
  }

  if (rec.type === 'buy_before') {
    return (
      <div className="sav-rec">
        <span className="sav-ico is-warn"><CalendarClock size={15} /></span>
        <div className="sav-rec-body">
          <div className="sav-rec-head"><strong>{rec.product_name}</strong>{rec.unit_volume ? ` · ${rec.unit_volume}` : ''}</div>
          <div className="sav-rec-text">
            Price rises {money(rec.rise_per_case)}/cs next month ({money(rec.current_price)} → {money(rec.next_price)}).
            Lock in now{rec.current_cases ? ` (× ${cs(rec.current_cases)})` : ''}.
          </div>
        </div>
        <div className="sav-rec-right"><span className="sav-amt is-warn">{money(rec.total_rise)}</span></div>
      </div>
    );
  }

  // swap
  return (
    <div className="sav-rec">
      <span className="sav-ico is-swap"><Repeat size={15} /></span>
      <div className="sav-rec-body">
        <div className="sav-rec-head"><strong>{rec.product_name}</strong>{rec.unit_volume ? ` · ${rec.unit_volume}` : ''}</div>
        <div className="sav-rec-text">
          {money(rec.save_per_case)}/cs cheaper at <strong>{distributorName(rec.to_wholesaler || '')}</strong>{' '}
          ({money(rec.current_price)} → {money(rec.other_price)})
        </div>
      </div>
      <div className="sav-rec-right">
        <span className="sav-amt">+{money(rec.total_savings)}</span>
        {context === 'cart' && onSwap && (
          <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => onSwap(rec)}>
            Switch to {distributorName(rec.to_wholesaler || '')}
          </button>
        )}
      </div>
    </div>
  );
}

export default function SavingsAnalysis({ data, loading, context, onSetQty, onSwap, busy }: {
  data?: Analysis;
  loading?: boolean;
  context: 'cart' | 'list';
  onSetQty?: (lineId: number, cases: number) => void;
  onSwap?: (rec: SavingsRec) => void;
  busy?: boolean;
}) {
  if (loading) return <div className="sav-panel sav-empty">Analyzing for savings…</div>;
  if (!data) return null;
  const recs = data.recommendations ?? [];

  return (
    <div className="sav-panel">
      <div className="sav-stats">
        {context === 'cart' && (
          <div className="sav-stat">
            <span className="sav-stat-ico"><PiggyBank size={16} /></span>
            <div><div className="sav-stat-val">{money(data.captured_total)}</div>
              <div className="sav-stat-lbl">already saving</div></div>
          </div>
        )}
        <div className="sav-stat is-opportunity">
          <span className="sav-stat-ico"><Sparkles size={16} /></span>
          <div><div className="sav-stat-val">{money(data.opportunity_total)}</div>
            <div className="sav-stat-lbl">save up to{context === 'list' ? '' : ' more'}</div></div>
        </div>
        {data.protection_total > 0 && (
          <div className="sav-stat is-protect">
            <span className="sav-stat-ico"><CalendarClock size={16} /></span>
            <div><div className="sav-stat-val">{money(data.protection_total)}</div>
              <div className="sav-stat-lbl">lock in before rises</div></div>
          </div>
        )}
      </div>

      {recs.length === 0 ? (
        <div className="sav-allset">
          {context === 'list'
            ? 'No extra savings found on this list — these are already at their best tier.'
            : 'Your cart is fully optimized — no extra savings found.'}
        </div>
      ) : (
        <div className="sav-recs">
          {recs.map((r, i) => (
            <RecCard key={i} rec={r} context={context} onSetQty={onSetQty} onSwap={onSwap} busy={busy} />
          ))}
        </div>
      )}
    </div>
  );
}
