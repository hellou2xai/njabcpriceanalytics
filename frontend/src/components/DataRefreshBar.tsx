import { useEffect, useRef, useState } from 'react';
import { useIsFetching } from '@tanstack/react-query';
import { RefreshCw, Check } from 'lucide-react';

/**
 * A small global status pill that shows whenever any page is fetching data
 * (first load or a refresh), then briefly confirms "Data refreshed" when the
 * fetches finish. Driven by React Query's global fetch count, so it works on
 * every page without each one wiring up its own indicator.
 */
export default function DataRefreshBar() {
  const fetching = useIsFetching();
  const prev = useRef(0);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (prev.current > 0 && fetching === 0) {
      setDone(true);
      const t = setTimeout(() => setDone(false), 1800);
      prev.current = fetching;
      return () => clearTimeout(t);
    }
    prev.current = fetching;
  }, [fetching]);

  if (fetching > 0) {
    return (
      <div className="data-refresh-bar is-refreshing" role="status" aria-live="polite">
        <RefreshCw size={13} className="drb-spin" /> Refreshing data…
      </div>
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
