import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { catalog, type Combo } from '../lib/api';

// A product the user has set aside for analysis while browsing. Stored
// client-side (localStorage) — a lightweight "temporary area" decoupled from
// the persisted Watchlist and Orders. We keep an enriched snapshot so the
// Order Analysis screen can render a catalog-like view without re-querying.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type EnrichedProduct = Record<string, any>;

export interface OrderAnalysisItem {
  key: string;
  product_name: string;
  wholesaler: string;
  upc?: string;
  unit_volume?: string;
  product?: EnrichedProduct;   // enriched row from /api/catalog/product
  source?: string;             // which screen/feature it was added from
  reason?: string;             // user's note: why this looked like a deal
  combo_code?: string;         // set when this product was added as part of a combo bundle
  combo_label?: string;        // human label for the combo (its contents)
  added_at: string;
}

export interface AddArgs {
  product_name: string;
  wholesaler: string;
  upc?: string;
  unit_volume?: string;
  source?: string;
  reason?: string;
  combo_code?: string;
  combo_label?: string;
}

interface Ctx {
  items: OrderAnalysisItem[];
  count: number;
  has: (args: { product_name: string; wholesaler: string; upc?: string; unit_volume?: string }) => boolean;
  add: (args: AddArgs) => void;
  addCombo: (combo: Combo) => number;
  remove: (key: string) => void;
  clear: () => void;
  setReason: (key: string, reason: string) => void;
}

const STORAGE_KEY = 'lpb_order_analysis';

const makeKey = (a: { product_name: string; wholesaler: string; upc?: string; unit_volume?: string; combo_code?: string }) =>
  `${a.wholesaler}|${a.product_name}|${a.upc ?? ''}|${a.unit_volume ?? ''}${a.combo_code ? '|' + a.combo_code : ''}`;

function load(): OrderAnalysisItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

const OrderAnalysisCtx = createContext<Ctx | null>(null);

export function useOrderAnalysis(): Ctx {
  const ctx = useContext(OrderAnalysisCtx);
  if (!ctx) throw new Error('useOrderAnalysis must be used within OrderAnalysisProvider');
  return ctx;
}

export function OrderAnalysisProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<OrderAnalysisItem[]>(load);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  }, [items]);

  const has: Ctx['has'] = useCallback(
    (a) => {
      const k = makeKey(a);
      return items.some(i => i.key === k);
    },
    [items],
  );

  // Fetch the canonical catalog row (WITH unified discount/RIP tiers) and merge
  // it into the stored item. Used on add and to backfill older snapshots.
  const enrich = useCallback((target: { key: string; product_name: string; wholesaler: string; upc?: string; unit_volume?: string }) => {
    catalog
      .search({ q: target.upc || target.product_name, wholesaler: target.wholesaler, include_tiers: true, limit: 100 })
      .then(res => {
        const rows = (res?.items ?? []) as EnrichedProduct[];
        const match = rows.find(r =>
          r.product_name === target.product_name && r.wholesaler === target.wholesaler &&
          (!target.upc || String(r.upc) === String(target.upc)) &&
          (!target.unit_volume || r.unit_volume === target.unit_volume)
        ) ?? rows[0];
        if (match) setItems(prev => prev.map(i => (i.key === target.key ? { ...i, product: match } : i)));
      })
      .catch(() => { /* keep the minimal snapshot if enrichment fails */ });
  }, []);

  // Backfill enrichment (incl. tiers) once on mount for items saved before
  // tiers were captured, or whose price snapshot may be stale.
  useEffect(() => {
    items.forEach(it => {
      if (!it.product || !(it.product as EnrichedProduct).tiers) {
        enrich({ key: it.key, product_name: it.product_name, wholesaler: it.wholesaler, upc: it.upc, unit_volume: it.unit_volume });
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const add: Ctx['add'] = useCallback((args) => {
    const key = makeKey(args);
    setItems(prev => {
      if (prev.some(i => i.key === key)) {
        // Already present — refresh source/reason if provided.
        return prev.map(i => i.key === key
          ? { ...i, source: args.source ?? i.source, reason: args.reason ?? i.reason }
          : i);
      }
      return [
        ...prev,
        {
          key,
          product_name: args.product_name,
          wholesaler: args.wholesaler,
          upc: args.upc,
          unit_volume: args.unit_volume,
          source: args.source,
          reason: args.reason,
          combo_code: args.combo_code,
          combo_label: args.combo_label,
          added_at: new Date().toISOString(),
        },
      ];
    });

    // Enrich (incl. discount/RIP tiers) so the analysis screen renders an
    // exact catalog row with the per-tier sub-rows.
    enrich({ key, product_name: args.product_name, wholesaler: args.wholesaler, upc: args.upc, unit_volume: args.unit_volume });
  }, [enrich]);

  // Add EVERY product in a combo (tagged with combo_code) so the bundle's items
  // are collected together and identifiable as one deal.
  const addCombo: Ctx['addCombo'] = useCallback((combo) => {
    const label = combo.comments || `Combo ${combo.combo_code}`;
    let added = 0;
    for (const comp of combo.components ?? []) {
      if (!comp.product_name) continue;
      add({
        product_name: comp.product_name,
        wholesaler: combo.wholesaler,
        upc: comp.upc ?? undefined,
        source: 'Combo',
        combo_code: combo.combo_code,
        combo_label: label,
      });
      added += 1;
    }
    return added;
  }, [add]);

  const remove: Ctx['remove'] = useCallback((key) => {
    setItems(prev => prev.filter(i => i.key !== key));
  }, []);

  const clear: Ctx['clear'] = useCallback(() => setItems([]), []);

  const setReason: Ctx['setReason'] = useCallback((key, reason) => {
    setItems(prev => prev.map(i => (i.key === key ? { ...i, reason } : i)));
  }, []);

  const value = useMemo<Ctx>(
    () => ({ items, count: items.length, has, add, addCombo, remove, clear, setReason }),
    [items, has, add, addCombo, remove, clear, setReason],
  );

  return <OrderAnalysisCtx.Provider value={value}>{children}</OrderAnalysisCtx.Provider>;
}
