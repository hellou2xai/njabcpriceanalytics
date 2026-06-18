import { ArrowDownRight, ArrowUpRight, ArrowRight } from 'lucide-react';

/**
 * Next-month price chip. The buyer's rule: the headline price is what they pay
 * THIS month, but they need visibility into NEXT month too. This compact chip
 * sits next to the current effective case price and shows next month's effective
 * case price (when that edition is already loaded), with an up/down/flat arrow.
 *
 * Renders nothing when there is no next-month price (the common case before the
 * next edition is ingested), so it never clutters a normal month.
 */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Month label for the edition AFTER `edition` (e.g. '2026-06' -> 'Jul'). */
function nextMonthLabel(edition?: string | null): string {
  const m = /^(\d{4})-(\d{1,2})/.exec(edition ?? '');
  if (!m) return '';
  const idx = parseInt(m[2], 10); // 1-based; +1 next month, wraps Dec->Jan
  return MONTHS[idx % 12] ?? '';
}

export default function NextMonthChip({ current, next, edition, className }: {
  current?: number | null;
  next?: number | null;
  edition?: string | null;   // the CURRENT row's edition; label shows the month after it
  className?: string;
}) {
  if (current == null || next == null) return null;
  const d = next - current;
  const dir = d < -0.01 ? 'down' : d > 0.01 ? 'up' : 'flat';
  const mon = nextMonthLabel(edition);
  const Arrow = dir === 'down' ? ArrowDownRight : dir === 'up' ? ArrowUpRight : ArrowRight;
  return (
    <span
      className={`nextmo nextmo-${dir}${className ? ` ${className}` : ''}`}
      title={`Next month${mon ? ` (${mon})` : ''}: $${next.toFixed(2)}/cs vs $${current.toFixed(2)}/cs this month`}
    >
      <span className="nextmo-lab">Next{mon ? ` ${mon}` : ''}</span>
      ${next.toFixed(2)}
      <Arrow size={11} />
    </span>
  );
}
