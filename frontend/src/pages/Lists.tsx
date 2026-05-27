import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, ShoppingCart, Pencil, ClipboardList } from 'lucide-react';
import { lists as listsApi, cart as cartApi } from '../lib/api';
import { ContextMenuProvider } from '../components/ContextMenu';
import { useProductQuickView } from '../components/ProductQuickView';
import ProductThumb from '../components/ProductThumb';
import { distributorName } from '../lib/distributors';

export default function Lists() {
  const qc = useQueryClient();
  const { open } = useProductQuickView();
  const { data: lists } = useQuery({ queryKey: ['lists'], queryFn: listsApi.list });
  const [activeId, setActiveId] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());

  // Default to the first list once loaded.
  useEffect(() => {
    if (activeId == null && lists && lists.length) setActiveId(lists[0].id);
  }, [lists, activeId]);

  const { data: detail } = useQuery({
    queryKey: ['list', activeId],
    queryFn: () => listsApi.get(activeId as number),
    enabled: activeId != null,
  });

  useEffect(() => { setSelected(new Set()); }, [activeId]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['lists'] });
    qc.invalidateQueries({ queryKey: ['list', activeId] });
  };

  const createList = useMutation({
    mutationFn: (name: string) => listsApi.create(name),
    onSuccess: (l) => { qc.invalidateQueries({ queryKey: ['lists'] }); setActiveId(l.id); },
  });
  const renameList = useMutation({
    mutationFn: (v: { id: number; name: string }) => listsApi.rename(v.id, v.name),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['lists'] }),
  });
  const deleteList = useMutation({
    mutationFn: (id: number) => listsApi.remove(id),
    onSuccess: () => { setActiveId(null); qc.invalidateQueries({ queryKey: ['lists'] }); },
  });
  const removeItems = useMutation({
    mutationFn: (ids: number[]) => listsApi.removeItems(activeId as number, ids),
    onSuccess: () => { setSelected(new Set()); refresh(); },
  });
  const moveToCart = useMutation({
    mutationFn: (ids: number[]) => cartApi.fromList(activeId as number, ids.length ? ids : undefined),
    onSuccess: () => { setSelected(new Set()); qc.invalidateQueries({ queryKey: ['cart'] }); },
  });

  const items = detail?.items ?? [];
  const allChecked = items.length > 0 && selected.size === items.length;
  const toggle = (id: number) => setSelected(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleAll = () => setSelected(allChecked ? new Set() : new Set(items.map(i => i.id)));
  const selIds = [...selected];

  return (
    <div className="page">
      <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}><ClipboardList size={22} /> Lists</h2>
      <p style={{ color: 'var(--text-muted)', marginTop: 0 }}>
        Reusable product lists. Select items and move them to your cart, or delete them.
      </p>

      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        {/* List selector */}
        <div className="panel" data-tour="lists-panel" style={{ padding: 10, minWidth: 200 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <strong>My lists</strong>
            <button className="btn btn-secondary btn-sm" data-tour="lists-new" title="New list"
              onClick={() => { const n = prompt('New list name'); if (n) createList.mutate(n); }}><Plus size={14} /></button>
          </div>
          {(lists ?? []).map(l => (
            <div key={l.id}
              onClick={() => setActiveId(l.id)}
              className={`nav-link ${l.id === activeId ? 'active' : ''}`}
              style={{ cursor: 'pointer', justifyContent: 'space-between' }}>
              <span>{l.name}</span>
              <span className="text-muted" style={{ fontSize: 11 }}>{l.item_count}</span>
            </div>
          ))}
          {(lists ?? []).length === 0 && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>No lists yet.</div>}
        </div>

        {/* Selected list */}
        <div className="panel" data-tour="lists-detail" style={{ padding: 12, flex: 1, minWidth: 320 }}>
          {activeId == null ? (
            <p style={{ color: 'var(--text-muted)' }}>Create or pick a list.</p>
          ) : (
            <>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
                <strong>{detail?.name}</strong>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button className="btn btn-secondary btn-sm" title="Rename"
                    onClick={() => { const n = prompt('Rename list', detail?.name); if (n) renameList.mutate({ id: activeId, name: n }); }}><Pencil size={14} /></button>
                  <button className="btn btn-secondary btn-sm" title="Delete list"
                    onClick={() => { if (confirm('Delete this list?')) deleteList.mutate(activeId); }}><Trash2 size={14} /></button>
                </div>
              </div>

              <div style={{ display: 'flex', gap: 8, margin: '10px 0' }} data-tour="lists-move">
                <button className="btn btn-primary btn-sm" disabled={items.length === 0}
                  onClick={() => moveToCart.mutate(selIds)}>
                  <ShoppingCart size={14} /> Move {selIds.length || 'all'} to cart
                </button>
                <button className="btn btn-secondary btn-sm" disabled={selIds.length === 0}
                  onClick={() => removeItems.mutate(selIds)}>
                  <Trash2 size={14} /> Delete selected
                </button>
              </div>

              <ContextMenuProvider onView={open}>
                <table className="catalog-table" data-tour="lists-items">
                  <thead>
                    <tr>
                      <th style={{ width: 28 }}><input type="checkbox" checked={allChecked} onChange={toggleAll} /></th>
                      <th>Product</th>
                      <th>Distributor</th>
                      <th>Size</th>
                      <th style={{ width: 40 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map(it => (
                      <tr key={it.id} data-ctx="" data-ctx-product={it.product_name} data-ctx-wholesaler={it.wholesaler}
                          data-ctx-upc={it.upc ?? ''} data-ctx-volume={it.unit_volume ?? ''}>
                        <td onClick={e => e.stopPropagation()}>
                          <input type="checkbox" checked={selected.has(it.id)} onChange={() => toggle(it.id)} />
                        </td>
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <ProductThumb src={it.image_url} alt={it.product_name} size={56} />
                            <div>
                              <div style={{ fontWeight: 600 }}>{it.product_name}</div>
                              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{it.upc}</div>
                            </div>
                          </div>
                        </td>
                        <td>{distributorName(it.wholesaler)}</td>
                        <td>{it.unit_volume}</td>
                        <td onClick={e => e.stopPropagation()}>
                          <button className="btn btn-secondary btn-sm" title="Remove from list"
                            onClick={() => removeItems.mutate([it.id])}><Trash2 size={14} /></button>
                        </td>
                      </tr>
                    ))}
                    {items.length === 0 && <tr><td colSpan={5} className="empty">No items. Add products from anywhere with right-click → Add to List.</td></tr>}
                  </tbody>
                </table>
              </ContextMenuProvider>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
