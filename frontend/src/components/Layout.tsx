import { useState, useEffect } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  LayoutDashboard, Package, ShoppingCart, Bell, Star, Menu, X, Combine,
  Sun, Moon, LogOut, BadgeDollarSign, ClipboardList, LayoutGrid,
  ChevronLeft, ChevronRight, ChevronDown, StickyNote, UserCog, Settings, Shield, Sparkles, BookOpen, ListTodo,
  Activity, Clock, Percent, Compass, ArrowDownRight, ArrowUpRight, ThumbsUp,
  Bot, Database, Settings2, Newspaper, Scale, XCircle, Layers, Target, CalendarClock, ShoppingBag,
} from 'lucide-react';
import { alerts as alertsApi, orders as ordersApi, cart as cartApi } from '../lib/api';
import WhatsAppShareButton from './WhatsAppShare';
import { useAuth } from '../contexts/AuthContext';
import DataRefreshBar from './DataRefreshBar';
import CartFab from './CartFab';
import GlobalAssistant from './GlobalAssistant';
import WelcomeTourPrompt from './WelcomeTourPrompt';
import { useOrderAnalysis } from '../contexts/OrderAnalysisContext';
import { useActivityTracker } from '../lib/activityTracker';

// Left menu grouped into labelled sections of related screens.
const NAV_GROUPS: {
  header: string;
  items: { path: string; label: string; icon: typeof LayoutDashboard; adminOnly?: boolean }[];
}[] = [
  {
    header: 'Overview',
    items: [
      { path: '/tours', label: 'Guided Tour', icon: Compass },
      { path: '/how-to-guide', label: 'How To Guide', icon: BookOpen },
      { path: '/assistant', label: 'Celar AI Assistant', icon: Sparkles },
      { path: '/', label: 'Dashboard', icon: LayoutDashboard },
      { path: '/alerts', label: 'Alerts', icon: Bell },
    ],
  },
  {
    header: 'Catalog',
    items: [
      { path: '/catalog', label: 'Catalog', icon: Package },
      { path: '/products', label: 'Products', icon: LayoutGrid },
      { path: '/whats-new', label: "What's New for You", icon: Newspaper },
      { path: '/new-items', label: 'New Items', icon: Sparkles },
      { path: '/combos', label: 'Combos', icon: Combine },
    ],
  },
  {
    header: 'Promotions',
    items: [
      { path: '/rate-shop', label: 'Rate Shop', icon: ShoppingBag },
      { path: '/time-sensitive', label: 'Time-Sensitive Deals', icon: Clock },
      { path: '/compare-prices', label: 'Compare Prices', icon: Scale },
      { path: '/compare-rips', label: 'Compare RIPs', icon: Layers },
      { path: '/price-360', label: 'Price 360', icon: Target },
      { path: '/edition-compare', label: 'Edition Comparison', icon: CalendarClock },
      { path: '/price-drops', label: 'Price Drops', icon: ArrowDownRight },
      { path: '/price-increases', label: 'Price Increases', icon: ArrowUpRight },
    ],
  },
  {
    header: 'My work',
    items: [
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
      { path: '/admin/activity', label: 'Activity', icon: Activity, adminOnly: true },
      { path: '/major-discounts', label: 'Major Discounts', icon: Percent, adminOnly: true },
      { path: '/rip-products', label: 'RIP Products', icon: BadgeDollarSign, adminOnly: true },
      { path: '/discounts', label: 'Top Discounts', icon: Percent, adminOnly: true },
      { path: '/more', label: 'Addnl Pages', icon: LayoutGrid, adminOnly: true },
      { path: '/admin/catalog-font-test', label: 'Test For Font Catalog', icon: Package, adminOnly: true },
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
  const location = useLocation();

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
      <WelcomeTourPrompt />
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
          className="edge-tab edge-tab-nav"
          onClick={() => setNavHidden(h => !h)}
          title={navHidden ? 'Show menu' : 'Hide menu'}
          aria-label={navHidden ? 'Show menu' : 'Hide menu'}
        >
          {navHidden ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
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
          {!sidebarCollapsed && <h1 className="sidebar-title">CELR Retail Pricing Intelligence</h1>}
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
                {!groupCollapsed && items.map(({ path, label, icon: Icon, adminOnly }) => (
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
