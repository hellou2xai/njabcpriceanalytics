/** New Items screen walkthrough. Mirrors the Catalog, scoped to products that
 * just appeared this edition (matched across months by barcode). */
import { launchScreenTour, waitForEl, scrollIntoView, type ScreenStep } from '../screenTour';

async function openFilters() {
  if (!document.querySelector('.filter-panel')) {
    const btn = Array.from(document.querySelectorAll('.toolbar button.btn-secondary'))[0] as HTMLButtonElement | undefined;
    btn?.click();
    await waitForEl('.filter-panel', 2000);
  }
}

const STEPS: ScreenStep[] = [
  { element: '.orders-header', title: 'New Items: what just landed',
    savings: '⚡ Be first to this edition’s new lines',
    body: 'Products that appear this edition but were not in the previous one, matched across months by <b>barcode</b> (not name, since names get rewritten). Use the buttons here to focus on one distributor.' },
  { element: '.tile-filter-bar', title: 'Which edition it appeared in',
    before: () => scrollIntoView('.tile-filter-bar'),
    body: 'Filter by the month a product was <b>introduced</b>. <b>Why it helps:</b> separate this month’s arrivals from earlier ones.' },
  { element: '.search-bar', title: 'Search within new items',
    body: 'The same smart search as the Catalog: name, barcode, shorthand, and typo correction, scoped to new arrivals.' },
  { element: '.search-count', title: 'How many are new',
    body: 'The count of new products in the current view.' },
  { element: '.toolbar', title: 'Filters, favourites and page size',
    body: 'Show or hide the filter panel, limit to your <b>Favourites</b>, and set rows per page. <b>Clear all</b> resets active filters.' },
  { element: '.filter-panel', title: 'The same powerful filters',
    before: () => openFilters(),
    body: 'Narrow by deal (RIP, discount, in-combo), category, brand, size and price, exactly like the Catalog. <b>Why it helps:</b> turn a long list of arrivals into a focused shortlist.' },
  { element: '.catalog-table-wrap', title: 'List price vs effective price',
    before: () => scrollIntoView('.catalog-table-wrap'),
    savings: '💰 Judge a new line on its real cost',
    body: 'Each row shows the list and the <b>Effective</b> price (after the best discount and rebate), the same as the Catalog. <b>Why it helps:</b> judge a new product on real cost.' },
  { element: '.catalog-row-sub', title: 'Quantity tiers',
    before: () => scrollIntoView('.catalog-row-sub'),
    body: 'Where a new product has volume tiers, they show underneath: buy N for a better price.' },
  { element: '.catalog-order-inline', title: 'Add to cart or list',
    before: () => scrollIntoView('.catalog-order-inline'),
    body: 'Set cases and bottles and add a new product to your cart or a list straight from the row.' },
  { element: '.row-menu-btn', title: 'Right-click for quick actions',
    before: () => scrollIntoView('.row-menu-btn'),
    body: 'The same quick actions as everywhere: View, Search the web, Add to Cart/Favorites/List/To-Do, Copy barcode.' },
  { element: '.pagination', title: 'Page through the arrivals',
    before: () => scrollIntoView('.pagination'),
    body: 'Move through with Prev/Next. That’s New Items: spot what is new before your competitors do, with the full Catalog toolkit. <b>Why it helps:</b> be first to the new lines.' },
];

export const launchNewItemsTour = (navigate: (p: string) => void) =>
  launchScreenTour(navigate, '/new-items', '.orders-header', STEPS);
