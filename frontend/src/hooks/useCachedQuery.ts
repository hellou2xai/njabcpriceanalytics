import { useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';

/**
 * Catalogue data only changes when a monthly edition is ingested, so the
 * storefront pages (Home rails, Products category aisles) cache hard:
 * a localStorage snapshot paints instantly on the next visit (even after a
 * full reload) and react-query refetches in the background only once the
 * snapshot is older than STALE_MS.
 *
 * `persist: false` keeps the long in-memory staleTime but skips localStorage,
 * for volatile keys (live search keystrokes, deep filter combos, page > 0)
 * where persisting every variation would blow the quota for no benefit.
 */
const STALE_MS = 6 * 60 * 60 * 1000; // 6h
const PREFIX = 'celr-cache:';

// One-time migration: drop snapshots written under the old Home-only prefix.
try {
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if (k && k.startsWith('celr-home-cache:')) localStorage.removeItem(k);
  }
} catch { /* storage unavailable */ }

export function useCachedQuery<T>(
  key: (string | number | boolean)[],
  fn: () => Promise<T>,
  opts: { enabled?: boolean; persist?: boolean } = {},
) {
  const { enabled = true, persist = true } = opts;
  const storageKey = `${PREFIX}${key.join(':')}`;
  // Memoised per key so the JSON.parse runs once per aisle, not per render.
  const seed = useMemo(() => {
    if (!persist) return undefined;
    try {
      const raw = localStorage.getItem(storageKey);
      return raw ? (JSON.parse(raw) as { t: number; data: T }) : undefined;
    } catch { return undefined; }
  }, [persist, storageKey]);
  const q = useQuery({
    queryKey: key,
    queryFn: fn,
    enabled,
    staleTime: STALE_MS,
    gcTime: 24 * 60 * 60 * 1000,
    refetchOnWindowFocus: false,
    initialData: seed?.data,
    initialDataUpdatedAt: seed?.t,
  });
  useEffect(() => {
    if (!persist || q.data === undefined) return;
    try { localStorage.setItem(storageKey, JSON.stringify({ t: Date.now(), data: q.data })); }
    catch { /* quota exceeded: in-memory cache still applies */ }
  }, [persist, q.data, storageKey]);
  return q;
}
