/**
 * Combos screen walkthrough (end to end). Opens a bundle's detail modal, adds
 * the whole bundle to the cart, shows Add-to-list, and lands in the cart where
 * the bundle keeps its 🎁 Combo sticker. Savings callouts throughout.
 */
import { runScreenTour, waitForEl, scrollIntoView, sleep, type ScreenStep } from '../screenTour';

let nav: (path: string) => void = () => {};

function openFirstCombo() {
  const el = document.querySelector('.table-container tbody tr, .table-container [class*="card-row"]') as HTMLElement | null;
  el?.click();
}
function closeModal() { (document.querySelector('.modal-close') as HTMLButtonElement | null)?.click(); }
function addOpenBundle() { (document.querySelector('.combo-detail-actions button, .combo-detail-actions .btn') as HTMLButtonElement | null)?.click(); }
async function openListMenu() {
  (document.querySelector('.add-to-list-btn') as HTMLButtonElement | null)?.click();
  await waitForEl('.add-to-list-menu', 1500);
}
function closeListMenu() { (document.querySelector('.add-to-list-backdrop') as HTMLElement | null)?.click(); }

const STEPS: ScreenStep[] = [
  { element: '.orders-header', title: 'Combos: bundle deals',
    savings: '💰 Bundles cost less than buying the items apart',
    body: 'A combo is a pack of products sold for less than buying each on its own. This screen lists every bundle, with the saving worked out.' },
  { element: '.filter-sidebar', title: 'Filter the bundles',
    body: 'Narrow by <b>search</b>, <b>distributor</b>, a <b>minimum saving</b>, and <b>validity</b> (this month, next, or both).' },
  { element: '.search-count', title: 'How many match',
    body: 'The count updates as you filter, so you always know the size of the list.' },
  { element: '.rip-summary-cards', title: 'The savings at a glance',
    before: () => scrollIntoView('.rip-summary-cards'),
    savings: '💰 Average and biggest saving, up front',
    body: 'These cards summarise the list: how many bundles, the average and biggest saving, and the average discount. <b>Why it helps:</b> gauge the opportunity in a glance.' },
  { element: '.table-container', title: 'The bundle list',
    before: () => scrollIntoView('.table-container'),
    body: 'Each row is a bundle, with its products, the combo price, and the saving versus buying separately. Click a row to open its full breakdown.' },
  { element: '.add-to-cart-btn', title: 'Add a bundle straight from the row',
    before: () => scrollIntoView('.add-to-cart-btn'),
    savings: '⚡ The whole bundle in one click',
    body: 'Set a quantity and <b>Add to cart</b>, or <b>Add to list</b>, right here. <b>Why it helps:</b> order the whole pack in one move.' },
  { element: '.combo-detail-table', title: 'Inside a bundle',
    before: async () => { openFirstCombo(); await waitForEl('.combo-detail-table', 3000); },
    body: 'We opened a bundle. This lists every product inside it and each one’s share of the saving. <b>Why it helps:</b> see exactly what you get.' },
  { element: '.combo-detail-bar', title: 'Bundle vs buying separately',
    savings: '💰 The bundle price vs the normal total',
    body: 'The bar puts the combo price next to the normal total, so the saving is obvious.' },
  { element: '.combo-detail-pricing', title: 'The bundle’s bottom line',
    savings: '💰 Exactly what you save per bundle',
    body: 'The combo price, the regular price, and what you save per bundle. <b>Why it helps:</b> confirm the deal before you commit.' },
  { element: '.combo-detail-outlook', title: 'This month vs next',
    savings: '⚡ Buy now or wait? The outlook tells you',
    body: 'Whether the bundle still runs next month, and at what price. <b>Why it helps:</b> time the buy.' },
  { element: '.combo-detail-actions', title: 'Add the whole bundle',
    body: 'One button adds every product in the bundle to your cart. Let’s do it.' },
  { element: '.cart-fab', title: 'Added the whole bundle',
    before: async () => { addOpenBundle(); await sleep(500); closeModal(); await sleep(300); },
    savings: '⚡ A whole bundle added in one click',
    body: 'We added the entire bundle to your cart, see the count climb top-right. <b>Why it helps:</b> no adding items one by one.' },
  { element: '.add-to-list-menu', title: 'Or save it to a list',
    before: () => openListMenu(),
    savings: '💰 Park a bundle to reorder it later',
    body: 'We opened <b>Add to list</b>: drop a bundle’s product into a saved list, or make a new one, to reorder fast next time.' },
  { element: '[data-tour="cart-combo"]', title: 'In the cart, priced as a bundle',
    before: async () => { closeListMenu(); nav('/cart'); await waitForEl('[data-tour="cart-combo"], [data-tour="cart-group"]', 5000); await sleep(500); },
    savings: '💰 Stays at the bundle price while it’s intact',
    body: 'Here’s the bundle in your cart with its <b>🎁 Combo</b> sticker. It holds the bundle price while all its items are in the cart; remove one and the rest reprice automatically. <b>Why it helps:</b> the savings are protected for you.' },
  { element: '[data-tour="cart-send"]', title: 'Send it to your rep',
    before: () => window.scrollTo({ top: 0, behavior: 'auto' }),
    savings: '⚡ Bundle ordered, sent, done',
    body: '<b>Send All Orders to Reps</b> emails the order. That’s Combos end to end: find a bundle, check the breakdown, add it, send it.' },
];

export const launchCombosTour = (navigate: (path: string) => void) => {
  nav = navigate;
  return run(navigate);
};
async function run(navigate: (path: string) => void) {
  if (window.location.pathname !== '/combos') navigate('/combos');
  await waitForEl('.orders-header', 8000);
  await sleep(350);
  runScreenTour(STEPS, closeModal);
}
