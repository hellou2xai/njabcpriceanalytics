/**
 * Catalog screen walkthrough (15 steps). Run from the "Show me around this page"
 * button on the Catalog. Several steps drive the real UI first (auto-actions) so
 * the thing being explained is actually on screen: typing a misspelling to show
 * the spelling correction, opening the filter panel, scrolling a discounted row
 * into view, and switching on the In-combo filter to surface the bundle badges.
 */
import { runScreenTour, waitForEl, setReactValue, scrollIntoView, sleep, type ScreenStep } from '../screenTour';

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

/** Reset the screen to its normal state when the tour ends. */
function cleanup() {
  clearSearch();
  const btn = Array.from(document.querySelectorAll('.toolbar button'))
    .find(b => /clear all/i.test(b.textContent || '')) as HTMLButtonElement | undefined;
  btn?.click();
}

const STEPS: ScreenStep[] = [
  // 1
  { element: '.orders-header', title: 'The Catalog: every product, one place',
    body: 'This is the full product list from every New Jersey wholesaler, with the discount and rebate maths already worked out. The buttons here let you focus on <b>one distributor</b> (Allied, Fedway, Highgrade, Opici, Peerless) or see <b>All Distributors</b> at once.' },
  // 2
  { element: '.search-bar', title: 'Search by name or barcode',
    before: () => clearSearch(),
    body: 'Type a product name or scan/enter a barcode. The count on the right tells you how many products match. <b>Why it helps:</b> jump straight to what you want out of 40,000+ items.' },
  // 3
  { element: '.search-bar', title: 'It understands shorthand and typos',
    before: async () => { setReactValue(searchInput(), 'hennesy'); await waitForEl('.search-correction', 3000); },
    body: 'Shorthand like “JW Blue” finds Johnnie Walker Blue, and misspellings are corrected: we typed <b>“hennesy”</b> and it offers <b>“Showing results for Hennessy”</b>. <b>Why it helps:</b> you still find the product even when you’re unsure of the exact spelling.' },
  // 4
  { element: '.filter-panel', title: 'Narrow the list with filters',
    before: async () => { clearSearch(); await openFilters(); },
    body: 'The left panel filters the whole catalogue, not just this page. The toggle at the top shows <b>only your Favourites</b>, and <b>Clear all</b> resets everything. <b>Why it helps:</b> go from 40,000 products to your exact shortlist.' },
  // 5
  { element: '[data-tour="filter-deals"]', title: 'Filter to real deals',
    before: () => openFilters(),
    body: 'Show only products that carry an incentive: <b>Has RIP offer</b>, <b>Has discount</b>, or <b>In combo</b> (part of a bundle). Each option shows how many products match. <b>Why it helps:</b> hunt the savings, skip the rest.' },
  // 6
  { element: '[data-tour="filter-brand"]', title: 'Filter by distributor and brand',
    before: () => openFilters(),
    body: 'Tick one or more <b>distributors</b>, or search and pick <b>brands</b>. The counts next to each tell you how much is there. <b>Why it helps:</b> focus on the suppliers and brands you actually buy.' },
  // 7
  { element: '[data-tour="filter-category"]', title: 'Filter by category and size',
    before: () => openFilters(),
    body: 'Narrow by <b>category</b> (Spirits, Wine, and so on) and by bottle <b>size</b> (750ML, 1.75L, and the rest). <b>Why it helps:</b> build a shortlist that matches a specific shelf or order.' },
  // 8
  { element: '[data-tour="filter-price"]', title: 'Filter by case price',
    before: () => openFilters(),
    body: 'Set a <b>min</b> and <b>max</b> case price and press <b>Go</b>. <b>Why it helps:</b> stay inside a budget, or find the high-value lines worth a closer look.' },
  // 9
  { element: '.catalog-table-wrap', title: 'List price vs the price you really pay',
    body: 'Each row shows the list <b>Case/Btl</b> price and the <b>Effective</b> price, which is what you pay after the best discount and rebate are applied. <b>Why it helps:</b> compare real cost across products, not sticker prices.' },
  // 10
  { element: '.catalog-row-sub', title: 'Quantity tiers',
    before: () => { scrollIntoView('.catalog-row-sub'); },
    body: 'Under a product, the <b>tiers</b> show how the price improves as you buy more (buy N cases for this price). The tier you’d hit at your quantity is highlighted. <b>Why it helps:</b> see exactly how many to buy to reach a better deal.' },
  // 11
  { element: '.better-price-badge', title: 'A cheaper source, flagged for you',
    before: () => { scrollIntoView('.better-price-badge'); },
    body: 'When the same product is cheaper at another distributor, a <b>Better price</b> note appears under its name. <b>Why it helps:</b> you never overpay; the cheaper option is pointed out automatically.' },
  // 12
  { element: '.combo-link-badge', title: 'Bundles and multiple distributors',
    before: async () => { await setInComboFilter(true); await waitForEl('.combo-link-badge', 3000); scrollIntoView('.combo-link-badge'); },
    body: 'We’ve switched on the <b>In-combo</b> filter so you can see the <b>🎁 In combo</b> badge; click it to open the bundle. A <b>Multiple distributors</b> tag means more than one supplier carries that item. <b>Why it helps:</b> spot bundle savings and alternative sources at a glance.' },
  // 13
  { element: '.catalog-order-inline', title: 'Build your order from the row',
    before: () => { scrollIntoView('.catalog-order-inline'); },
    body: 'Set <b>cases</b> and <b>bottles</b>, then <b>Add to cart</b> or <b>Add to list</b>, right here without leaving the page. The cart, top-right, groups everything by sales rep. <b>Why it helps:</b> order as you browse.' },
  // 14
  { element: '.row-menu-btn', title: 'Right-click for quick actions',
    before: () => { scrollIntoView('.row-menu-btn'); },
    body: 'Right-click any product, or use this “⋯” button, for: <b>View details</b>, <b>Search the web</b>, <b>Add to Cart</b>, <b>Add to Favorites</b>, <b>Add to List</b>, <b>Add to To-Do</b>, and <b>Copy barcode</b>. <b>Why it helps:</b> act on a product in one click.' },
  // 15
  { element: '.toolbar', title: 'Sort, page size, and paging',
    before: () => { window.scrollTo({ top: 0, behavior: 'auto' }); },
    body: 'Click a column heading to <b>sort</b> by name, case price, or effective price. Change how many <b>rows per page</b> show here, and use <b>Prev/Next</b> at the bottom to page through. That’s the Catalog. <b>Why it helps:</b> organise the list to work the way you do.' },
];

export function startCatalogTour() {
  runScreenTour(STEPS, cleanup);
}

/** Launch from anywhere: go to the Catalog, wait for it to render, then run. */
export async function launchCatalogTour(navigate: (path: string) => void) {
  if (window.location.pathname !== '/catalog') navigate('/catalog');
  await waitForEl('.catalog-table-wrap', 8000);
  await sleep(300);
  startCatalogTour();
}
