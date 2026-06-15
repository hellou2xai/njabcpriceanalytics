/** Favorites screen walkthrough. The page may be empty if the user has no
 * favorites yet, so the ready anchor is the page header, which always renders.
 * Row-level anchors (table, signal badges, tiers, steppers) fall back to a
 * centred popover when there are no saved products. */
import { launchScreenTour, scrollIntoView, type ScreenStep } from '../screenTour';

const STEPS: ScreenStep[] = [
  { element: '.tracker-header', title: 'Your Favorites',
    body: 'Every product you star lands here, with its live price, buy signal, and the deals attached to it. <b>Why it helps:</b> the products you care about, watched in one place.' },
  { element: '.signal-summary-bar', title: 'Buy signals at a glance',
    before: () => scrollIntoView('.signal-summary-bar'),
    savings: '⚡ Buy now or hold? Told at a glance',
    body: 'This strip tallies your saved items by signal: <b>Buy Now</b>, <b>Good Buy</b>, <b>Hold</b>, <b>Wait</b>, <b>Defer</b>. <b>Why it helps:</b> see which favorites are worth acting on today without reading every row.' },
  { element: '.filter-bar', title: 'Find and group',
    before: () => scrollIntoView('.filter-bar'),
    body: 'Search your favorites by name, filter by category, group by category, or change how many rows show. <b>Why it helps:</b> a long list stays workable.' },
  { element: '.tracked-toggle', title: 'Group by category',
    before: () => scrollIntoView('.tracked-toggle'),
    body: 'Flip this to group your favorites by category (Spirits, Wine, and so on) instead of one flat list. <b>Why it helps:</b> work one category at a time.' },
  { element: '.tracker-table', title: 'Your tracked products',
    before: () => scrollIntoView('.tracker-table'),
    body: 'Each row is one saved product at one distributor, with code, size, case and bottle cost, savings, and effective price side by side. <b>Why it helps:</b> the full picture per product, in one view.' },
  { element: '.tag', title: 'The buy signal',
    before: () => scrollIntoView('.tag'),
    body: 'The badge next to each name is CELR’s call on timing, with the reasons behind it shown beside it. <b>Why it helps:</b> the recommendation and the why, together.' },
  { element: '.incentive-tier-row', title: 'Discount and RIP tiers',
    before: () => scrollIntoView('.incentive-tier-row'),
    savings: '💰 See every break before you commit',
    body: 'The <b>Incentive Tiers</b> column lists each discount and RIP break: the quantity, the saving per case, and the ROI. <b>Why it helps:</b> know exactly how many cases unlock the next deal.' },
  { element: '.qty-stepper', title: 'Set your quantity',
    before: () => scrollIntoView('.qty-stepper'),
    body: 'Use the + and - steppers to set bottles or cases. As you add cases, the RIP progress bar fills toward the next tier. <b>Why it helps:</b> plan the order right here against the deal you are chasing.' },
  { element: '.inline-edit-input', title: 'Target price and notes',
    before: () => scrollIntoView('.inline-edit-input'),
    savings: '💰 Let the app wait for your price',
    body: 'Set a <b>target price</b> per product and jot a <b>note</b>; both save inline as you type. <b>Why it helps:</b> CELR can tell you when a product drops to the price you want.' },
  { element: '.add-to-cart-btn', title: 'Straight to your cart',
    before: () => scrollIntoView('.add-to-cart-btn'),
    body: 'Once the quantity is right, add the product to your cart in one click. <b>Why it helps:</b> go from watching a deal to ordering it without retyping anything.' },
  { element: '.fav-btn', title: 'Stop tracking',
    before: () => scrollIntoView('.fav-btn'),
    body: 'The star on each row toggles the favorite off, which removes it from this list. You add favorites by starring a product anywhere in CELR. <b>Why it helps:</b> keep the watchlist down to what you are actually working.' },
  { element: '.page-actions', title: 'Export the list',
    before: () => { window.scrollTo({ top: 0, behavior: 'auto' }); scrollIntoView('.page-actions'); },
    body: 'Export every favorite, with prices, signals, target prices, and your quantities, to a CSV. <b>Why it helps:</b> share the plan or work it in a spreadsheet.' },
  { element: '.tracker-header', title: 'That’s Favorites',
    before: () => window.scrollTo({ top: 0, behavior: 'auto' }),
    body: 'Star a product anywhere in CELR and it shows up here, priced, signalled, and ready to order. <b>Why it helps:</b> your shortlist, always current, one click from the cart.' },
];

export const launchFavoritesTour = (navigate: (p: string) => void) =>
  launchScreenTour(navigate, '/watchlist', '.tracker-header', STEPS);
