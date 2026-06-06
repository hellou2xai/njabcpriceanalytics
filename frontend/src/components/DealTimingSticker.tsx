/**
 * DealTimingSticker — a CLICKABLE product sticker that explains WHEN a product's
 * dated deals apply and, crucially, whether there's a buy-timing TRAP: a run of
 * days where no deal is active and you'd overpay. Buyers love this because dated
 * RIP/QD windows (and the gaps between them) are exactly the thing that's easy to
 * miss. Click → a popover with the full timeline + plain-English advice.
 *
 * A RIP gap that a partial QD covers is NOT a trap (the backend already unions
 * RIP + QD windows when computing rip_gaps), so the popover only warns on real
 * no-deal days.
 */
import { useState, useRef, useLayoutEffect, useEffect } from 'react';
import { Clock, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { fmtDateRange } from '../lib/dealDates';
import type { MonthBreakdown, RipTier } from './MonthEffectiveSparkline';
import type { CatalogTier } from '../lib/api';

export interface RipGap { from: string; to: string; days: number }
export interface DatedDeal { kind: 'QD' | 'RIP'; qty?: number | null; unit?: string | null; from?: string | null; to?: string | null; eff: number | null; save: number | null }

const money = (n?: number | null) => (n == null ? '' : `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

// Build the dated-deal list from a product's price_3mo months (Products/detail).
export function datedFromMonths(months: MonthBreakdown[]): DatedDeal[] {
  const cur = months.length ? months[months.length - 1] : null;
  if (!cur) return [];
  const front = cur.frontline ?? null;
  const out: DatedDeal[] = [];
  const add = (t: RipTier, kind: 'QD' | 'RIP') => {
    if (!t.ts) return;
    out.push({ kind, qty: t.qty, unit: t.unit, from: t.from_date, to: t.to_date, eff: t.eff,
      save: front != null && t.eff < front ? front - t.eff : null });
  };
  for (const t of (cur.discountTiers ?? [])) add(t, 'QD');
  for (const t of (cur.ripTiers ?? [])) add(t, 'RIP');
  return out;
}

// Build from a flat tiers array (cart / list items carry `tiers`).
export function datedFromTiers(tiers: CatalogTier[] | undefined, frontline?: number | null): DatedDeal[] {
  return (tiers ?? []).filter(t => t.is_time_sensitive).map(t => ({
    kind: t.source === 'rip' ? 'RIP' as const : 'QD' as const,
    qty: t.qty, unit: t.unit, from: t.from_date, to: t.to_date,
    eff: t.price_after ?? null,
    save: frontline != null && (t.price_after ?? Infinity) < frontline ? frontline - (t.price_after ?? 0) : (t.save_per_case ?? null),
  }));
}

const unit1 = (qty: number, unit: string) => {
  const u = /btl|bottle/i.test(unit) ? 'bottle' : 'case';
  return qty === 1 ? u : `${u}s`;
};

export default function DealTimingSticker({ deals, gaps, label }: {
  deals: DatedDeal[];
  gaps?: RipGap[] | null;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  const hasTrap = !!(gaps && gaps.length);
  const sorted = [...deals].sort((a, b) => String(a.from ?? '').localeCompare(String(b.from ?? '')));

  useLayoutEffect(() => {
    if (!open || !btnRef.current) { setPos(null); return; }
    const r = btnRef.current.getBoundingClientRect();
    const W = 320;
    setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - W - 12)), top: r.bottom + 6 });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!popRef.current?.contains(e.target as Node) && !btnRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  if (!sorted.length && !hasTrap) return null;

  return (
    <span className="dts">
      <button ref={btnRef} type="button" className={`dts-sticker${hasTrap ? ' trap' : ''}`}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(o => !o); }}
        title="See exactly when each deal applies (and any no-deal days to avoid)">
        {hasTrap ? <AlertTriangle size={11} /> : <Clock size={11} />}
        {label ?? (hasTrap ? 'Buy-timing trap' : 'Dated deal · when?')}
      </button>
      {open && pos && (
        <div ref={popRef} className="dts-pop" style={{ position: 'fixed', left: pos.left, top: pos.top }}
          onClick={e => e.stopPropagation()}>
          <div className="dts-pop-title">When each deal applies this month</div>
          {sorted.map((d, i) => (
            <div key={i} className="dts-pop-row">
              <span className={`dts-pill dts-${d.kind.toLowerCase()}`}>{d.kind}</span>
              <span className="dts-pop-when">{fmtDateRange(d.from, d.to) || 'limited dates'}</span>
              <span className="dts-pop-price">
                {d.qty != null ? `buy ${d.qty} ${unit1(d.qty, d.unit ?? 'case')} → ` : ''}{money(d.eff)}/cs{d.save ? ` (save ${money(d.save)})` : ''}
              </span>
            </div>
          ))}
          {hasTrap ? (
            <div className="dts-pop-trap">
              <AlertTriangle size={13} />
              <span><strong>Trap:</strong> {gaps!.map(g => fmtDateRange(g.from, g.to)).join(', ')} — <strong>no deal these days</strong>. Order before or after to keep the discount/rebate.</span>
            </div>
          ) : (
            <div className="dts-pop-ok"><CheckCircle2 size={13} /> A deal is active every day this month — no gap to avoid.</div>
          )}
        </div>
      )}
    </span>
  );
}
