/**
 * Registry of guided tours shown on the Tours dashboard (/tours).
 *
 * Each entry is a tile. A tile with a `run` function is live and clickable; one
 * without is shown as "coming soon". As we build a detailed tour for a screen,
 * import its launcher and add `run` here. Goal: one detailed tour per screen.
 */
import type { LucideIcon } from 'lucide-react';
import {
  Compass, Package, ShoppingCart, Combine, BadgeDollarSign, Sparkles,
  Star, ListTodo, StickyNote, Receipt, ClipboardList, Settings,
} from 'lucide-react';
import { startGuidedTour } from '../guidedTour';
import { launchCatalogTour } from './catalogTour';
import { launchCombosTour } from './combosTour';
import { launchRipTour } from './ripTour';
import { launchNewItemsTour } from './newItemsTour';
import { launchCartTour } from './cartTour';
import { launchFavoritesTour } from './favoritesTour';
import { launchTodoTour } from './todoTour';
import { launchNotesTour } from './notesTour';
import { launchOrdersTour } from './ordersTour';
import { launchListsTour } from './listsTour';
import { launchDashboardTour } from './dashboardTour';
import { launchAlertsTour } from './alertsTour';
import { launchConfigurationTour } from './configurationTour';
import { LayoutDashboard, Bell } from 'lucide-react';

export interface TourMeta {
  id: string;
  title: string;
  desc: string;
  meta: string;                       // e.g. "15 steps" or "All screens · 3 min"
  icon: LucideIcon;
  accent: string;                     // tile icon colour
  run?: (navigate: (path: string) => void) => void;   // present = live
  recommended?: boolean;              // shows a "Start here" call-out on the tile
  adminOnly?: boolean;                // hide the tile for non-admin users
                                       // (tour targets a screen they can't open)
}

export const TOURS: TourMeta[] = [
  {
    id: 'quick', title: 'Product Quick Tour',
    desc: 'A fast walk through every screen, end to end. Covers the new Catalog features (Group by Case Mix RIP, Add All to Cart, Price Drop / Increase filter, Pro columns, tier ladder with embedded order block) and the new left-menu layout.',
    meta: 'All screens · about 5 min', icon: Compass, accent: '#2563eb',
    recommended: true,
    run: (navigate) => startGuidedTour(navigate),
  },
  {
    id: 'catalog', title: 'Catalog Detailed Tour',
    desc: 'A deep dive into the Catalog: smart search, every filter (including Group by Case Mix RIP, Price Drop / Increase), the Pro teaser columns, the tier ladder with the embedded order block, the Better Price sticker, the this-month vs next-month sparkline, and right-click actions.',
    meta: '17 steps', icon: Package, accent: '#0ea5e9',
    run: (navigate) => launchCatalogTour(navigate),
  },

  // ---- Coming soon (one detailed tour per screen) ----
  { id: 'cart', title: 'Cart & Ordering', desc: 'Grouping by rep, pricing and combo handling, save-for-later, and sending orders.', meta: '12 steps', icon: ShoppingCart, accent: '#2563eb', run: (navigate) => launchCartTour(navigate) },
  { id: 'combos', title: 'Combos', desc: 'How bundles work, reading the savings, and adding a whole bundle to your cart.', meta: '12 steps', icon: Combine, accent: '#7c3aed', run: (navigate) => launchCombosTour(navigate) },
  // Admin-only. /rip-products is gated to admins in the left nav, so the
  // tile is hidden for everyone else (the tour would navigate them to a
  // screen they can't reach).
  { id: 'rip', title: 'RIP Products', desc: 'Rebates this month vs next, per-bottle effective pricing, the tiers and filters.', meta: '12 steps', icon: BadgeDollarSign, accent: '#16a34a', adminOnly: true, run: (navigate) => launchRipTour(navigate) },
  { id: 'newitems', title: 'New Items', desc: 'What just appeared this edition and how it is matched across months.', meta: '11 steps', icon: Sparkles, accent: '#db2777', run: (navigate) => launchNewItemsTour(navigate) },
  { id: 'favorites', title: 'Favorites', desc: 'Tracking products, setting a target price, and reading the buy signal.', meta: '11 steps', icon: Star, accent: '#f59e0b', run: (navigate) => launchFavoritesTour(navigate) },
  { id: 'todo', title: 'To-Do', desc: 'The weekly board, adding tasks, the card actions, and dragging to reschedule.', meta: '13 steps', icon: ListTodo, accent: '#0ea5e9', run: (navigate) => launchTodoTour(navigate) },
  { id: 'notes', title: 'Notes', desc: 'Sticky notes and the single feed of everything you have written.', meta: '11 steps', icon: StickyNote, accent: '#eab308', run: (navigate) => launchNotesTour(navigate) },
  { id: 'orders', title: 'Orders', desc: 'Sent purchase orders, status filters, reopening and re-submitting, and the PDF.', meta: '12 steps', icon: Receipt, accent: '#0891b2', run: (navigate) => launchOrdersTour(navigate) },
  { id: 'lists', title: 'Lists', desc: 'Building reusable buying lists and moving them into the cart.', meta: '12 steps', icon: ClipboardList, accent: '#65a30d', run: (navigate) => launchListsTour(navigate) },
  { id: 'dashboard', title: 'Dashboard', desc: 'The KPI cards, your workspace, and the opportunity tiles, with the distributor filter.', meta: '12 steps', icon: LayoutDashboard, accent: '#2563eb', run: (navigate) => launchDashboardTour(navigate) },
  { id: 'alerts', title: 'Alerts', desc: 'The grouped digest of opportunities and watch-outs, and how it auto-refreshes.', meta: '12 steps', icon: Bell, accent: '#dc2626', run: (navigate) => launchAlertsTour(navigate) },
  { id: 'config', title: 'Configuration', desc: 'Adding sales reps, divisions and stores so orders route correctly.', meta: '7 steps', icon: Settings, accent: '#475569', run: (navigate) => launchConfigurationTour(navigate) },
];
