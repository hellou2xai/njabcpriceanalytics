/**
 * Registry of guided tours shown on the Tours dashboard (/tours).
 *
 * One detailed, per-screen walkthrough for every non-admin page, rebuilt from
 * scratch against the current UI (driver.js; see ../screenTour.ts). Each entry
 * is a tile; a `run` function makes it live. Admin-only tours (Catalog, RIP
 * Products) carry adminOnly so the tile is hidden for everyone else.
 */
import type { LucideIcon } from 'lucide-react';
import {
  Compass, Home, LayoutDashboard, Package, Sparkles, Newspaper, Combine,
  Scale, Layers, Clock, GitCompareArrows, TrendingDown, TrendingUp, Bell,
  Star, ListTodo, Receipt, ClipboardList, ShoppingCart, StickyNote, Settings,
  BadgeDollarSign,
} from 'lucide-react';
import { startGuidedTour } from '../guidedTour';
// Per-screen tours (one file each, in ./).
import { launchHomeTour } from './homeTour';
import { launchDashboardTour } from './dashboardTour';
import { launchProductsTour } from './productsTour';
import { launchNewItemsTour } from './newItemsTour';
import { launchWhatsNewTour } from './whatsNewTour';
import { launchCombosTour } from './combosTour';
import { launchComparePricesTour } from './comparePricesTour';
import { launchCompareRipsTour } from './compareRipsTour';
import { launchTimeSensitiveTour } from './timeSensitiveTour';
import { launchEditionCompareTour } from './editionCompareTour';
import { launchPriceDropsTour } from './priceDropsTour';
import { launchPriceIncreasesTour } from './priceIncreasesTour';
import { launchAlertsTour } from './alertsTour';
import { launchFavoritesTour } from './favoritesTour';
import { launchTodoTour } from './todoTour';
import { launchOrdersTour } from './ordersTour';
import { launchListsTour } from './listsTour';
import { launchCartTour } from './cartTour';
import { launchNotesTour } from './notesTour';
import { launchConfigurationTour } from './configurationTour';
// Admin-only screens (hidden for non-admins).
import { launchCatalogTour } from './catalogTour';
import { launchRipTour } from './ripTour';

export interface TourMeta {
  id: string;
  title: string;
  desc: string;
  meta: string;                       // e.g. "12 steps" or "All screens · 5 min"
  icon: LucideIcon;
  accent: string;                     // tile icon colour
  run?: (navigate: (path: string) => void) => void;   // present = live
  recommended?: boolean;              // shows a "Start here" call-out on the tile
  adminOnly?: boolean;                // hide the tile for non-admin users
}

