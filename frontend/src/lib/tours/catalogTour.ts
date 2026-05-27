/**
 * Catalog screen walkthrough (end to end). Teaches the screen, then actually
 * adds products to the cart from a few different distributors, shows the
 * Add-to-list menu, and lands in the cart ready to send. Several steps drive the
 * real UI first (auto-actions) and carry an animated savings callout.
 */
import {
  runScreenTour, waitForEl, setReactValue, scrollIntoView, sleep,
  addRowToCart, openAddToListMenu, closeAddToListMenu, type ScreenStep,
} from '../screenTour';

let nav: (path: string) => void = () => {};

const searchInput = () => document.querySelector('.search-bar input') as HTMLInputElement | null;

async function openFilters() {
  if (!document.querySelector('.filter-panel')) {
    (document.querySelector('.edge-tab-filters') as HTMLButtonElement | null)?.click();
    await waitForEl('.filter-panel', 2500);
  }
}
function clearSearch() { setReactValue(searchInput(), ''); }

function checkboxByLabel(text: string): HTMLInputElement | null {
  const labels = Array.from(document.querySelectorAll('.filter-checkbox')) as HTMLElement[];
  const lab = labels.find(l => l.textContent?.includes(text));
  return (lab?.querySelector('input[type="checkbox"]') as HTMLInputElement | null) ?? null;
}
async function setInComboFilter(on: boolean) {
  await openFilters();
  const cb = checkboxByLabel('In combo');
  if (cb && cb.checked !== on) cb.click();
}
function clearAllFilters() {
  clearSearch();
  const btn = Array.from(document.querySelectorAll('.toolbar button'))
    .find(b => /clear all/i.test(b.textContent || '')) as HTMLButtonElement | undefined;
  btn?.click();
}
async function pickDistributor(name: string) {
  const pills = Array.from(document.querySelectorAll('.orders-header .filter-pills .pill')) as HTMLButtonElement[];
  const p = pills.find(b => b.textContent?.trim().toLowerCase().includes(name.toLowerCase()));
  p?.click();
  await waitForEl('.catalog-order-inline', 4000);
  await sleep(450);
}

