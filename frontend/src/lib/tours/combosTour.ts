/** Combos / bundle deals screen walkthrough. The page always renders its header
 * and filter panel; the summary cards and rows appear once data loads. Steps that
 * point below the fold scroll their anchor into view first. */
import { launchScreenTour, scrollIntoView, type ScreenStep } from '../screenTour';

const STEPS: ScreenStep[] = [
  { element: '.orders-header', title: 'Bundle / Combo Deals',
    body: 'Multi-product bundles a distributor sells as one pack, with the savings worked out for you. <b>Why it helps:</b> the deals that span several products, all in one place.' },
  { element: '.rip-summary-cards', title: 'The combos at a glance',
    before: () => scrollIntoView('.rip-summary-cards'),
    savings: '💰 Average and biggest bundle savings, up front',
    body: 'These cards summarise what is on the table: how many combos, the <b>average</b> and <b>biggest</b> savings, and the average discount. <b>Why it helps:</b> the size of the opportunity before you read a single row.' },
  { element: '.filter-toolbar', title: 'Narrow the list',
    before: () => scrollIntoView('.filter-toolbar'),
    body: 'Filter by <b>distributor</b>, a <b>minimum savings</b> floor, or <b>validity</b> (this month, next month, or both). The search box matches the combo description. <b>Why it helps:</b> jump straight to bundles worth your time.' },
  { element: '.rip-filter-bar', title: 'How many rows',
    before: () => scrollIntoView('.rip-filter-bar'),
    body: 'Set how many combos to show at once, with a live count of matches beside it. <b>Why it helps:</b> scan a short list or load them all.' },
  { element: '.combo-product-cell', title: 'Each combo, with its contents',
    before: () => scrollIntoView('.combo-product-cell'),
    body: 'Every row names the bundle and its combo code, then lists the products inside it. <b>Why it helps:</b> you see exactly what you are buying, not just a price.' },
  { element: '.combo-items-toggle', title: 'Contents are open by default',
    before: () => scrollIntoView('.combo-items-toggle'),
    body: 'The bundle’s items show right in the row: each product, its regular price, and its combo price. This toggle folds them away if you want. <b>Why it helps:</b> the contents are the product, so they are shown, not hidden behind a click.' },
  { element: '.combo-pct-badge', title: 'Discount and worth-it verdict',
    before: () => scrollIntoView('.combo-pct-badge'),
    savings: '💰 Effective save vs the real one-case price',
    body: 'Columns show the <b>% off</b>, the <b>advertised</b> save, and the <b>effective</b> save against the realistic one-case price, plus a verdict (worth it, marginal, or buy separately). A ⚠ flags figures that look off. <b>Why it helps:</b> the honest saving, not just the distributor’s claim.' },
  { element: '.catalog-order-inline', title: 'Add the whole bundle to your cart',
    before: () => scrollIntoView('.catalog-order-inline'),
    body: 'Set how many bundles you want, then add the whole pack to your cart in one click, or save it to a list. <b>Why it helps:</b> order the combo as a unit, with no re-keying the items.' },
  { element: '.combo-product-cell', title: 'Click a row for the full breakdown',
    before: () => scrollIntoView('.combo-product-cell'),
    body: 'Clicking any row opens the bundle breakdown: a per-item table, the regular-vs-combo math, deal dates, and what happens next month. <b>Why it helps:</b> verify the savings before you commit.' },
  { element: '.rip-summary-cards', title: 'That’s the Combos page',
    before: () => scrollIntoView('.rip-summary-cards'),
    body: 'Filter to the bundles you care about, read the real saving, then add the pack to your cart. <b>Why it helps:</b> bundle deals, checked and ready to order.' },
];

export const launchCombosTour = (navigate: (p: string) => void) =>
  launchScreenTour(navigate, '/combos', '.orders-header', STEPS);
