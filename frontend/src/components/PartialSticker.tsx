/**
 * PartialSticker — a product-level sticker (like the QD / RIP badges) that flags
 * when a product carries a PARTIAL-MONTH (time-sensitive) quantity discount or
 * RIP — a deal valid only on certain dates, not the dependable full-month price.
 * Driven from the same buildMonths(price_3mo) tiers everything else uses, so it
 * appears wherever a product is shown (cards, rows, detail) and reads the canonical
 * window data (is_time_sensitive / window_status / from_date / to_date).
 */
import type { MonthBreakdown, RipTier } from './MonthEffectiveSparkline';
import { windowBadge, fmtDateRange } from '../lib/dealDates';
import type { WindowStatus } from '../lib/api';

export interface PartialInfo {
  kind: 'QD' | 'RIP';
  from_date?: string | null;
  to_date?: string | null;
  window_status?: WindowStatus | null;
  days_to_expire?: number | null;
}

function pick(tiers: RipTier[] | undefined, kind: 'QD' | 'RIP'): PartialInfo | null {
  const ts = (tiers ?? []).filter(t => t.ts);
  if (!ts.length) return null;
  // Prefer a live (active) window, else the next upcoming, else any.
  const t = ts.find(x => x.window_status === 'active')
    ?? ts.find(x => x.window_status === 'upcoming') ?? ts[0];
  return { kind, from_date: t.from_date, to_date: t.to_date, window_status: t.window_status, days_to_expire: t.days_to_expire };
}

// Partial QD + RIP (current month) for a product, deduped to one per kind.
export function partialDeals(months: MonthBreakdown[]): PartialInfo[] {
  const cur = months.length ? months[months.length - 1] : null;
  if (!cur) return [];
  return [pick(cur.discountTiers, 'QD'), pick(cur.ripTiers, 'RIP')].filter(Boolean) as PartialInfo[];
}

export default function PartialSticker({ months }: { months: MonthBreakdown[] }) {
  const parts = partialDeals(months);
  if (!parts.length) return null;
  return (
    <>
      {parts.map((p, i) => {
        const wb = windowBadge({ window_status: p.window_status, days_to_expire: p.days_to_expire, from_date: p.from_date, to_date: p.to_date });
        const range = fmtDateRange(p.from_date, p.to_date);
        return (
          <span key={`${p.kind}${i}`}
            className={`prod-partial-sticker${wb?.urgent ? ' urgent' : ''}`}
            title={`Partial-month ${p.kind} — only valid ${range || 'on limited dates'}${wb ? ` (${wb.label})` : ''}. Applies only on these dates, not the full month.`}>
            ⏱ Partial {p.kind}{wb?.urgent ? ` · ${wb.label}` : ''}
          </span>
        );
      })}
    </>
  );
}
