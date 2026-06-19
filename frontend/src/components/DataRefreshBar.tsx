import { useSyncExternalStore } from 'react';
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Check } from 'lucide-react';

/**
 * Global data-loading indicator (mounted in Layout). Shows a thin top progress bar
 * + "Fetching data…" pill ONLY for INITIAL loads, i.e. queries that are fetching
 * with no cached data yet (status 'pending'). Background refetches and mutation
 * invalidations (which already have data) do NOT trigger it, so it appears once
 * when you open a screen rather than flashing on every refresh.
 *
 * IMPLEMENTATION: we read the query-cache via useSyncExternalStore so the read
 * is render-phase safe. The earlier implementation used cache.subscribe(setState)
 * inside a useEffect, which fires the setState SYNCHRONOUSLY when a child's
 * useQuery touches the cache during its own render — that produced React's
 * "Cannot update a component (DataRefreshBar) while rendering a different
 * component (DealSparkline / FavoriteButton / AddToListButton)" warning on
 * pages with many query-using children (Time-Sensitive Deals saw 11 of these
 * per render). useSyncExternalStore handles the subscribe + read in one
 * concurrent-safe step, no setState during another component's render.
 */
export default function DataRefreshBar() {
  const qc = useQueryClient();

  // Subscribe once to the query cache; the snapshot getter counts queries
  // that are fetching for the first time (no cached data yet). React calls
  // these from the right phase, so we no longer fire setState during a
  // child render.
  const loading = useSyncExternalStore(
    (cb) => {
      const cache = qc.getQueryCache();
      return cache.subscribe(cb);
    },
    () => qc.getQueryCache().getAll().filter(q =>
      q.state.fetchStatus === 'fetching' && q.state.status === 'pending'
      // Background/lazy enrichment (per-card sparkline + best-price fetches,
      // product-size lookups) populates progressively AFTER the page is usable,
      // so it must NOT keep the global "Fetching data…" bar lit. Such queries
      // opt out via meta:{background:true}; only foreground page loads count.
      && (q.meta as { background?: boolean } | undefined)?.background !== true
    ).length,
    // Server snapshot (SSR / first render before subscribe): nothing fetching.
    () => 0,
  );

  // "Data loaded" flash lives in its own useEffect because the snapshot
  // transition (>0 to 0) is the cheap signal we already have; this stays
  // unchanged from the previous implementation.
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (loading > 0) return;
    // Only flash done if we ever saw a non-zero count. Skip on the very
    // first render where loading starts at 0.
    let cancelled = false;
    const t = setTimeout(() => { if (!cancelled) setDone(false); }, 1200);
    return () => { cancelled = true; clearTimeout(t); };
  }, [loading]);
  // Set "done = true" when the count drops to zero from a higher value.
  // Using a ref-equivalent via state on transitions; same idea as the
  // previous prev.current pattern, kept minimal.
  const [prev, setPrev] = useState(0);
  useEffect(() => {
    if (prev > 0 && loading === 0) setDone(true);
    if (prev !== loading) setPrev(loading);
  }, [loading, prev]);

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
