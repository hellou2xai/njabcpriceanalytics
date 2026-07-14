import { useState, useEffect } from 'react';
import { Link, Outlet, useLocation, useNavigationType } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  LayoutDashboard, Package, ShoppingCart, Bell, Star, Menu, X, Combine,
  Sun, Moon, LogOut, BadgeDollarSign, ClipboardList, LayoutGrid,
  ChevronLeft, ChevronRight, ChevronDown, StickyNote, UserCog, Settings, Shield, Sparkles, ListTodo,
  Activity, Clock, Percent, Compass, ArrowDownRight, ArrowUpRight, ThumbsUp,
  Bot, Database, Settings2, Newspaper, Scale, XCircle, Layers, Target, CalendarClock, ShoppingBag, Tag, Store,
} from 'lucide-react';
import { alerts as alertsApi, orders as ordersApi, cart as cartApi } from '../lib/api';
import WhatsAppShareButton from './WhatsAppShare';
import { useAuth } from '../contexts/AuthContext';
import DataRefreshBar from './DataRefreshBar';
import CartFab from './CartFab';
import GlobalAssistant from './GlobalAssistant';
import { useOrderAnalysis } from '../contexts/OrderAnalysisContext';
import { useActivityTracker } from '../lib/activityTracker';

// Left menu grouped into labelled sections of related screens.
const NAV_GROUPS: {
  header: string;
  items: { path: string; label: string; icon: typeof LayoutDashboard; adminOnly?: boolean; soon?: boolean }[];
}[] = [
  {
    header: 'Overview',
    items: [
      { path: '/tours', label: 'Guided Tour', icon: Compass },
      { path: '/assistant', label: 'CELR.AI Assistant', icon: Sparkles },
      { path: '/alerts', label: 'Alerts', icon: Bell },
    ],
  },
  {
    header: 'Catalog',
    items: [
      // Obsolete pages (Catalog, RIPs, QD, Time-Sensitive Deals) removed from the
      // menu per request — routes kept (reachable by URL), no future changes.
      { path: '/discover', label: 'Discover Deals', icon: Sparkles },
      { path: '/time-sensitive-deals', label: 'Time-Sensitive Deals', icon: CalendarClock },
      { path: '/discover-classic', label: 'Discover Classic', icon: Sparkles, adminOnly: true },
      { path: '/products', label: 'Products', icon: LayoutGrid },
      { path: '/distributor-price-list', label: 'Distributor Price List', icon: Store },
      { path: '/combos', label: 'Combos', icon: Combine },
      { path: '/new-items', label: 'New Items', icon: Sparkles },
    ],
  },
  {
    header: 'Analysis',
    items: [
      { path: '/compare-prices', label: 'Compare Distributor Price', icon: Scale },
      { path: '/compare-prices-classic', label: 'Compare Prices Classic', icon: Scale, adminOnly: true },
      { path: '/compare-rips', label: 'Compare RIPs', icon: Layers },
      { path: '/compare-qd', label: 'Compare QD', icon: Tag },
      { path: '/compare-rip-qd', label: 'Compare RIP + QD', icon: Layers },
      { path: '/edition-compare', label: 'Monthly Comparison', icon: CalendarClock },
      // Obsolete pages (Price Drops, Price Increases, Rate Shop, Price 360) removed
      // from the menu per request — routes kept (reachable by URL), no future changes.
    ],
  },
  {
    header: 'Store Hub',
    items: [
      { path: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
      { path: '/whats-new', label: "What's New for You", icon: Newspaper },
      { path: '/watchlist', label: 'Favorites', icon: Star },
      { path: '/todo', label: 'To-Do', icon: ListTodo },
      { path: '/notes', label: 'Notes', icon: StickyNote },
      { path: '/orders', label: 'Orders', icon: ShoppingCart },
      { path: '/lists', label: 'Lists', icon: ClipboardList },
    ],
  },
  {
    header: 'Setup',
    items: [
      { path: '/configuration', label: 'Configuration', icon: Settings },
    ],
  },
  // The agentic procurement platform. Admin-only while it matures: every item
  // is adminOnly, so non-admins never see the section at all.
  {
    header: 'Celr AI Agents',
    items: [
      { path: '/agents/proposals', label: 'Order Proposals', icon: Bot, adminOnly: true },
      { path: '/agents/store-feed', label: 'Store Feed', icon: Database, adminOnly: true },
      { path: '/agents/settings', label: 'Agent Settings', icon: Settings2, adminOnly: true },
    ],
  },
  // All admin-only screens grouped in one place. The whole section renders only
  // for admins (every item is adminOnly, so non-admins get an empty -> hidden group).
  {
    header: 'Admin',
    items: [
      { path: '/admin', label: 'Admin', icon: Shield, adminOnly: true },
      { path: '/admin/ai-usage', label: 'AI Usage', icon: Sparkles, adminOnly: true },
      { path: '/admin/ai-feedback', label: 'AI Feedback', icon: ThumbsUp, adminOnly: true },
      { path: '/admin/closeout-flags', label: 'User Closeout Flags', icon: XCircle, adminOnly: true },
      { path: '/admin/celr-products', label: 'CELR Products', icon: Package, adminOnly: true },
      { path: '/admin/activity', label: 'Activity', icon: Activity, adminOnly: true },
      { path: '/major-discounts', label: 'Major Discounts', icon: Percent, adminOnly: true },
      { path: '/rip-products', label: 'RIP Products', icon: BadgeDollarSign, adminOnly: true },
      { path: '/discounts', label: 'Top Discounts', icon: Percent, adminOnly: true },
      { path: '/more', label: 'Addnl Pages', icon: LayoutGrid, adminOnly: true },
    ],
  },
];

function useTheme() {
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    return (localStorage.getItem('theme') as 'dark' | 'light') ?? 'light';
  });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  const toggle = () => setTheme(t => t === 'dark' ? 'light' : 'dark');
  return { theme, toggle };
}

