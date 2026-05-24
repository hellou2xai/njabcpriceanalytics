import { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'react-router-dom';
import { Eye, Star, ShoppingCart, Copy, ClipboardList, MoreHorizontal, Globe, Plus } from 'lucide-react';
import { watchlist, orders } from '../lib/api';
import { distributorName } from '../lib/distributors';
import { useProductQuickView } from './ProductQuickView';
import { useWebPriceSearch } from './WebPriceSearch';
import { useOrderAnalysis } from '../contexts/OrderAnalysisContext';

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
  const [showOrders, setShowOrders] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const qc = useQueryClient();
  const location = useLocation();
  const { open } = useProductQuickView();
  const webSearch = useWebPriceSearch();
  const oa = useOrderAnalysis();

  const { data: wl } = useQuery({ queryKey: ['watchlist'], queryFn: watchlist.get });
  const { data: draftOrders } = useQuery({
    queryKey: ['orders', 'draft'],
    queryFn: () => orders.list('draft'),
    enabled: !!menu,
    staleTime: 30000,
  });

  const isTracked = menu ? wl?.some(i => i.product_name === menu.product_name && i.wholesaler === menu.wholesaler) : false;
  const inAnalysis = menu ? oa.has(menu) : false;

  const addWl = useMutation({
    mutationFn: () => watchlist.add({ product_name: menu!.product_name, wholesaler: menu!.wholesaler, upc: menu!.upc, unit_volume: menu!.unit_volume }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['watchlist'] }); setMenu(null); },
  });

  const removeWl = useMutation({
    mutationFn: () => {
      const match = wl?.find(i => i.product_name === menu!.product_name && i.wholesaler === menu!.wholesaler);
      return match ? watchlist.remove(match.id) : Promise.resolve();
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['watchlist'] }); setMenu(null); },
  });

  const addToOrder = useMutation({
    mutationFn: (orderId: number) => orders.addLine(orderId, {
      product_name: menu!.product_name, wholesaler: menu!.wholesaler,
      upc: menu!.upc, unit_volume: menu!.unit_volume,
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['orders'] }); setMenu(null); },
  });

  // Create a new draft order for this product's distributor, then add the
  // product to it. Lets the user start their first order from the catalog.
  const createAndAdd = useMutation({
    mutationFn: async () => {
      const created = await orders.create({
        name: `${distributorName(menu!.wholesaler)} order`,
        distributor: menu!.wholesaler,
      });
      await orders.addLine(created.id, {
        product_name: menu!.product_name, wholesaler: menu!.wholesaler,
        upc: menu!.upc, unit_volume: menu!.unit_volume,
      });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['orders'] }); setMenu(null); },
  });

  const close = useCallback(() => { setMenu(null); setShowOrders(false); }, []);

  const openMenu = useCallback((p: MenuProduct, anchor: { x: number; y: number }) => {
    let x = anchor.x, y = anchor.y;
    if (x + 240 > window.innerWidth) x = window.innerWidth - 250;
    if (y + 260 > window.innerHeight) y = window.innerHeight - 270;
    setMenu({ ...p, x: Math.max(8, x), y: Math.max(8, y) });
    setShowOrders(false);
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

  const handleAnalysis = () => {
    if (!menu) return;
    if (inAnalysis) {
      oa.remove(`${menu.wholesaler}|${menu.product_name}|${menu.upc ?? ''}|${menu.unit_volume ?? ''}`);
    } else {
      oa.add({
        product_name: menu.product_name,
        wholesaler: menu.wholesaler,
        upc: menu.upc,
        unit_volume: menu.unit_volume,
        source: PATH_LABELS[location.pathname] ?? location.pathname,
      });
    }
    close();
  };

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
          <button className="ctx-item" onClick={handleAnalysis}>
            <ClipboardList size={14} fill={inAnalysis ? 'currentColor' : 'none'} />
            {inAnalysis ? 'Remove from Order Analysis' : 'Add to Order Analysis'}
          </button>
          <button className="ctx-item" onClick={() => isTracked ? removeWl.mutate() : addWl.mutate()}>
            <Star size={14} fill={isTracked ? 'currentColor' : 'none'} />
            {isTracked ? 'Remove from Favorites' : 'Add to Favorites'}
          </button>
          <button className="ctx-item" onClick={() => setShowOrders(!showOrders)}>
            <ShoppingCart size={14} /> Add to Order ▸
          </button>
          {showOrders && (
            <div className="ctx-submenu">
              {(draftOrders ?? []).map(o => (
                <button key={o.id} className="ctx-item" onClick={() => addToOrder.mutate(o.id)}>
                  {o.name} {o.division && <span className="tag tag-blue" style={{ marginLeft: 4 }}>{o.division}</span>}
                </button>
              ))}
              <button className="ctx-item" disabled={createAndAdd.isPending}
                      onClick={() => createAndAdd.mutate()}>
                <Plus size={14} /> New order for {distributorName(menu.wholesaler)}
              </button>
            </div>
          )}
          <button className="ctx-item" onClick={() => { navigator.clipboard.writeText(menu.upc || menu.product_name); close(); }}>
            <Copy size={14} /> Copy Code
          </button>
        </div>
      )}
    </div>
    </ProductMenuCtx.Provider>
  );
}
