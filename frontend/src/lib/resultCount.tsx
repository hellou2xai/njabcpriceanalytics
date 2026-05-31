import { createContext, useCallback, useContext, useState } from 'react';

/** A page reports how many rows its CURRENT filter matched, keyed by its route
 *  path. The docked AI assistant reads this so that when it drives the screen
 *  ("show cheapest tequila") its confirmation can state the exact same count
 *  the grid shows — no separate, possibly-divergent backend count. */
export interface ResultCount {
  path: string;    // location.pathname the count belongs to (no query string)
  count: number;   // number of matched rows
  ts: number;      // when it was reported, so consumers can ignore stale values
}

interface Ctx {
  value: ResultCount | null;
  report: (path: string, count: number) => void;
}

const ResultCountCtx = createContext<Ctx>({ value: null, report: () => {} });

export function ResultCountProvider({ children }: { children: React.ReactNode }) {
  const [value, setValue] = useState<ResultCount | null>(null);
  const report = useCallback((path: string, count: number) => {
    setValue(prev => (prev && prev.path === path && prev.count === count ? prev
      : { path, count, ts: Date.now() }));
  }, []);
  return <ResultCountCtx.Provider value={{ value, report }}>{children}</ResultCountCtx.Provider>;
}

export function useResultCount() {
  return useContext(ResultCountCtx);
}