type TextSize = 'small' | 'medium' | 'large' | 'xl';
// App-wide text size, persisted in localStorage. Applied as a data attribute on
// <html>; CSS scales the page content (the nav keeps its size so the --nav-w
// offset stays correct). Persists until the user changes it.
function useTextSize() {
  const [size, setSize] = useState<TextSize>(() => {
    const s = localStorage.getItem('lpb_text_size');
    // Largest by default; honour a saved choice (small/medium/large) if present.
    return s === 'small' || s === 'medium' || s === 'large' || s === 'xl' ? (s as TextSize) : 'large';
  });
  useEffect(() => {
    document.documentElement.setAttribute('data-textsize', size);
    localStorage.setItem('lpb_text_size', size);
  }, [size]);
  return { size, setSize };
}

function useIsMobile(breakpoint = 1024) {
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < breakpoint);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [breakpoint]);
  return isMobile;
}

// Per-history-entry scroll position of .main-content, so BACK restores where the
// user was. Keyed by React Router's location.key (stable across back/forward).
const scrollPositions = new Map<string, number>();

export default function Layout() {
  const { username, logout, user } = useAuth();
  const oa = useOrderAnalysis();
  const isMobile = useIsMobile();
  useActivityTracker();  // record screen + time-on-screen for analytics

  // Desktop: persist collapsed state; Mobile: hidden by default
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window !== 'undefined' && window.innerWidth < 1024) return true;
    return localStorage.getItem('lpb_sidebar_collapsed') === 'true';
  });
  const [mobileOpen, setMobileOpen] = useState(false);
  // Desktop: fully hide the left nav (distinct from collapse-to-icons).
  const [navHidden, setNavHidden] = useState(() => localStorage.getItem('lpb_nav_hidden') === 'true');
  useEffect(() => { localStorage.setItem('lpb_nav_hidden', String(navHidden)); }, [navHidden]);

  // Per-section collapse (like Apollo): click a group header to fold its items.
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem('lpb_nav_groups_collapsed') || '[]')); }
    catch { return new Set(); }
  });
  const toggleGroup = (header: string) => setCollapsedGroups(prev => {
    const next = new Set(prev);
    next.has(header) ? next.delete(header) : next.add(header);
    localStorage.setItem('lpb_nav_groups_collapsed', JSON.stringify([...next]));
    return next;
  });

  const { theme, toggle: toggleTheme } = useTheme();
  const { size: textSize, setSize: setTextSize } = useTextSize();
  const location = useLocation();
  const navType = useNavigationType();

  // Persist collapsed state for desktop
  useEffect(() => {
    if (!isMobile) {
      localStorage.setItem('lpb_sidebar_collapsed', String(collapsed));
    }
  }, [collapsed, isMobile]);

  // Publish the current nav width so fixed-position edge tabs can sit at the
  // nav's right edge across open / collapsed / hidden states.
  useEffect(() => {
    const w = isMobile || navHidden ? '0px' : collapsed ? 'var(--sidebar-collapsed)' : 'var(--sidebar-w)';
    document.documentElement.style.setProperty('--nav-w', w);
  }, [isMobile, navHidden, collapsed]);

  // Close mobile sidebar on route change
  useEffect(() => {
    if (isMobile) setMobileOpen(false);
  }, [location.pathname, isMobile]);

  // Escape closes the mobile sidebar overlay (parity with the hamburger).
  useEffect(() => {
    if (!isMobile || !mobileOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMobileOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isMobile, mobileOpen]);

  // Take scroll restoration off the browser: it remembers .main-content and
  // re-applies its own value on back AFTER our restore, overriding it. With
  // 'manual', only our per-entry restore below runs.
  useEffect(() => {
    if ('scrollRestoration' in window.history) {
      const prev = window.history.scrollRestoration;
      window.history.scrollRestoration = 'manual';
      return () => { window.history.scrollRestoration = prev; };
    }
  }, []);

  // Scroll memory. Content scrolls inside .main-content (not the window), so the
  // browser's own restoration doesn't apply. Save each history entry's scroll
  // position while the user is on it, then on BACK/FORWARD (POP) put them back
  // where they were; on a NEW navigation (PUSH/REPLACE) start at the top.
  useEffect(() => {
    const el = document.querySelector('.main-content') as HTMLElement | null;
    if (!el) return;
    const key = location.key;
    // Track the live position in a LOCAL, and persist it to the map only on
    // CLEANUP (i.e. when navigating AWAY from this entry). Saving on every scroll
    // event raced the restore: on back, the short-page reflow fired a scroll that
    // overwrote the saved deep position before the restore could read it.
    let last = el.scrollTop;
    const onScroll = () => { last = el.scrollTop; };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => { scrollPositions.set(key, last); el.removeEventListener('scroll', onScroll); };
  }, [location.key]);

  useEffect(() => {
    const el = document.querySelector('.main-content') as HTMLElement | null;
    if (!el) return;
    if (navType !== 'POP') {
      el.scrollTo(0, 0);
      window.scrollTo(0, 0);
      return;
    }
    // BACK/FORWARD: restore where the user was. The target page's content loads
    // progressively (lazy rails, size sections fetched cold), so the page starts
    // SHORT and grows. Re-apply the saved scrollTop every time the content grows
    // (ResizeObserver) until we actually reach it, then stop. Give up after 10s.
    const y = scrollPositions.get(location.key) ?? 0;
    if (y <= 0) return;
    let reached = false;
    const apply = () => {
      el.scrollTop = y;
      if (el.scrollTop >= y - 2) reached = true;
    };
    apply();
    const ro = new ResizeObserver(() => { if (!reached) apply(); });
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    ro.observe(el);
    const stop = window.setTimeout(() => ro.disconnect(), 10_000);
    return () => { ro.disconnect(); window.clearTimeout(stop); };
  }, [location.key, navType]);

  const qc = useQueryClient();
  const { data: unread } = useQuery({
    queryKey: ['unread-alerts'],
    queryFn: alertsApi.unreadCount,
    refetchInterval: 30000,
  });

  // Auto-build the alert digest once per session so the badge is populated
  // without the user ever clicking a "generate" button.
  useEffect(() => {
    if (sessionStorage.getItem('lpb_alerts_generated')) return;
    sessionStorage.setItem('lpb_alerts_generated', '1');
    alertsApi.generate()
      .then(() => qc.invalidateQueries({ queryKey: ['unread-alerts'] }))
      .catch(() => {});
  }, [qc]);

  // Draft-order count for the Orders nav badge (shares cache with the dashboard).
  const { data: draftOrders } = useQuery({
    queryKey: ['orders', 'draft'],
    queryFn: () => ordersApi.list('draft'),
  });

  // Cart contents for the top-right cart badge (active items only).
  const { data: cartData } = useQuery({
    queryKey: ['cart'],
    queryFn: cartApi.get,
    refetchInterval: 30000,
  });
  const cartCount = (cartData?.items ?? []).filter(i => !i.saved_for_later).length;

  const sidebarVisible = isMobile ? mobileOpen : true;
  const sidebarCollapsed = isMobile ? false : collapsed;

  const toggleSidebar = () => {
    if (isMobile) {
      setMobileOpen(o => !o);
    } else {
      setCollapsed(c => !c);
    }
  };

  return (
    <div className="app-layout">
      <DataRefreshBar />
      {/* Mobile backdrop */}
      {isMobile && mobileOpen && (
        <div className="sidebar-backdrop" onClick={() => setMobileOpen(false)} />
      )}

      {/* Mobile hamburger button */}
      {isMobile && !mobileOpen && (
        <button
          className="mobile-menu-btn"
          onClick={() => setMobileOpen(true)}
          aria-label="Open menu"
        >
          <Menu size={22} />
        </button>
      )}

      {/* Desktop: an always-visible edge tab pinned at the nav's right edge to
          hide/show the whole nav. */}
      {!isMobile && (
        <button
          className={`edge-tab edge-tab-nav${navHidden ? ' is-hidden' : ''}`}
          onClick={() => setNavHidden(h => !h)}
          title={navHidden ? 'Show menu' : 'Hide menu'}
          aria-label={navHidden ? 'Show menu' : 'Hide menu'}
        >
          {navHidden ? <ChevronRight size={18} /> : <ChevronLeft size={16} />}
          {navHidden && <span className="edge-tab-nav-label">Menu</span>}
        </button>
      )}

      <aside
        className={[
          'sidebar',
          sidebarCollapsed ? 'collapsed' : 'open',
          isMobile ? 'mobile' : '',
          isMobile && mobileOpen ? 'mobile-open' : '',
          isMobile && !mobileOpen ? 'mobile-closed' : '',
          !isMobile && navHidden ? 'nav-hidden' : '',
        ].filter(Boolean).join(' ')}
      >
        <div className="sidebar-header">
          {!sidebarCollapsed && (
            <Link to="/" className="sidebar-title-link" title="Go to home">
              <h1 className="sidebar-title">CELR Retail Pricing Intelligence</h1>
            </Link>
          )}
          <div style={{ display: 'flex', gap: 4 }}>
            <button className="theme-toggle" onClick={toggleTheme} title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}>
              {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
            </button>
            <button className="sidebar-toggle" onClick={toggleSidebar}>
              {(isMobile && mobileOpen) || (!isMobile && !collapsed) ? <X size={18} /> : <Menu size={18} />}
            </button>
          </div>
        </div>
        <nav className="sidebar-nav">
          <div className="sidebar-textsize" title="Text size (saved for next time)">
            {!sidebarCollapsed && <span className="sidebar-textsize-lbl">Text size</span>}
            <div className="textsize-seg">
              {(['small', 'medium', 'large', 'xl'] as const).map(s => (
                <button
                  key={s}
                  type="button"
                  data-size={s}
                  className={`textsize-seg-btn${textSize === s ? ' on' : ''}`}
                  onClick={() => setTextSize(s)}
                  title={`${s[0].toUpperCase()}${s.slice(1)} text`}
                  aria-label={`${s} text`}
                  aria-pressed={textSize === s}
                >A</button>
              ))}
            </div>
          </div>
          {NAV_GROUPS.map(group => {
            const items = group.items.filter(it => !it.adminOnly || user?.is_admin);
            if (items.length === 0) return null;
            // Per-section fold (only meaningful when the nav shows labels).
            const groupCollapsed = !sidebarCollapsed && collapsedGroups.has(group.header);
            return (
              <div className={`nav-group${groupCollapsed ? ' group-collapsed' : ''}`} key={group.header}>
                {!sidebarCollapsed && (
                  <button type="button" className="nav-group-header"
                          onClick={() => toggleGroup(group.header)}
                          aria-expanded={!groupCollapsed}>
                    <span>{group.header}</span>
                    <ChevronDown size={14}
                      className={`nav-group-chevron${groupCollapsed ? ' is-collapsed' : ''}`} />
                  </button>
                )}
                {!groupCollapsed && items.map(({ path, label, icon: Icon, adminOnly, soon }) => (
                  soon ? (
                    <div key={path} className="nav-link nav-link-soon" aria-disabled="true"
                         title={sidebarCollapsed ? `${label} (coming soon)` : 'Coming soon'}>
                      <Icon size={18} />
                      {!sidebarCollapsed && <span>{label}</span>}
                      {!sidebarCollapsed && <span className="nav-soon-marker">Soon</span>}
                    </div>
                  ) :
                  path === '/tours' ? (
                    <div key={path} className="nav-tours-wrap">
                      <Link
                        to={path}
                        className={`nav-link ${location.pathname === path ? 'active' : ''}`}
                        title={sidebarCollapsed ? label : undefined}
                      >
                        <Icon size={18} />
                        {!sidebarCollapsed && <span>{label}</span>}
                      </Link>
                      {!sidebarCollapsed && (
                        <Link to={path} className="nav-new-sticker" aria-label="New user? Start here">
                          ✨ New user? Start here
                        </Link>
                      )}
                    </div>
                  ) : (
                  <Link
                    key={path}
                    to={path}
                    className={`nav-link ${location.pathname === path ? 'active' : ''}`}
                    title={sidebarCollapsed ? label : undefined}
                  >
                    <Icon size={18} />
                    {!sidebarCollapsed && <span>{label}</span>}
                    {adminOnly && !sidebarCollapsed && (
                      <span className="nav-admin-marker" title="Admin only (other users do not see this item)">Admin</span>
                    )}
                    {path === '/alerts' && unread?.unread ? <span className="badge">{unread.unread}</span> : null}
                    {path === '/orders' && draftOrders?.length ? <span className="badge">{draftOrders.length}</span> : null}
                  </Link>
                  )
                ))}
              </div>
            );
          })}
        </nav>
        <div className="sidebar-footer">
          <WhatsAppShareButton
            className="sidebar-logout sidebar-share"
            label="Share via WhatsApp"
            showLabel={!sidebarCollapsed}
            title={sidebarCollapsed ? 'Share via WhatsApp' : undefined}
            source="sidebar"
          />
          <Link
            to="/profile"
            className={`sidebar-profile ${location.pathname === '/profile' ? 'active' : ''}`}
            title={sidebarCollapsed ? (username ?? 'Profile') : 'Profile and settings'}
          >
            <UserCog size={18} />
            {!sidebarCollapsed && <span>{username ?? 'Profile'}</span>}
          </Link>
          <button
            className="sidebar-logout"
            onClick={logout}
            title={sidebarCollapsed ? 'Log out' : undefined}
          >
            <LogOut size={18} />
            {!sidebarCollapsed && <span>Log out</span>}
          </button>
        </div>
      </aside>
      {/* Cart: always visible and draggable so it never permanently blocks
          page content. Drops are remembered across reloads; a plain click
          still opens the cart. */}
      <CartFab cartCount={cartCount} />
      <GlobalAssistant />

      <main className="main-content">
        <Outlet />
      </main>
    </div>
  );
}
