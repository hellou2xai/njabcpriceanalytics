import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Check } from 'lucide-react';

/**
 * Global data-loading indicator (mounted in Layout). Shows a thin top progress bar
 * + "Fetching data…" pill ONLY for INITIAL loads, i.e. queries that are fetching
 * with no cached data yet (status 'pending'). Background refetches and mutation
 * invalidations (which already have data) do NOT trigger it, so it appears once
 * when you open a screen rather than flashing on every refresh.
 */
export default function DataRefreshBar() {
  const qc = useQueryClient();
  const [loading, setLoading] = useState(0);
  const [done, setDone] = useState(false);
  const prev = useRef(0);

  useEffect(() => {
    const cache = qc.getQueryCache();
    const compute = () =>
      cache.getAll().filter(q => q.state.fetchStatus === 'fetching' && q.state.status === 'pending').length;
    const update = () => setLoading(compute());
    update();
    return cache.subscribe(update);
  }, [qc]);

  useEffect(() => {
    if (prev.current > 0 && loading === 0) {
      setDone(true);
      const t = setTimeout(() => setDone(false), 1200);
      prev.current = loading;
      return () => clearTimeout(t);
    }
    prev.current = loading;
  }, [loading]);

  if (loading > 0) {
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
        <Check size={13} /> Data loaded
      </div>
    );
  }
  return null;
}
