// Lightweight, privacy-light activity tracking. We record which screen the user
// is on and how long they spend there (a 'pageview' event sent when they leave
// the screen), plus explicit 'action' events via trackAction. Nothing here can
// break the page: sends are fire-and-forget.
import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { activity } from './api';
import type { ActivityEventIn } from './api';

const SESSION_KEY = 'celr_session_id';

function sessionId(): string {
  let id = sessionStorage.getItem(SESSION_KEY);
  if (!id) {
    id = (crypto.randomUUID?.() ?? `s_${Date.now()}_${Math.random().toString(36).slice(2)}`);
    sessionStorage.setItem(SESSION_KEY, id);
  }
  return id;
}

// Friendly screen names for the common routes; dynamic ids fall back to a label
// derived from the first path segment.
const SCREEN_LABELS: Record<string, string> = {
  '/': 'Dashboard',
  '/alerts': 'Alerts',
  '/catalog': 'Catalog',
  '/new-items': 'New Items',
  '/combos': 'Combos',
  '/rip-products': 'RIP Products',
  '/discounts': 'Discounts',
  '/clearance': 'Clearance',
  '/watchlist': 'Favorites',
  '/todo': 'To-Do',
  '/notes': 'Notes',
  '/orders': 'Orders',
  '/order-analysis': 'Order Analysis',
  '/configuration': 'Configuration',
  '/profile': 'Profile',
  '/admin': 'Admin',
  '/admin/activity': 'Admin: Activity',
  '/how-to-guide': 'How To Guide',
};

export function screenLabel(path: string): string {
  if (SCREEN_LABELS[path]) return SCREEN_LABELS[path];
  if (path.startsWith('/orders/')) return 'Order Detail';
  const seg = path.split('/').filter(Boolean)[0] ?? 'app';
  return seg.charAt(0).toUpperCase() + seg.slice(1).replace(/-/g, ' ');
}

function send(events: ActivityEventIn[]) {
  if (!events.length) return;
  activity.track({ session_id: sessionId(), user_agent: navigator.userAgent, events });
}

// Record an explicit action, e.g. trackAction('Order submitted', { orderId }).
export function trackAction(label: string, meta?: Record<string, unknown>) {
  send([{ type: 'action', label, path: window.location.pathname, meta }]);
}

// Mount once (inside the authenticated Layout). Emits a pageview with the time
// spent whenever the route changes, and flushes on tab-hide / unload.
export function useActivityTracker() {
  const location = useLocation();
  const current = useRef<{ path: string; enteredAt: number }>({ path: location.pathname, enteredAt: Date.now() });

  useEffect(() => {
    const c = current.current;
    if (c.path !== location.pathname) {
      const dur = Date.now() - c.enteredAt;
      send([{ type: 'pageview', path: c.path, label: screenLabel(c.path), duration_ms: dur }]);
      current.current = { path: location.pathname, enteredAt: Date.now() };
    }
  }, [location.pathname]);

  useEffect(() => {
    const flush = () => {
      const c = current.current;
      const dur = Date.now() - c.enteredAt;
      if (dur > 1000) {
        send([{ type: 'pageview', path: c.path, label: screenLabel(c.path), duration_ms: dur }]);
        current.current = { ...c, enteredAt: Date.now() };
      }
    };
    const onVis = () => {
      if (document.visibilityState === 'hidden') flush();
      else current.current = { ...current.current, enteredAt: Date.now() }; // don't count hidden time
    };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('pagehide', flush);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pagehide', flush);
    };
  }, []);
}