const STEPS: ScreenStep[] = [
  { element: '.orders-header', title: 'The Catalog: every product, one place',
    savings: '💰 Every distributor’s real prices, side by side',
    body: 'The full product list from every New Jersey wholesaler, with the discount and rebate maths already done. The buttons here focus on one distributor or show <b>All Distributors</b>.' },
  { element: '.search-bar', title: 'Search by name or barcode',
    before: () => clearSearch(),
    body: 'Type a name or scan a barcode; the count on the right shows how many match. <b>Why it helps:</b> reach anything out of 40,000+ items in seconds.' },
  { element: '.search-bar', title: 'It understands shorthand and typos',
    before: async () => { setReactValue(searchInput(), 'hennesy'); await waitForEl('.search-correction', 3000); },
    savings: '⚡ Find it even when you’re not sure of the name',
    body: 'Shorthand like “JW Blue” finds Johnnie Walker Blue, and we just typed <b>“hennesy”</b>, so it offers <b>“Showing results for Hennessy”</b>. <b>Why it helps:</b> never lose a sale to a spelling.' },
  { element: '.filter-panel', title: 'Narrow the list with filters',
    before: async () => { clearSearch(); await openFilters(); },
    body: 'The left panel filters the whole catalogue. The toggle up top shows only your <b>Favourites</b>, and <b>Clear all</b> resets everything.' },
  { element: '[data-tour="filter-deals"]', title: 'Filter to real deals',
    before: () => openFilters(),
    savings: '💰 Show only products that carry a deal',
    body: 'Limit to products with a <b>RIP rebate</b>, a <b>discount</b>, or <b>In combo</b>. <b>Why it helps:</b> hunt the savings, skip the rest.' },
  { element: '[data-tour="filter-brand"]', title: 'Filter by distributor and brand',
    before: () => openFilters(),
    body: 'Tick distributors, or search and pick brands, with a count next to each. <b>Why it helps:</b> focus on what you actually buy.' },
  { element: '[data-tour="filter-category"]', title: 'Filter by category and size',
    before: () => openFilters(),
    body: 'Narrow by category (Spirits, Wine, and so on) and bottle size. <b>Why it helps:</b> match a specific shelf or order.' },
  { element: '[data-tour="filter-price"]', title: 'Filter by case price',
    before: () => openFilters(),
    body: 'Set a min and max case price and press Go. <b>Why it helps:</b> stay on budget, or surface the high-value lines.' },
  { element: '.catalog-table-wrap', title: 'List price vs the price you really pay',
    savings: '💰 See your true cost after every discount and rebate',
    body: 'Each row shows the list <b>Case/Btl</b> price and the <b>Effective</b> price, what you pay after the best discount and rebate. <b>Why it helps:</b> compare real cost, not sticker prices.' },
  { element: '.catalog-row-sub', title: 'Quantity tiers',
    before: () => scrollIntoView('.catalog-row-sub'),
    savings: '💰 Buy the right quantity, pay less per case',
    body: 'The <b>tiers</b> show how the price improves as you buy more, and highlight the tier you’d hit. <b>Why it helps:</b> know exactly how many to buy for a better price.' },
  { element: '.better-price-badge', title: 'A cheaper source, flagged for you',
    before: () => scrollIntoView('.better-price-badge'),
    savings: '💰 Cheaper at another distributor? We flag it',
    body: 'When the same product is cheaper elsewhere, a <b>Better price</b> note appears under its name. <b>Why it helps:</b> you never overpay by accident.' },
  { element: '.combo-link-badge', title: 'Bundles and multiple distributors',
    before: async () => { await setInComboFilter(true); await waitForEl('.combo-link-badge', 3000); scrollIntoView('.combo-link-badge'); },
    savings: '💰 Bundles beat buying the items separately',
    body: 'We switched on the <b>In-combo</b> filter: the <b>🎁 In combo</b> badge opens the bundle, and <b>Multiple distributors</b> means more than one carries it. <b>Why it helps:</b> spot bundle savings instantly.' },
  { element: '.toolbar', title: 'Sort, page size, and paging',
    before: () => { clearAllFilters(); window.scrollTo({ top: 0, behavior: 'auto' }); },
    body: 'Sort by name, case price or effective price, set rows per page, and page through at the bottom. <b>Why it helps:</b> put the best value on top.' },
  { element: '.catalog-order-inline', title: 'Order right from the row',
    before: () => scrollIntoView('.catalog-order-inline'),
    savings: '⚡ Build your order without leaving the page',
    body: 'Every row has <b>Case</b> and <b>Btl</b> steppers, <b>Add to cart</b>, and <b>Add to list</b>. <b>Why it helps:</b> shop and order in the same place.' },
  { element: '.add-to-list-menu', title: 'Save it to a list to reorder later',
    before: () => openAddToListMenu(),
    savings: '💰 Save picks once, reorder in seconds next time',
    body: 'We opened <b>Add to list</b>: drop the product into a saved list, or make a new one. <b>Why it helps:</b> your regular orders become a two-click job each month.' },
  { element: '.row-menu-btn', title: 'Right-click for quick actions',
    before: () => { closeAddToListMenu(); scrollIntoView('.row-menu-btn'); },
    body: 'Right-click any product (or this ⋯) for: View, Search the web, Add to Cart/Favorites/List/To-Do, Copy barcode. <b>Why it helps:</b> act in one click.' },
  { element: '.cart-fab', title: 'Let’s actually order: distributor one',
    before: async () => { await pickDistributor('Allied'); await addRowToCart(); },
    savings: '⚡ Added to your cart in one click',
    body: 'We switched to <b>Allied</b> and added the first product to your cart. See the count climb on the cart, top-right.' },
  { element: '.cart-fab', title: 'Now a different distributor',
    before: async () => { await pickDistributor('Fedway'); await addRowToCart(); },
    savings: '💰 Mix distributors in one shopping trip',
    body: 'Switched to <b>Fedway</b> and added one there too. The cart keeps each distributor’s order separate for you.' },
  { element: '.cart-fab', title: 'And a third',
    before: async () => { await pickDistributor('Highgrade'); await addRowToCart(); },
    savings: '⚡ Three distributors, no spreadsheets',
    body: 'One more from <b>Highgrade</b>. You’ve built orders across three distributors without leaving the Catalog.' },
  { element: '[data-tour="cart-group"]', title: 'Your cart: one order per rep',
    before: async () => { nav('/cart'); await waitForEl('[data-tour="cart-group"]', 5000); await sleep(500); },
    savings: '💰 Totals and the right rep, done for you',
    body: 'Here’s the cart, grouped into a separate order per distributor and sales rep, with the pricing worked out. <b>Why it helps:</b> no manual sorting, no maths.' },
  { element: '[data-tour="cart-send"]', title: 'Send every order in one click',
    before: () => window.scrollTo({ top: 0, behavior: 'auto' }),
    savings: '⚡ From browsing to sent orders in minutes',
    body: '<b>Send All Orders to Reps</b> emails each rep their purchase order. That’s the whole loop: find deals, add across distributors, send. <b>Why it helps:</b> a full day’s ordering in minutes.' },
];

export const launchCatalogTour = (navigate: (path: string) => void) => {
  nav = navigate;
  return runCatalog(navigate);
};

async function runCatalog(navigate: (path: string) => void) {
  if (window.location.pathname !== '/catalog') navigate('/catalog');
  await waitForEl('.catalog-table-wrap', 8000);
  await sleep(350);
  runScreenTour(STEPS, clearAllFilters);
}
