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

export interface TourMeta {
  id: string;
  title: string;
  desc: string;
  meta: string;                       // e.g. "15 steps" or "All screens · 3 min"
  icon: LucideIcon;
  accent: string;                     // tile icon colour
  run?: (navigate: (path: string) => void) => void;   // present = live
}

export const TOURS: TourMeta[] = [
  {
    id: 'quick', title: 'Product Quick Tour',
    desc: 'A fast walk through every screen, end to end: find a deal, build an order, send it to your rep.',
    meta: 'All screens · about 3 min', icon: Compass, accent: '#2563eb',
    run: (navigate) => startGuidedTour(navigate),
  },
  {
    id: 'catalog', title: 'Catalog Detailed Tour',
    desc: 'A deep dive into the Catalog: smart search, every filter, real pricing and tiers, the Better Price and combo badges, ordering, and right-click actions.',
    meta: '15 steps', icon: Package, accent: '#0ea5e9',
    run: (navigate) => launchCatalogTour(navigate),
  },

  // ---- Coming soon (one detailed tour per screen) ----
  { id: 'cart', title: 'Cart & Ordering', desc: 'Grouping by rep, pricing and combo handling, save-for-later, and sending orders.', meta: 'Coming soon', icon: ShoppingCart, accent: '#94a3b8' },
  { id: 'combos', title: 'Combos', desc: 'How bundles work, reading the savings, and adding a whole bundle to your cart.', meta: '12 steps', icon: Combine, accent: '#7c3aed', run: (navigate) => launchCombosTour(navigate) },
  { id: 'rip', title: 'RIP Products', desc: 'Rebates this month vs next, per-bottle effective pricing, the tiers and filters.', meta: '12 steps', icon: BadgeDollarSign, accent: '#16a34a', run: (navigate) => launchRipTour(navigate) },
  { id: 'newitems', title: 'New Items', desc: 'What just appeared this edition and how it is matched across months.', meta: '11 steps', icon: Sparkles, accent: '#db2777', run: (navigate) => launchNewItemsTour(navigate) },
  { id: 'favorites', title: 'Favorites', desc: 'Tracking products, setting a target price, and reading the buy signal.', meta: 'Coming soon', icon: Star, accent: '#94a3b8' },
  { id: 'todo', title: 'To-Do', desc: 'The weekly board, adding tasks, and dragging to reschedule.', meta: 'Coming soon', icon: ListTodo, accent: '#94a3b8' },
  { id: 'notes', title: 'Notes', desc: 'Sticky notes and the single feed of everything you have written.', meta: 'Coming soon', icon: StickyNote, accent: '#94a3b8' },
  { id: 'orders', title: 'Orders', desc: 'Sent purchase orders, reopening and re-submitting, and the PDF.', meta: 'Coming soon', icon: Receipt, accent: '#94a3b8' },
  { id: 'lists', title: 'Lists', desc: 'Building reusable buying lists and moving them into the cart.', meta: 'Coming soon', icon: ClipboardList, accent: '#94a3b8' },
  { id: 'config', title: 'Configuration', desc: 'Adding sales reps, divisions and stores so orders route correctly.', meta: 'Coming soon', icon: Settings, accent: '#94a3b8' },
];
