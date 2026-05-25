import { useState, useEffect } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  LayoutDashboard, Package, ShoppingCart, Bell, Star, Menu, X, Combine,
  Sun, Moon, LogOut, BadgeDollarSign, ClipboardList, LayoutGrid,
  PanelLeftClose, PanelLeftOpen, StickyNote, UserCog, Settings, Shield, Sparkles, BookOpen,
} from 'lucide-react';
import { alerts as alertsApi, orders as ordersApi } from '../lib/api';
import WhatsAppShareButton from './WhatsAppShare';
import { useAuth } from '../contexts/AuthContext';
import { useOrderAnalysis } from '../contexts/OrderAnalysisContext';

const NAV = [
  { path: '/', label: 'Dashboard', icon: LayoutDashboard },
  { path: '/catalog', label: 'Catalog', icon: Package },
  { path: '/new-items', label: 'New Items', icon: Sparkles },
  { path: '/combos', label: 'Combos', icon: Combine },
  { path: '/rip-products', label: 'RIP Products', icon: BadgeDollarSign },
  { path: '/watchlist', label: 'Favorites', icon: Star },
  { path: '/notes', label: 'Notes', icon: StickyNote },
  { path: '/orders', label: 'Orders', icon: ShoppingCart },
  { path: '/order-analysis', label: 'Order Analysis', icon: ClipboardList },
  { path: '/configuration', label: 'Configuration', icon: Settings },
  { path: '/more', label: 'Addnl Pages', icon: LayoutGrid, adminOnly: true },
  { path: '/alerts', label: 'Alerts', icon: Bell },
  { path: '/how-to-guide', label: 'How To Guide', icon: BookOpen },
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

  // Desktop: persist collapsed state; Mobile: hidden by default
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window !== 'undefined' && window.innerWidth < 1024) return true;
    return localStorage.getItem('lpb_sidebar_collapsed') === 'true';
  });
  const [mobileOpen, setMobileOpen] = useState(false);
  // Desktop: fully hide the left nav (distinct from collapse-to-icons).
  const [navHidden, setNavHidden] = useState(() => localStorage.getItem('lpb_nav_hidden') === 'true');
  useEffect(() => { localStorage.setItem('lpb_nav_hidden', String(navHidden)); }, [navHidden]);

  const { theme, toggle: toggleTheme } = useTheme();
  const location = useLocation();

  // Persist collapsed state for desktop
  useEffect(() => {
    if (!isMobile) {
      localStorage.setItem('lpb_sidebar_collapsed', String(collapsed));
    }
  }, [collapsed, isMobile]);

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

      {/* Desktop: reveal button when the nav is fully hidden */}
      {!isMobile && navHidden && (
        <button className="nav-reveal-btn" onClick={() => setNavHidden(false)} title="Show menu" aria-label="Show menu">
          <PanelLeftOpen size={20} />
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
            {!isMobile && (
              <button className="sidebar-toggle" onClick={() => setNavHidden(true)} title="Hide menu">
                <PanelLeftClose size={18} />
              </button>
            )}
          </div>
        </div>
        <nav className="sidebar-nav">
          {NAV.filter(n => !('adminOnly' in n) || user?.is_admin).map(({ path, label, icon: Icon }) => (
            <Link
              key={path}
              to={path}
              className={`nav-link ${location.pathname === path ? 'active' : ''}`}
              title={sidebarCollapsed ? label : undefined}
            >
              <Icon size={18} />
              {!sidebarCollapsed && <span>{label}</span>}
              {path === '/alerts' && unread?.unread ? (
                <span className="badge">{unread.unread}</span>
              ) : null}
              {path === '/order-analysis' && oa.count ? (
                <span className="badge">{oa.count}</span>
              ) : null}
              {path === '/orders' && draftOrders?.length ? (
                <span className="badge">{draftOrders.length}</span>
              ) : null}
            </Link>
          ))}
          {user?.is_admin && (
            <Link
              to="/admin"
              className={`nav-link ${location.pathname === '/admin' ? 'active' : ''}`}
              title={sidebarCollapsed ? 'Admin' : undefined}
            >
              <Shield size={18} />
              {!sidebarCollapsed && <span>Admin</span>}
            </Link>
          )}
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
      <main className="main-content">
        <Outlet />
      </main>
    </div>
  );
}
