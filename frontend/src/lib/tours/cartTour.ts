/** Cart & Ordering screen walkthrough. Most steps anchor to data-tour markers
 * added to Cart.tsx. Steps tied to cart contents (groups, lines, combo sticker,
 * saved-for-later) centre gracefully when the cart is empty. */
import { launchScreenTour, scrollIntoView, type ScreenStep } from '../screenTour';

const STEPS: ScreenStep[] = [
  { element: 'h2', title: 'The Cart: from browsing to a sent order',
    body: 'Everything you add lands here, <b>grouped by the sales rep</b> who covers each distributor, with the discount and rebate pricing already applied. One send turns each group into a purchase order.' },
  { element: '[data-tour="cart-add"]', title: 'Add products without leaving the cart',
    before: () => scrollIntoView('[data-tour="cart-add"]'),
    body: 'Search by name or barcode and add any product straight into the cart. <b>Why it helps:</b> top up an order without going back to the Catalog.' },
  { element: '[data-tour="cart-total"]', title: 'Your running total',
    body: 'A live total across the whole cart, with how many items and how many rep groups. <b>Why it helps:</b> always know the size of the order.' },
  { element: '[data-tour="cart-group"]', title: 'Grouped by sales rep',
    before: () => scrollIntoView('[data-tour="cart-group"]'),
    body: 'Items are bundled by distributor, since each is handled by a different rep. Each group shows its own <b>group total</b>. <b>Why it helps:</b> one clean order per rep.' },
  { element: '[data-tour="cart-rep"]', title: 'Assign the rep',
    body: 'Pick which sales rep this distributor’s order goes to. Their contact details appear once chosen. <b>Why it helps:</b> the order emails to the right person. (Set reps up under Configuration.)' },
  { element: '[data-tour="cart-note"]', title: 'A note for that rep',
    body: 'Add a header note for this rep’s order, for instructions or context. It rides along on their purchase order.' },
  { element: '[data-tour="cart-line"]', title: 'A line: the real pricing',
    before: () => scrollIntoView('[data-tour="cart-line"]'),
    savings: '💰 The effective price and saving, per line',
    body: 'Each line shows the list Case/Btl price and the <b>effective</b> price per case after the best deal, plus the saving. <b>Why it helps:</b> see what you actually pay, per line.' },
  { element: '[data-tour="cart-line"]', title: 'Quantities and line total',
    body: 'Set <b>cases</b> and <b>bottles</b> on separate steppers; the line total updates instantly. You can also <b>Save for later</b> or remove the line. <b>Why it helps:</b> fine-tune the order in place.' },
  { element: '.source-badge', title: 'The deals on each line',
    before: () => scrollIntoView('.source-badge'),
    body: 'The same discount and RIP tiers from the Catalogue show on the line, so you can tweak the quantity to hit a better price at the last minute.' },
  { element: '[data-tour="cart-combo"]', title: 'Combo lines are priced as a bundle',
    before: () => scrollIntoView('[data-tour="cart-combo"]'),
    savings: '💰 The bundle price is protected for you',
    body: 'A line that is part of a bundle carries a <b>🎁 Combo</b> sticker and is priced as the bundle while all its items are in the cart. Remove one and the rest reprice at their normal deal and lose the sticker; add it back and the bundle price returns. All automatic.' },
  { element: '[data-tour="cart-saved"]', title: 'Save for later',
    before: () => scrollIntoView('[data-tour="cart-saved"]'),
    body: 'Items you park sit here, out of the totals, until you move them back. <b>Why it helps:</b> keep a maybe-pile without losing it.' },
  { element: '[data-tour="cart-send"]', title: 'Send every order in one click',
    before: () => window.scrollTo({ top: 0, behavior: 'auto' }),
    savings: '⚡ A full day’s ordering in one click',
    body: '<b>Send All Orders to Reps</b> turns each rep group into a purchase order and emails it, with the notes and totals. <b>Why it helps:</b> the whole cart goes out in one click. Then follow up with your rep.' },
];

export const launchCartTour = (navigate: (p: string) => void) =>
  launchScreenTour(navigate, '/cart', '[data-tour="cart-add"]', STEPS);
