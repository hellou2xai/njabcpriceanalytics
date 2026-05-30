import { useState, useEffect, useRef, useCallback } from 'react';
import { useLocation } from 'react-router-dom';
import { Sparkles } from 'lucide-react';
import AssistantChat from './AssistantChat';

// App-wide AI assistant as an ADJUSTABLE, DOCKED side panel: opening it shrinks
// the page (the screen output adjusts around it) rather than covering content,
// and a drag handle resizes it. Open state + width persist. Available on every
// page; the dedicated page and font sandbox have their own assistant UI.
const MIN_W = 320, MAX_W = 760;

export default function GlobalAssistant() {
  const location = useLocation();
  const [open, setOpen] = useState<boolean>(() => localStorage.getItem('global_dock_open') === 'true');
  const [width, setWidth] = useState<number>(() => {
    const n = parseInt(localStorage.getItem('global_dock_w') ?? '', 10);
    return Number.isFinite(n) ? Math.min(MAX_W, Math.max(MIN_W, n)) : 400;
  });
  const resize = useRef<{ startX: number; startW: number } | null>(null);

  const suppressed = location.pathname === '/assistant' || location.pathname === '/admin/catalog-font-test';

  // Friendly label for the current screen so the assistant prioritizes the
  // right tools (e.g. Orders -> get_orders, Promotions -> find_deals).
  const PAGE_LABELS: Record<string, string> = {
    '/': 'Dashboard', '/catalog': 'Catalog', '/new-items': 'New Items', '/combos': 'Combos',
    '/time-sensitive': 'Time-Sensitive Deals', '/major-discounts': 'Major Discounts',
    '/price-drops': 'Price Drops', '/price-increases': 'Price Increases',
    '/watchlist': 'Favorites', '/lists': 'Lists', '/orders': 'Orders', '/cart': 'Cart',
    '/analytics': 'Analytics', '/todo': 'To-Do', '/notes': 'Notes', '/alerts': 'Alerts',
  };
  const pageLabel = PAGE_LABELS[location.pathname]
    ?? (location.pathname.startsWith('/orders/') ? 'Order detail' : undefined);

  // Push the page: publish the dock width as a CSS var the main content reads.
  useEffect(() => {
    const w = open && !suppressed ? `${width}px` : '0px';
    document.documentElement.style.setProperty('--global-dock-w', w);
    return () => { document.documentElement.style.setProperty('--global-dock-w', '0px'); };
  }, [open, width, suppressed]);

  useEffect(() => { localStorage.setItem('global_dock_open', String(open)); }, [open]);
  useEffect(() => { localStorage.setItem('global_dock_w', String(width)); }, [width]);

  const onResizeDown = useCallback((e: React.PointerEvent) => {
    resize.current = { startX: e.clientX, startW: width };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none';
  }, [width]);
  const onResizeMove = useCallback((e: React.PointerEvent) => {
    const r = resize.current; if (!r) return;
    // Panel is docked on the RIGHT edge: dragging the handle left widens it.
    setWidth(Math.min(MAX_W, Math.max(MIN_W, r.startW + (r.startX - e.clientX))));
  }, []);
  const onResizeUp = useCallback((e: React.PointerEvent) => {
    resize.current = null;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* */ }
    document.body.style.cursor = ''; document.body.style.userSelect = '';
  }, []);

  if (suppressed) return null;

  if (!open) {
    return (
      <button className="global-assistant-fab" onClick={() => setOpen(true)}
              title="Ask Celar AI Assistant" aria-label="Open Celar AI Assistant">
        <Sparkles size={20} />
      </button>
    );
  }

  return (
    <div className="global-dock" style={{ width }}>
      <div className="global-dock-resizer" role="separator" aria-orientation="vertical"
           aria-label="Resize assistant" title="Drag to resize"
           onPointerDown={onResizeDown} onPointerMove={onResizeMove} onPointerUp={onResizeUp}>
        <span className="ai-resizer-grip" />
      </div>
      <AssistantChat onClose={() => setOpen(false)} pageContext={pageLabel}
        subtitle={pageLabel ? `On ${pageLabel} — ask, compare, or act on products.` : undefined} />
    </div>
  );
}