export const TOURS: TourMeta[] = [
  {
    id: 'quick', title: 'Product Quick Tour',
    desc: 'A fast walk through the whole app, screen to screen — the search, the deal pages, comparisons and your workspace.',
    meta: 'All screens · about 5 min', icon: Compass, accent: '#2563eb',
    recommended: true,
    run: (navigate) => startGuidedTour(navigate),
  },

  // ---- Catalog / browsing ----
  { id: 'home', title: 'Home', desc: 'Your starting point: search, quick aisles, and shortcuts into the day.', meta: '12 steps', icon: Home, accent: '#2563eb', run: (n) => launchHomeTour(n) },
  { id: 'dashboard', title: 'Dashboard', desc: 'KPI cards, your workspace tiles, and the opportunity tiles, with the distributor filter.', meta: '13 steps', icon: LayoutDashboard, accent: '#2563eb', run: (n) => launchDashboardTour(n) },
  { id: 'products', title: 'Products', desc: 'Smart search, the filter rail, grouping, sparklines, the deal ladder and ordering — the main buying screen.', meta: '14 steps', icon: Package, accent: '#0ea5e9', run: (n) => launchProductsTour(n) },
  { id: 'newitems', title: 'New Items', desc: 'Everything introduced in the last 3 months, with the “New · month” sticker, in the full Products toolkit.', meta: '12 steps', icon: Sparkles, accent: '#db2777', run: (n) => launchNewItemsTour(n) },
  { id: 'whatsnew', title: "What's New for You", desc: 'A personalised digest of changes and opportunities this edition.', meta: '11 steps', icon: Newspaper, accent: '#7c3aed', run: (n) => launchWhatsNewTour(n) },
  { id: 'combos', title: 'Combos', desc: 'How bundles work, reading the savings, and adding a whole bundle to your cart.', meta: '10 steps', icon: Combine, accent: '#7c3aed', run: (n) => launchCombosTour(n) },

  // ---- Comparisons & promotions ----
  { id: 'compare-prices', title: 'Compare Prices', desc: 'Side-by-side List / Best QD / Best Net across distributors, the spread + winner, the 2-month view, and the expandable ladders.', meta: '14 steps', icon: Scale, accent: '#2563eb', run: (n) => launchComparePricesTour(n) },
  { id: 'compare-rips', title: 'Compare RIPs', desc: 'Whose rebate wins at the volume you buy — landed curve, break-even, half-case rules and terms.', meta: '14 steps', icon: Layers, accent: '#16a34a', run: (n) => launchCompareRipsTour(n) },
  { id: 'time-sensitive', title: 'Time-Sensitive Deals', desc: 'Offers that end this month or vanish next month, so you act before they’re gone.', meta: '12 steps', icon: Clock, accent: '#dc2626', run: (n) => launchTimeSensitiveTour(n) },
  { id: 'edition-compare', title: 'Edition Comparison', desc: 'Compare two months for a distributor: price changes, new and discontinued items.', meta: '12 steps', icon: GitCompareArrows, accent: '#0891b2', run: (n) => launchEditionCompareTour(n) },
  { id: 'price-drops', title: 'Price Drops', desc: 'Products whose effective price fell vs last edition — the strongest new deals.', meta: '11 steps', icon: TrendingDown, accent: '#16a34a', run: (n) => launchPriceDropsTour(n) },
  { id: 'price-increases', title: 'Price Increases', desc: 'Products whose effective price rose vs last edition — buy ahead or re-evaluate.', meta: '11 steps', icon: TrendingUp, accent: '#dc2626', run: (n) => launchPriceIncreasesTour(n) },
  { id: 'alerts', title: 'Alerts', desc: 'The grouped digest of opportunities and watch-outs, and how it auto-refreshes.', meta: '11 steps', icon: Bell, accent: '#dc2626', run: (n) => launchAlertsTour(n) },

  // ---- My work ----
  { id: 'favorites', title: 'Favorites', desc: 'Tracking products, setting a target price, and reading the buy signal.', meta: '13 steps', icon: Star, accent: '#f59e0b', run: (n) => launchFavoritesTour(n) },
  { id: 'todo', title: 'To-Do', desc: 'The weekly board, adding tasks, card actions, and dragging to reschedule.', meta: '11 steps', icon: ListTodo, accent: '#0ea5e9', run: (n) => launchTodoTour(n) },
  { id: 'orders', title: 'Orders', desc: 'Sent purchase orders, status filters, reopening and re-submitting, and the PDF.', meta: '11 steps', icon: Receipt, accent: '#0891b2', run: (n) => launchOrdersTour(n) },
  { id: 'lists', title: 'Lists', desc: 'Building reusable buying lists and moving them into the cart.', meta: '10 steps', icon: ClipboardList, accent: '#65a30d', run: (n) => launchListsTour(n) },
  { id: 'cart', title: 'Cart & Ordering', desc: 'Grouping by rep, pricing and combos, save-for-later, and sending orders.', meta: '11 steps', icon: ShoppingCart, accent: '#2563eb', run: (n) => launchCartTour(n) },
  { id: 'notes', title: 'Notes', desc: 'Sticky notes and the single feed of everything you’ve written.', meta: '11 steps', icon: StickyNote, accent: '#eab308', run: (n) => launchNotesTour(n) },
  { id: 'config', title: 'Configuration', desc: 'Adding sales reps, divisions and stores so orders route correctly.', meta: '10 steps', icon: Settings, accent: '#475569', run: (n) => launchConfigurationTour(n) },

  // ---- Admin-only (hidden for non-admins) ----
  { id: 'catalog', title: 'Catalog (Admin)', desc: 'The admin catalog: smart search, every filter, the tier ladder and right-click actions.', meta: '17 steps', icon: Package, accent: '#0ea5e9', adminOnly: true, run: (n) => launchCatalogTour(n) },
  { id: 'rip', title: 'RIP Products (Admin)', desc: 'Rebates this month vs next, per-bottle effective pricing, the tiers and filters.', meta: '12 steps', icon: BadgeDollarSign, accent: '#16a34a', adminOnly: true, run: (n) => launchRipTour(n) },
];
