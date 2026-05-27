/**
 * RIP Products screen walkthrough (end to end). Teaches rebates this month vs
 * next, then adds a couple of rebate products to the cart, shows Add-to-list,
 * and lands in the cart. Savings callouts throughout.
 */
import {
  runScreenTour, waitForEl, scrollIntoView, sleep,
  addRowToCart, openAddToListMenu, closeAddToListMenu, type ScreenStep,
} from '../screenTour';

let nav: (path: string) => void = () => {};

const STEPS: ScreenStep[] = [
  { element: 'h2', title: 'RIP Products: rebates and discounts',
    savings: '💰 Every rebate and discount, in one place',
    body: 'Every product carrying an incentive: a <b>RIP</b> rebate, a <b>discount</b>, or both, shown <b>this month next to next month</b> so you see what is changing.' },
  { element: '.rip-filter-bar', title: 'Filter to what matters',
    body: 'Filter by distributor, a specific <b>RIP number</b>, incentive type, category, a minimum <b>saving</b> or <b>margin</b>, tier unit, and availability.' },
  { element: '.search-count', title: 'Tier lines, counted',
    body: 'Each incentive tier is one line; the count shows how many are in view.' },
  { element: '.rip-summary-cards', title: 'The numbers at a glance',
    before: () => scrollIntoView('.rip-summary-cards'),
    savings: '💰 Average and biggest saving per case',
    body: 'Total tier lines, the average and biggest saving per case, and how many start next month. <b>Why it helps:</b> size up the opportunity instantly.' },
  { element: '.rip-products-table', title: 'How a product reads',
    before: () => scrollIntoView('.rip-products-table'),
    savings: '💰 Discount and rebate are both shown, not merged',
    body: 'Each product shows its price, then its tiers. Discounts and RIP rebates are <b>two separate incentives</b> and both appear. <b>Why it helps:</b> nothing is hidden.' },
  { element: '.rip-group-header', title: 'This month vs next month',
    before: () => scrollIntoView('.rip-group-header'),
    savings: '⚡ Catch a rebate starting or ending next month',
    body: 'The columns split into <b>Current</b> and <b>Next</b>, side by side. <b>Why it helps:</b> time your buy around the program.' },
  { element: '.source-badge', title: 'Discount or RIP',
    before: () => scrollIntoView('.source-badge'),
    body: 'A tag marks each line as a <b>Discount</b> or a <b>RIP</b> rebate, so you always know which you are looking at.' },
  { element: '.rip-tier-badge', title: 'Tiers: buy more, save more',
    before: () => scrollIntoView('.rip-tier-badge'),
    savings: '💰 Hit the tier that drops your per-bottle price',
    body: 'Each tier reads “buy N for this price”, with the effective <b>per-bottle</b> price under the case price. <b>Why it helps:</b> pick the quantity that lands the best price.' },
  { element: '.sortable', title: 'Sort by the metric you care about',
    before: () => scrollIntoView('.rip-products-table'),
    savings: '⚡ Put the biggest rebates on top',
    body: 'Click a column heading to sort by saving, effective price, margin or name.' },
  { element: '.catalog-order-inline', title: 'Order from the row',
    before: () => scrollIntoView('.catalog-order-inline'),
    savings: '⚡ Order the rebate without leaving the page',
    body: 'Set cases and bottles, then <b>Add to cart</b> or <b>Add to list</b>, right here.' },
  { element: '.add-to-list-menu', title: 'Save it to a list',
    before: () => openAddToListMenu(),
    savings: '💰 Park rebate buys to reorder next cycle',
    body: 'We opened <b>Add to list</b>: keep a rebate product on a list to reorder while the program runs.' },
  { element: '.cart-fab', title: 'Let’s add a couple to the cart',
    before: async () => { closeAddToListMenu(); await addRowToCart(0); await addRowToCart(1); },
    savings: '⚡ Two rebate buys added in seconds',
    body: 'We added two rebate products to your cart, see the count climb top-right. <b>Why it helps:</b> turn a rebate into an order immediately.' },
  { element: '[data-tour="cart-group"]', title: 'Your cart, grouped by rep',
    before: async () => { nav('/cart'); await waitForEl('[data-tour="cart-group"]', 5000); await sleep(500); },
    savings: '💰 Rebate priced in, rep sorted, totals done',
    body: 'Here’s the cart, with the rebate pricing applied and each product under the right rep. <b>Why it helps:</b> no manual maths or sorting.' },
  { element: '[data-tour="cart-send"]', title: 'Send it in one click',
    before: () => window.scrollTo({ top: 0, behavior: 'auto' }),
    savings: '⚡ From rebate to sent order in minutes',
    body: '<b>Send All Orders to Reps</b> emails each rep their order. That’s RIP Products end to end: spot the rebate, time it, order it, send it.' },
];

export const launchRipTour = (navigate: (path: string) => void) => {
  nav = navigate;
  return run(navigate);
};
async function run(navigate: (path: string) => void) {
  if (window.location.pathname !== '/rip-products') navigate('/rip-products');
  await waitForEl('.rip-filter-bar', 8000);
  await sleep(350);
  runScreenTour(STEPS);
}
