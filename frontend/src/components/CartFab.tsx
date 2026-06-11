import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ShoppingCart } from 'lucide-react';

// Floating cart button. It used to be a plain fixed-position <Link> pinned to
// the top-right, which could sit on top of page content and block it. Now it's
// draggable: press and drag to reposition, and the spot you drop it in is
// remembered (localStorage) across reloads. A press that doesn't move still
// counts as a click and navigates to the cart, so the common case is unchanged.

const SIZE = 42;
const MARGIN = 8;          // keep this far from every viewport edge
const DRAG_THRESHOLD = 4;  // px of movement before a press becomes a drag
const POS_KEY = 'cart_fab_pos';

interface Pos { x: number; y: number }

function dockWidth(): number {
  // The Celar assistant publishes its current width as a CSS var. When the
  // dock is open we have to reserve that strip on the right so the FAB
  // doesn't slide behind it (and clip its badge against the viewport edge).
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--global-dock-w').trim();
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : 0;
}

function clampToViewport(x: number, y: number): Pos {
  const dw = dockWidth();
  const maxX = Math.max(MARGIN, window.innerWidth - dw - SIZE - MARGIN);
  const maxY = Math.max(MARGIN, window.innerHeight - SIZE - MARGIN);
  return {
    x: Math.min(Math.max(MARGIN, x), maxX),
    y: Math.min(Math.max(MARGIN, y), maxY),
  };
}

function defaultPos(): Pos {
  // Mirror the previous anchor: top: 72, right: 18.
  return clampToViewport(window.innerWidth - SIZE - 18, 72);
}

export default function CartFab({ cartCount }: { cartCount: number }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [pos, setPos] = useState<Pos | null>(null);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ startX: number; startY: number; baseX: number; baseY: number; moved: boolean } | null>(null);

  // Restore the saved position (or fall back to the default anchor) on mount.
  useEffect(() => {
    let initial: Pos | null = null;
    try {
      const raw = localStorage.getItem(POS_KEY);
      if (raw) {
        const p = JSON.parse(raw);
        if (typeof p?.x === 'number' && typeof p?.y === 'number') initial = p;
      }
    } catch { /* corrupt value — ignore and use default */ }
    const start = initial ?? defaultPos();
    setPos(clampToViewport(start.x, start.y));
  }, []);

  // Keep it on-screen if the window is resized smaller.
  useEffect(() => {
    const onResize = () => setPos(p => (p ? clampToViewport(p.x, p.y) : p));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (!pos) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { startX: e.clientX, startY: e.clientY, baseX: pos.x, baseY: pos.y, moved: false };
  }, [pos]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!d.moved && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
      d.moved = true;
      setDragging(true);
    }
    if (d.moved) setPos(clampToViewport(d.baseX + dx, d.baseY + dy));
  }, []);

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* already released */ }
    if (d && !d.moved) {
      navigate('/cart');           // a tap that never moved = a click
    } else if (d?.moved) {
      setPos(p => {
        if (p) { try { localStorage.setItem(POS_KEY, JSON.stringify(p)); } catch { /* quota — non-fatal */ } }
        return p;
      });
    }
    setDragging(false);
  }, [navigate]);

  if (!pos) return null;
  const active = location.pathname === '/cart';

  return (
    <div
      role="button"
      tabIndex={0}
      title="Cart — drag to move"
      aria-label="Cart"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate('/cart'); } }}
      className={`cart-fab ${active ? 'active' : ''}`}
      style={{
        // z-index lives in CSS (.cart-fab, var(--zi-fab)); only the dynamic
        // drag position stays inline.
        position: 'fixed', left: pos.x, top: pos.y,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: SIZE, height: SIZE, borderRadius: SIZE / 2,
        background: 'var(--blue, #1f4e8c)', color: '#fff',
        boxShadow: '0 2px 8px rgba(0,0,0,0.18)', textDecoration: 'none',
        cursor: dragging ? 'grabbing' : 'grab',
        touchAction: 'none', userSelect: 'none',
      }}
    >
      <ShoppingCart size={20} />
      {cartCount > 0 && (
        <span style={{
          position: 'absolute', top: -4, right: -4, minWidth: 18, height: 18,
          padding: '0 4px', borderRadius: 9, background: '#e23b3b', color: '#fff',
          fontSize: 11, fontWeight: 700, lineHeight: '18px', textAlign: 'center',
        }}>{cartCount}</span>
      )}
    </div>
  );
}
