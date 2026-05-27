/** Combos screen walkthrough. Opens a bundle's detail modal mid-tour so the
 * breakdown, pricing and "add bundle" can be pointed at, then closes it. */
import { launchScreenTour, waitForEl, scrollIntoView, sleep, type ScreenStep } from '../screenTour';

function openFirstCombo() {
  const el = document.querySelector('.table-container tbody tr, .table-container [class*="card-row"]') as HTMLElement | null;
  el?.click();
}
function closeModal() {
  (document.querySelector('.modal-close') as HTMLButtonElement | null)?.click();
}

const STEPS: ScreenStep[] = [
  { element: '.orders-header', title: 'Combos: bundle deals',
    body: 'A combo is a pack of products sold for less than buying each item on its own. This screen lists every bundle on offer, with the savings worked out for you.' },
  { element: '.filter-sidebar', title: 'Filter the bundles',
    body: 'Narrow by <b>search</b>, <b>distributor</b>, a <b>minimum saving</b>, and <b>validity</b> (this month, next month, or both). <b>Why it helps:</b> find the bundles worth your money fast.' },
  { element: '.search-count', title: 'How many match',
    body: 'The count updates as you filter, so you always know how big the current list is.' },
  { element: '.rip-summary-cards', title: 'The savings at a glance',
    before: () => scrollIntoView('.rip-summary-cards'),
    body: 'These cards summarise the list: how many bundles, the average and biggest saving, and the average discount. <b>Why it helps:</b> gauge the opportunity before you dig in.' },
  { element: '.table-container', title: 'The bundle list',
    before: () => scrollIntoView('.table-container'),
    body: 'Each row is a bundle, with its products, the combo price, and the saving versus buying separately. Click any column heading to sort. <b>Tip:</b> click a row to open its full breakdown.' },
  { element: '.add-to-cart-btn', title: 'Add a bundle straight to the cart',
    before: () => scrollIntoView('.add-to-cart-btn'),
    body: 'Set a quantity and <b>Add to cart</b>, or <b>Add to list</b>, right from the row. <b>Why it helps:</b> order the whole bundle in one move.' },
  { element: '.combo-detail-table', title: 'Inside a bundle',
    before: async () => { openFirstCombo(); await waitForEl('.combo-detail-table', 3000); },
    body: 'We opened a bundle for you. This table lists every product inside it, with each item’s share of the saving. <b>Why it helps:</b> see exactly what you get and where the value is.' },
  { element: '.combo-detail-bar', title: 'Bundle vs buying separately',
    body: 'The bar shows the combo price against the normal total, so the saving is obvious at a glance.' },
  { element: '.combo-detail-pricing', title: 'The bundle’s bottom line',
    body: 'The full pricing: the combo price, the regular price, and what you save per bundle. <b>Why it helps:</b> confirm the deal before you commit.' },
  { element: '.combo-detail-outlook', title: 'This month vs next',
    body: 'Whether the bundle still runs next month, and at what price. <b>Why it helps:</b> decide whether to buy now or wait.' },
  { element: '.combo-detail-actions', title: 'Add the whole bundle',
    body: 'One button adds the entire bundle to your cart from here. <b>Why it helps:</b> no need to add each product one by one.' },
  { element: '.orders-header', title: 'That’s Combos',
    before: () => { closeModal(); window.scrollTo({ top: 0, behavior: 'auto' }); },
    body: 'Browse the bundles, open one to check the breakdown, and add it to your cart. Bundles are usually the biggest single saving on the board. <b>Why it helps:</b> more savings in one move.' },
];

export const launchCombosTour = (navigate: (p: string) => void) =>
  launchScreenTour(navigate, '/combos', '.orders-header', STEPS, closeModal);
