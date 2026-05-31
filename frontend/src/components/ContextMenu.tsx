import { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'react-router-dom';
import { Eye, Star, ShoppingCart, Copy, ClipboardList, MoreHorizontal, Globe, Plus, CalendarPlus, X } from 'lucide-react';
import { watchlist, todos, lists as listsApi, cart as cartApi } from '../lib/api';
import { distributorName } from '../lib/distributors';
import { useProductQuickView } from './ProductQuickView';
import { useWebPriceSearch } from './WebPriceSearch';
import { useDialog } from './Dialog';

interface MenuProduct {
  product_name: string;
  wholesaler: string;
  upc?: string;
  unit_volume?: string;
}

interface MenuState extends MenuProduct {
  x: number;
  y: number;
}

interface Props {
  children: React.ReactNode;
}

// Lets any element (e.g. the row "⋯" button) open the shared product menu.
const ProductMenuCtx = createContext<{ openMenu: (p: MenuProduct, anchor: { x: number; y: number }) => void } | null>(null);
export function useProductMenu() {
  const c = useContext(ProductMenuCtx);
  if (!c) throw new Error('useProductMenu must be used within ContextMenuProvider');
  return c;
}

/** Visible "⋯" actions button — opens the same menu as right-click. */
export function RowMenuButton({ product }: { product: MenuProduct }) {
  const { openMenu } = useProductMenu();
  return (
    <button
      type="button"
      className="row-menu-btn"
      title="Product actions"
      aria-label="Product actions"
      onClick={e => {
        e.stopPropagation();
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        openMenu(product, { x: r.left, y: r.bottom + 4 });
      }}
    >
      <MoreHorizontal size={16} />
    </button>
  );
}

// Friendly "source" label for where a product was grabbed from.
const PATH_LABELS: Record<string, string> = {
  '/': 'Dashboard',
  '/catalog': 'Catalog',
  '/discounts': 'Discounts',
  '/clearance': 'Clearance',
  '/combos': 'Combos',
  '/rips': 'Promotions',
  '/rip-products': 'RIP Products',
  '/analytics': 'Analytics',
  '/decisions': 'Decisions',
  '/watchlist': 'Watchlist',
  '/order-analysis': 'Order Analysis',
  '/qa': 'QA',
};

/**
 * Global product action menu. Opens on right-click of any `tr[data-ctx]`
 * (SortableTable emits these automatically) OR via the visible RowMenuButton.
 * Actions: open quick view, add to Order Analysis, add/remove Favorites
 * (watchlist), add to a draft order, copy code.
 */
export function ContextMenuProvider({ children }: Props) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [showLists, setShowLists] = useState(false);
  const [todoDraft, setTodoDraft] = useState<{ product: MenuProduct; source: string } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const qc = useQueryClient();
  const { promptText } = useDialog();
  const location = useLocation();
  const { open } = useProductQuickView();
  const webSearch = useWebPriceSearch();

  const { data: wl } = useQuery({ queryKey: ['watchlist'], queryFn: watchlist.get });
  const { data: myLists } = useQuery({
    queryKey: ['lists'],
    queryFn: listsApi.list,
    enabled: !!menu,
    staleTime: 30000,
  });

  const isTracked = menu ? wl?.some(i => i.product_name === menu.product_name && i.wholesaler === menu.wholesaler) : false;

  const _prod = () => ({
    product_name: menu!.product_name, wholesaler: menu!.wholesaler,
    upc: menu!.upc, unit_volume: menu!.unit_volume,
  });

  const addWl = useMutation({
    mutationFn: () => watchlist.add(_prod()),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['watchlist'] }); setMenu(null); },
  });

  const removeWl = useMutation({
    mutationFn: () => {
      const match = wl?.find(i => i.product_name === menu!.product_name && i.wholesaler === menu!.wholesaler);
      return match ? watchlist.remove(match.id) : Promise.resolve();
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['watchlist'] }); setMenu(null); },
  });

  const addToCart = useMutation({
    mutationFn: () => cartApi.add(_prod()),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['cart'] }); setMenu(null); },
  });

  const addToList = useMutation({
    mutationFn: (listId: number) => listsApi.addItem(listId, _prod()),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['lists'] }); setMenu(null); },
  });

  // Create a new list, then add this product to it.
  const createListAndAdd = useMutation({
    mutationFn: async () => {
      const name = (await promptText({ title: 'New list', placeholder: 'List name', confirmText: 'Create' })) || '';
      if (!name.trim()) return;
      const created = await listsApi.create(name.trim());
      await listsApi.addItem(created.id, _prod());
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['lists'] }); setMenu(null); },
  });

  const close = useCallback(() => { setMenu(null); setShowLists(false); }, []);

  const openMenu = useCallback((p: MenuProduct, anchor: { x: number; y: number }) => {
    let x = anchor.x, y = anchor.y;
    if (x + 240 > window.innerWidth) x = window.innerWidth - 250;
    if (y + 260 > window.innerHeight) y = window.innerHeight - 270;
    setMenu({ ...p, x: Math.max(8, x), y: Math.max(8, y) });
    setShowLists(false);
  }, []);

  useEffect(() => {
    if (!menu) return;
    const handler = (e: MouseEvent | KeyboardEvent) => {
      if ('key' in e && e.key === 'Escape') close();
      else if ('button' in e) close();
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', handler);
    return () => { document.removeEventListener('mousedown', handler); document.removeEventListener('keydown', handler); };
  }, [menu, close]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    const row = (e.target as HTMLElement).closest('tr[data-ctx]');
    if (!row) return;  // not a product row — let the browser show its native menu
    const d = (row as HTMLElement).dataset;
    if (!d.ctxProduct || !d.ctxWholesaler) return;
    e.preventDefault();
    openMenu(
      { product_name: d.ctxProduct, wholesaler: d.ctxWholesaler, upc: d.ctxUpc, unit_volume: d.ctxVolume },
      { x: e.clientX, y: e.clientY },
    );
  }, [openMenu]);

  return (
    <ProductMenuCtx.Provider value={{ openMenu }}>
    <div ref={ref} onContextMenu={handleContextMenu} style={{ display: 'contents' }}>
      {children}
      {menu && (
        <div className="ctx-menu" style={{ top: menu.y, left: menu.x }} onMouseDown={e => e.stopPropagation()}>
          <div className="ctx-header" title={menu.product_name}>{menu.product_name}</div>
          <button className="ctx-item" onClick={() => { open(menu.product_name, menu.wholesaler, undefined, { upc: menu.upc, unitVolume: menu.unit_volume }); close(); }}>
            <Eye size={14} /> View Product
          </button>
          <button className="ctx-item" onClick={() => { webSearch.open({ productName: menu.product_name, wholesaler: menu.wholesaler, upc: menu.upc, unitVolume: menu.unit_volume }); close(); }}>
            <Globe size={14} /> Search the web (prices & details)
          </button>
          <button className="ctx-item" onClick={() => addToCart.mutate()} disabled={addToCart.isPending}>
            <ShoppingCart size={14} /> Add to Cart
          </button>
          <button className="ctx-item" onClick={() => isTracked ? removeWl.mutate() : addWl.mutate()}>
            <Star size={14} fill={isTracked ? 'currentColor' : 'none'} />
            {isTracked ? 'Remove from Favorites' : 'Add to Favorites'}
          </button>
          <button className="ctx-item" onClick={() => setShowLists(!showLists)}>
            <ClipboardList size={14} /> Add to List ▸
          </button>
          {showLists && (
            <div className="ctx-submenu">
              {(myLists ?? []).map(l => (
                <button key={l.id} className="ctx-item" onClick={() => addToList.mutate(l.id)}>
                  {l.name} <span className="text-muted" style={{ marginLeft: 4, fontSize: 11 }}>{l.item_count}</span>
                </button>
              ))}
              <button className="ctx-item" disabled={createListAndAdd.isPending}
                      onClick={() => createListAndAdd.mutate()}>
                <Plus size={14} /> New list…
              </button>
            </div>
          )}
          <button className="ctx-item" onClick={() => {
            setTodoDraft({
              product: { product_name: menu.product_name, wholesaler: menu.wholesaler, upc: menu.upc, unit_volume: menu.unit_volume },
              source: PATH_LABELS[location.pathname] ?? location.pathname,
            });
            close();
          }}>
            <CalendarPlus size={14} /> Add to To-Do
          </button>
          <button className="ctx-item" onClick={() => { navigator.clipboard.writeText(menu.upc || menu.product_name); close(); }}>
            <Copy size={14} /> Copy Code
          </button>
        </div>
      )}
      {todoDraft && <TodoDialog draft={todoDraft} onClose={() => setTodoDraft(null)} />}
    </div>
    </ProductMenuCtx.Provider>
  );
}

