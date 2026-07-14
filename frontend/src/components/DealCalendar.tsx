import { ChevronLeft, ChevronRight } from 'lucide-react';

/** A validity window for a time-sensitive deal (inclusive ISO dates). */
export interface DealWindow {
  from: string;   // YYYY-MM-DD
  to: string;     // YYYY-MM-DD
}

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

type DayState = 'none' | 'ended' | 'live' | 'upcoming';

/** One month grid. Days covered by a deal window are colour-coded relative to
 *  TODAY: ended (grey), live (green), upcoming (amber). Prev/next step the month
 *  (bounded by the editions actually on file), so a buyer can look back at
 *  expired deals. Pure date-string math — no timezone drift. */
export default function DealCalendar({
  month, windows, today, onPrev, onNext, canPrev, canNext,
}: {
  month: string;                 // 'YYYY-MM' shown
  windows: DealWindow[];
  today: string;                 // 'YYYY-MM-DD'
  onPrev?: () => void;
  onNext?: () => void;
  canPrev?: boolean;
  canNext?: boolean;
}) {
  const [y, m] = month.split('-').map(Number);          // m = 1..12
  const daysInMonth = new Date(y, m, 0).getDate();
  const firstWeekday = new Date(y, m - 1, 1).getDay();  // 0 = Sun
  const iso = (d: number) => `${month}-${String(d).padStart(2, '0')}`;

  const stateOf = (d: number): DayState => {
    const ds = iso(d);
    const covering = windows.filter(w => w.from <= ds && ds <= w.to);
    if (!covering.length) return 'none';
    if (ds < today) return 'ended';
    // day is today or later and sits inside a window: live if that window has
    // already started, otherwise it's a not-yet-started (upcoming) deal.
    return covering.some(w => w.from <= today) ? 'live' : 'upcoming';
  };

  const cells: (number | null)[] = [
    ...Array(firstWeekday).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];

  return (
    <div className="tsd-cal">
      <div className="tsd-cal-head">
        <button type="button" className="tsd-cal-nav" onClick={onPrev} disabled={!canPrev}
          aria-label="Previous month"><ChevronLeft size={14} /></button>
        <span className="tsd-cal-title">{MONTHS[m - 1]} {y}</span>
        <button type="button" className="tsd-cal-nav" onClick={onNext} disabled={!canNext}
          aria-label="Next month"><ChevronRight size={14} /></button>
      </div>
      <div className="tsd-cal-grid">
        {WEEKDAYS.map((w, i) => <span key={`h${i}`} className="tsd-cal-wd">{w}</span>)}
        {cells.map((d, i) => {
          if (d === null) return <span key={`e${i}`} className="tsd-cal-day tsd-cal-empty" />;
          const st = stateOf(d);
          const isToday = iso(d) === today;
          return (
            <span key={d}
              className={`tsd-cal-day tsd-day-${st}${isToday ? ' tsd-cal-today' : ''}`}
              title={st === 'none' ? undefined
                : `${MONTHS[m - 1]} ${d} — deal ${st === 'ended' ? 'ended' : st === 'live' ? 'active' : 'upcoming'}`}>
              {d}
            </span>
          );
        })}
      </div>
      <div className="tsd-cal-legend">
        <span><i className="tsd-dot tsd-dot-live" /> Active</span>
        <span><i className="tsd-dot tsd-dot-upcoming" /> Upcoming</span>
        <span><i className="tsd-dot tsd-dot-ended" /> Ended</span>
      </div>
    </div>
  );
}
