import { useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, ShoppingCart, Pencil, ClipboardList } from 'lucide-react';
import { lists as listsApi, cart as cartApi, type ListItem } from '../lib/api';
import { ContextMenuProvider } from '../components/ContextMenu';
import { useProductQuickView } from '../components/ProductQuickView';
import ProductThumb from '../components/ProductThumb';
import { distributorName } from '../lib/distributors';
import { useDialog } from '../components/Dialog';

const LIST_RIP_GROUP_KEY = 'celr_lists_group_by_rip';
function ripHueLocal(code: string): number {
  let h = 0;
  for (let i = 0; i < code.length; i++) h = (h * 31 + code.charCodeAt(i)) % 360;
  return h;
}

export default function Lists() {
  const qc = useQueryClient();
  const { confirm, promptText } = useDialog();
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

  // Auto-on Group by RIP the first time the list contains a RIP-tied item,
  // mirroring the cart behaviour. The user can still uncheck to flatten.
  const [groupByRip, setGroupByRip] = useState<boolean>(() => localStorage.getItem(LIST_RIP_GROUP_KEY) === '1');
  const toggleGroupByRip = (on: boolean) => {
    setGroupByRip(on);
    if (on) localStorage.setItem(LIST_RIP_GROUP_KEY, '1');
    else localStorage.removeItem(LIST_RIP_GROUP_KEY);
  };
  const hasRipItem = useMemo(
    () => items.some(i => i.rip_code && String(i.rip_code).trim()),
    [items],
  );
  useEffect(() => {
    if (hasRipItem && !groupByRip && localStorage.getItem(LIST_RIP_GROUP_KEY) === null) {
      setGroupByRip(true);
    }
  }, [hasRipItem, groupByRip]);

  // Bucket items by rip_code when grouping is on.
  const buckets = useMemo(() => {
    if (!groupByRip) return null;
    const m = new Map<string, ListItem[]>();
    const unrebated: ListItem[] = [];
    for (const it of items) {
      const rc = it.rip_code && String(it.rip_code).trim();
      if (!rc) { unrebated.push(it); continue; }
      if (!m.has(rc)) m.set(rc, []);
      m.get(rc)!.push(it);
    }
    return {
      groups: [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])),
      unrebated,
    };
  }, [items, groupByRip]);

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
              onClick={async () => { const n = await promptText({ title: 'New list', placeholder: 'List name', confirmText: 'Create' }); if (n) createList.mutate(n); }}><Plus size={14} /></button>
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
                    onClick={async () => { const n = await promptText({ title: 'Rename list', defaultValue: detail?.name, confirmText: 'Rename' }); if (n) renameList.mutate({ id: activeId, name: n }); }}><Pencil size={14} /></button>
                  <button className="btn btn-secondary btn-sm" title="Delete list"
                    onClick={async () => { if (await confirm({ title: 'Delete this list?', message: 'The list and its saved items will be removed.', confirmText: 'Delete', danger: true })) deleteList.mutate(activeId); }}><Trash2 size={14} /></button>
                </div>
              </div>

              <div style={{ display: 'flex', gap: 8, margin: '10px 0', alignItems: 'center', flexWrap: 'wrap' }} data-tour="lists-move">
                <button className="btn btn-primary btn-sm" disabled={items.length === 0}
                  onClick={() => moveToCart.mutate(selIds)}>
                  <ShoppingCart size={14} /> Move {selIds.length || 'all'} to cart
                </button>
                <button className="btn btn-secondary btn-sm" disabled={selIds.length === 0}
                  onClick={() => removeItems.mutate(selIds)}>
                  <Trash2 size={14} /> Delete selected
                </button>
                <label style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}
                  title="Sub-group list items that share a RIP rebate code, with a colour band per RIP">
                  <input type="checkbox" checked={groupByRip} onChange={e => toggleGroupByRip(e.target.checked)} />
                  Group by RIP
                </label>
              </div>

              <ContextMenuProvider onView={open}>
                {buckets ? (
                  <>
                    {buckets.groups.map(([rc, lines]) => {
                      const hue = ripHueLocal(rc);
                      const allBucketIds = lines.map(l => l.id);
                      const bucketChecked = lines.every(l => selected.has(l.id));
                      const toggleBucket = () => {
                        setSelected(prev => {
                          const next = new Set(prev);
                          if (bucketChecked) allBucketIds.forEach(id => next.delete(id));
                          else allBucketIds.forEach(id => next.add(id));
                          return next;
                        });
                      };
                      return (
                        <div key={`list-rip-${rc}`} className="cart-rip-group" style={{
                          borderLeftColor: `hsl(${hue} 65% 55%)`,
                          background: `linear-gradient(180deg, hsl(${hue} 75% 97%) 0%, var(--surface) 16px)`,
                          marginBottom: 10,
                        }}>
                          <div className="cart-rip-group-header">
                            <input type="checkbox" checked={bucketChecked} onChange={toggleBucket} title="Select every line in this RIP group" />
                            <span className="cart-rip-group-badge" style={{
                              background: `hsl(${hue} 75% 93%)`, color: `hsl(${hue} 65% 28%)`, borderColor: `hsl(${hue} 60% 78%)`,
                            }}>🔗 RIP {rc}</span>
                            <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>
                              {lines.length} line{lines.length === 1 ? '' : 's'}
                            </span>
                            <button
                              className="btn btn-primary btn-sm"
                              title={`Move every line under RIP ${rc} to the cart`}
                              onClick={() => moveToCart.mutate(allBucketIds)}
                            >
                              <ShoppingCart size={13} /> Move all to cart
                            </button>
                          </div>
                          <table className="catalog-table">
                            <tbody>
                              {lines.map(it => <ListRow key={it.id} it={it} selected={selected} toggle={toggle} onRemove={() => removeItems.mutate([it.id])} />)}
                            </tbody>
                          </table>
                        </div>
                      );
                    })}
                    {buckets.unrebated.length > 0 && (
                      <div className="cart-rip-group" style={{ borderLeftColor: 'var(--border)' }}>
                        <div className="cart-rip-group-header">
                          <span style={{ fontWeight: 600 }}>No RIP rebate</span>
                          <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>
                            {buckets.unrebated.length} line{buckets.unrebated.length === 1 ? '' : 's'}
                          </span>
                        </div>
                        <table className="catalog-table">
                          <tbody>
                            {buckets.unrebated.map(it => <ListRow key={it.id} it={it} selected={selected} toggle={toggle} onRemove={() => removeItems.mutate([it.id])} />)}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </>
                ) : (
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
                      {items.map(it => <ListRow key={it.id} it={it} selected={selected} toggle={toggle} onRemove={() => removeItems.mutate([it.id])} />)}
                      {items.length === 0 && <tr><td colSpan={5} className="empty">No items. Add products from anywhere with right-click → Add to List.</td></tr>}
                    </tbody>
                  </table>
                )}
              </ContextMenuProvider>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ListRow({ it, selected, toggle, onRemove }: {
  it: ListItem;
  selected: Set<number>;
  toggle: (id: number) => void;
  onRemove: () => void;
}) {
  return (
    <tr data-ctx="" data-ctx-product={it.product_name} data-ctx-wholesaler={it.wholesaler}
        data-ctx-upc={it.upc ?? ''} data-ctx-volume={it.unit_volume ?? ''}>
      <td style={{ width: 28 }} onClick={e => e.stopPropagation()}>
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
      <td style={{ width: 40 }} onClick={e => e.stopPropagation()}>
        <button className="btn btn-secondary btn-sm" title="Remove from list" onClick={onRemove}><Trash2 size={14} /></button>
      </td>
    </tr>
  );
}