function TodoDialog({ draft, onClose }: { draft: { product: MenuProduct; source: string }; onClose: () => void }) {
  const qc = useQueryClient();
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [due, setDue] = useState('');
  const save = useMutation({
    mutationFn: () => todos.create({
      title: title.trim(), note: note.trim() || undefined, due_date: due || undefined,
      product_name: draft.product.product_name, wholesaler: draft.product.wholesaler,
      upc: draft.product.upc, unit_volume: draft.product.unit_volume, source_page: draft.source,
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['todos'] }); onClose(); },
  });
  const field: React.CSSProperties = {
    width: '100%', padding: '9px 12px', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
    background: 'var(--bg)', color: 'var(--text)', fontSize: 14, fontFamily: 'var(--font-sans)',
  };
  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal" style={{ maxWidth: 460 }} onMouseDown={e => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="Close"><X size={18} /></button>
        <h3 style={{ marginTop: 0 }}>Add to To-Do</h3>
        <p className="text-muted" style={{ marginTop: -4, fontSize: 13 }}>
          {draft.product.product_name} · {distributorName(draft.product.wholesaler)} · from {draft.source}
        </p>
        <label style={{ display: 'block', marginTop: 12 }}>
          <span style={{ fontSize: 12.5, fontWeight: 600, display: 'block', marginBottom: 4 }}>What do you want to do?</span>
          <input style={field} autoFocus value={title} onChange={e => setTitle(e.target.value)}
            placeholder="e.g. Compare with Fedway and order 10 cases" />
        </label>
        <label style={{ display: 'block', marginTop: 10 }}>
          <span style={{ fontSize: 12.5, fontWeight: 600, display: 'block', marginBottom: 4 }}>Note</span>
          <textarea style={{ ...field, resize: 'vertical' }} rows={3} value={note} onChange={e => setNote(e.target.value)}
            placeholder="Any details to help you decide later" />
        </label>
        <label style={{ display: 'block', marginTop: 10 }}>
          <span style={{ fontSize: 12.5, fontWeight: 600, display: 'block', marginBottom: 4 }}>Do it by</span>
          <input style={field} type="date" value={due} onChange={e => setDue(e.target.value)} />
        </label>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button className="btn btn-secondary btn-sm" onClick={onClose}>Cancel</button>
          <button className="btn btn-sm" disabled={!title.trim() || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? 'Adding...' : 'Add to To-Do'}
          </button>
        </div>
      </div>
    </div>
  );
}
