import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { cart as cartApi, watchlist, lists as listsApi, salesReps } from './api';
import type { CatalogAiAction } from './api';
import { useDialog } from '../components/Dialog';

// Executes the human-style actions an assistant resolved (add to cart / set
// quantity / favorite / add to list) against the same APIs the buttons use.
// Shared by the catalog sidebar, the Celar full page, and the global drawer so
// behaviour is identical everywhere.
export function useAssistantActions() {
  const qc = useQueryClient();
  const { confirm } = useDialog();

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
        } else if (a.type === 'swap_distributor') {
          if (a.from_distributor && a.to_distributor) {
            // Confirm before a swap — it removes and re-adds cart lines. Count the
            // affected source lines so the prompt is concrete.
            let n = 0;
            try {
              const c = await cartApi.get();
              n = (c.items ?? []).filter(it => !it.saved_for_later
                && (it.wholesaler ?? '').toLowerCase() === a.from_distributor!.toLowerCase()).length;
            } catch { /* fall back to a generic count */ }
            const scope = a.rip_code ? ` in the RIP ${a.rip_code} case mix` : '';
            const ok = await confirm({
              title: `Swap ${a.from_distributor} → ${a.to_distributor}?`,
              message: `This replaces ${n ? `${n} ` : 'your '}${a.from_distributor} cart item${n === 1 ? '' : 's'}${scope} `
                + `with the same products at ${a.to_distributor}, keeping quantities. `
                + `Anything ${a.to_distributor} doesn't carry stays as-is.`,
              confirmText: 'Swap', cancelText: 'Keep as-is',
            });
            if (!ok) continue;
            await cartApi.swapDistributor({
              from_distributor: a.from_distributor,
              to_distributor: a.to_distributor,
              rip_code: a.rip_code ?? undefined,
              upcs: a.swap_upcs ?? undefined,
            });
          }
        } else if (a.type === 'submit_order') {
          // Send the cart as orders (one per sales rep), each emailed. Irreversible
          // — confirm with a concrete count first.
          let n = 0;
          try {
            const c = await cartApi.get();
            n = (c.items ?? []).filter(it => !it.saved_for_later).length;
          } catch { /* generic prompt */ }
          const ok = await confirm({
            title: 'Send order to your sales rep(s)?',
            message: `This submits ${n ? `${n} ` : 'your '}cart item${n === 1 ? '' : 's'} as orders `
              + `(one per sales rep) and emails each rep, then clears those items from your cart. `
              + `Items with no sales rep assigned will be left in the cart.`,
            confirmText: 'Send order', cancelText: 'Not yet',
          });
          if (!ok) continue;
          await cartApi.send();
        } else if (a.type === 'reorder') {
          if (a.order_id != null) {
            const ok = await confirm({
              title: 'Reorder this order?',
              message: 'This copies that order\'s items back into your cart (quantities preserved). '
                + 'You can review and adjust before sending.',
              confirmText: 'Add to cart', cancelText: 'Cancel',
            });
            if (!ok) continue;
            await cartApi.reorder(a.order_id);
          }
        } else if (a.type === 'message_rep') {
          if (a.rep_id != null && a.message) {
            const ok = await confirm({
              title: 'Email your sales rep?',
              message: `Send this message to your rep?\n\n"${a.message}"`,
              confirmText: 'Send email', cancelText: 'Cancel',
            });
            if (!ok) continue;
            await salesReps.message(a.rep_id, a.message);
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
  }, [qc, confirm]);

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
    else if (a.type === 'swap_distributor') chips.push(`🔁 Swap ${a.from_distributor ?? '?'} → ${a.to_distributor ?? '?'}${a.rip_code ? ` (RIP ${a.rip_code})` : ''}`);
    else if (a.type === 'submit_order') chips.push('📧 Send order to sales rep');
    else if (a.type === 'reorder') chips.push('🔄 Reorder past order to cart');
    else if (a.type === 'message_rep') chips.push('✉️ Message sales rep');
    if (a.note) chips.push(`⚠ ${a.note}`);
  }
  return chips;
}
