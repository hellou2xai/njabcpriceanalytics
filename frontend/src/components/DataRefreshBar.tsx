import { useEffect, useRef, useState } from 'react';
import { useIsFetching } from '@tanstack/react-query';
import { RefreshCw, Check } from 'lucide-react';

/**
 * Global data-loading indicator shown on every page (mounted in Layout):
 *   - a thin animated progress bar across the very top of the window, plus a
 *     "Fetching data…" pill, whenever ANY page is fetching (first load or refresh)
 *   - a brief "Data refreshed" confirmation when the fetches finish.
 * Driven by React Query's global fetch count, so no page has to wire its own.
 */
export default function DataRefreshBar() {
  const fetching = useIsFetching();
  const prev = useRef(0);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (prev.current > 0 && fetching === 0) {
      setDone(true);
      const t = setTimeout(() => setDone(false), 1500);
      prev.current = fetching;
      return () => clearTimeout(t);
    }
    prev.current = fetching;
  }, [fetching]);

  if (fetching > 0) {
    return (
      <>
        <div className="data-progress"><div className="data-progress-fill" /></div>
        <div className="data-refresh-bar is-refreshing" role="status" aria-live="polite">
          <RefreshCw size={13} className="drb-spin" /> Fetching data…
        </div>
      </>
    );
  }
  if (done) {
    return (
      <div className="data-refresh-bar is-done" role="status" aria-live="polite">
        <Check size={13} /> Data refreshed
      </div>
    );
  }
  return null;
}
