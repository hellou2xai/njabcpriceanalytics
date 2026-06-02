// Shared helpers for rendering RIP / discount validity windows and their
// status badges. The backend (pricing.window_status) stamps every tier with
// from_date / to_date / window_status / days_to_expire; these turn that into
// human labels + a CSS class. Lifted from the per-page helpers in
// TimeSensitive.tsx so the modal, catalog grid and sparkline all agree.
import type { WindowStatus, TierWindow } from './api';

// Short 'Jun 8' style date.
export function fmtDay(d?: string | null): string {
  if (!d) return '';
  const dt = new Date(d + 'T00:00:00');
  if (isNaN(dt.getTime())) return '';
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function fmtDateRange(from?: string | null, to?: string | null): string {
  if (from && to) return `${fmtDay(from)} to ${fmtDay(to)}`;
  return fmtDay(from || to);
}

export interface WindowBadge {
  label: string;          // e.g. "Active now", "Expires in 6 days", "Starts Jun 11"
  cls: string;            // CSS class for colour (see dealDates.css)
  urgent: boolean;        // true when active and expiring within a week
}

// Map a tier's window to a badge. Whole-month / evergreen tiers return null:
// they're the dependable monthly price and don't need a time badge.
export function windowBadge(t: TierWindow): WindowBadge | null {
  const status: WindowStatus | null | undefined = t.window_status;
  const dte = t.days_to_expire;
  if (!status || status === 'whole_month' || status === 'evergreen') return null;
  if (status === 'expired') {
    const ago = dte == null ? null : -dte;
    return {
      label: ago == null ? 'Expired' : `Expired ${ago} day${ago === 1 ? '' : 's'} ago`,
      cls: 'win-expired',
      urgent: false,
    };
  }
  if (status === 'upcoming') {
    return { label: `Starts ${fmtDay(t.from_date)}`, cls: 'win-upcoming', urgent: false };
  }
  // active
  let label: string;
  if (dte == null) label = 'Active now';
  else if (dte <= 0) label = 'Ends today';
  else if (dte === 1) label = 'Ends tomorrow';
  else label = `Expires in ${dte} days`;
  return { label, cls: 'win-active', urgent: dte != null && dte <= 7 };
}
