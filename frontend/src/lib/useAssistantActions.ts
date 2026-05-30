import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { cart as cartApi, watchlist, lists as listsApi } from './api';
import type { CatalogAiAction } from './api';

// Executes the human-style actions an assistant resolved (add to cart / set
// quantity / favorite / add to list) against the same APIs the buttons use.
// Shared by the catalog sidebar, the Celar full page, and the global drawer so
// behaviour is identical everywhere.
export function useAssistantActions() {
  const qc = useQueryClient();

  const runActions = useCallback(async (actions: CatalogAiAction[] | undefined) => {
    for (const a of actions ?? []) {
      try {
        if (a.type === 'add_to_cart' || a.type === 'update_quantity') {
          for (const p of a.products) {
            await cartApi.add({
              product_name: p.product_name, wholesaler: p.wholesaler,
              upc: p.upc ?? undefined, unit_volume: p.unit_volume ?? undefined,
              qty_cases: a.cases || 0, qty_units: a.bottles || 0,
            });
          }
        } else if (a.type === 'add_to_favorites') {
          for (const p of a.products) {
            await watchlist.add({
              product_name: p.product_name, wholesaler: p.wholesaler,
              upc: p.upc ?? undefined, unit_volume: p.unit_volume ?? undefined,
            });
          }
        } else if (a.type === 'add_to_list') {
          const name = (a.list_name || 'AI List').trim();
          const existing = await listsApi.list();
          let target = existing.find(l => l.name.toLowerCase() === name.toLowerCase());
          if (!target) target = await listsApi.create(name);
          for (const p of a.products) {
            await listsApi.addItem(target.id, {
              product_name: p.product_name, wholesaler: p.wholesaler,
              upc: p.upc ?? undefined, unit_volume: p.unit_volume ?? undefined,
            });
          }
        }
      } catch { /* keep going on partial failures */ }
    }
    if ((actions ?? []).length) {
      qc.invalidateQueries({ queryKey: ['cart'] });
      qc.invalidateQueries({ queryKey: ['watchlist'] });
      qc.invalidateQueries({ queryKey: ['lists'] });
    }
  }, [qc]);

  return { runActions };
}

// Pure: short chips describing what an action did, for display under an answer.
export function describeActions(actions: CatalogAiAction[] | undefined): string[] {
  const chips: string[] = [];
  for (const a of actions ?? []) {
    const names = a.products.map(p => p.product_name);
    const label = names.length === 1 ? names[0] : `${names.length} items`;
    if (a.type === 'add_to_cart') chips.push(`🛒 ${label}${a.cases ? ` ×${a.cases}cs` : ''}${a.bottles ? ` ×${a.bottles}btl` : ''}`);
    else if (a.type === 'update_quantity') chips.push(`✏️ ${label} → ${a.cases}cs / ${a.bottles}btl`);
    else if (a.type === 'add_to_favorites') chips.push(`⭐ ${label}`);
    else if (a.type === 'add_to_list') chips.push(`📋 ${a.list_name ?? 'List'} (+${a.products.length})`);
    if (a.note) chips.push(`⚠ ${a.note}`);
  }
  return chips;
}
