/** Cart screen walkthrough. The Add-to-cart search panel ([data-tour="cart-add"])
 * renders even when the cart is empty, so it is the ready anchor; steps tied to
 * cart contents (total bar, rep groups, lines, RIP eligibility, combo sticker,
 * saved-for-later) centre gracefully when the cart is empty. */
import { launchScreenTour, scrollIntoView, type ScreenStep } from '../screenTour';

const STEPS: ScreenStep[] = [
  { element: '[data-tour="cart-add"]', title: 'Your Cart',
    body: 'This is where you build orders before they go to your reps. Search any catalogue product by name or barcode and drop it straight in, no need to go back to the Catalog. <b>Why it helps:</b> one place to assemble what you are buying this edition.' },
  { element: '[data-tour="cart-total"]', title: 'What the order is worth',
    before: () => scrollIntoView('[data-tour="cart-total"]'),
    savings: '💰 List minus the discounts you have earned',
    body: 'The running bar shows total cases and bottles, the <b>list total</b>, the <b>discount</b> your current quantities have already earned, and the <b>est total net</b> you pay now. RIP rebates are paid back later, so they are not in this number. <b>Why it helps:</b> see the real cost as you build.' },
  { element: '[data-tour="cart-group"]', title: 'Grouped by sales rep',
    before: () => scrollIntoView('[data-tour="cart-group"]'),
    body: 'Lines are clustered by distributor, because each distributor goes to its own rep as a separate order. Each card shows the group case and bottle count and the group total. <b>Why it helps:</b> one order per rep, kept apart for you.' },
  { element: '[data-tour="cart-rep"]', title: 'Assign the rep',
    before: () => scrollIntoView('[data-tour="cart-rep"]'),
    body: 'Pick the sales rep for this distributor. Their phone and email show underneath once chosen, and an order with no rep is skipped on send. <b>Why it helps:</b> the order lands with the right person. (Set reps up under Configuration.)' },
  { element: '[data-tour="cart-line"]', title: 'Each line, in detail',
    before: () => scrollIntoView('[data-tour="cart-line"]'),
    savings: '💰 The pay-now price and the best-buy, per line',
    body: 'A line carries the product, code, size, pack, your case and bottle quantity, the pay-now price per case and per bottle, the line total, and a <b>Best buy</b> illustration of the deepest possible net. Click the product name for full price detail. <b>Why it helps:</b> a distributor-portal view of exactly what you are ordering.' },
  { element: '[data-tour="cart-line"]', title: 'Set quantities',
    before: () => scrollIntoView('[data-tour="cart-line"]'),
    body: 'Use the Case and Btl steppers to dial in quantities; the line total updates instantly. The per-case and per-bottle prices drop the list figure as your quantity discounts kick in. <b>Why it helps:</b> tune the buy and watch the price move.' },
  { element: '[data-tour="cart-line"] .cart-rip-elig, [data-tour="cart-line"]', title: 'How close to the next RIP',
    before: () => scrollIntoView('[data-tour="cart-line"]'),
    savings: '🔗 Add a case or two, unlock the rebate',
    body: 'When a line earns a RIP rebate, an eBiz-style note tells you how many more cases to add to hit the next tier, counting across every line on the same RIP at that distributor. If a product sits under more than one program, a selector lets you pick the one that pays best. <b>Why it helps:</b> never stop just short of a rebate by accident.' },
  { element: '[data-tour="cart-combo"], [data-tour="cart-line"]', title: 'Combos stay together',
    before: () => scrollIntoView('[data-tour="cart-line"]'),
    body: 'A <b>🎁 Combo</b> badge marks lines priced as a bundle. The bundle price only holds while every item in it stays in the cart, so remove one and the rest reprice at their normal deal and lose the badge. Add it back and the bundle price returns. <b>Why it helps:</b> you keep the bundle price instead of breaking it by mistake.' },
  { element: '[data-tour="cart-note"], [data-tour="cart-group"]', title: 'Notes for the rep',
    before: () => scrollIntoView('[data-tour="cart-group"]'),
    body: 'Add a header note for the whole order to this rep, or a note on any single line. Both travel with the order when you send it. <b>Why it helps:</b> say what you need without a separate email.' },
  { element: '[data-tour="cart-saved"], [data-tour="cart-add"]', title: 'Save for later',
    before: () => scrollIntoView('[data-tour="cart-saved"]'),
    body: 'Park a line, a whole send batch, or a RIP group with the clock button and it drops into Saved for later, out of the totals but not lost. Move it back whenever you are ready to send. <b>Why it helps:</b> hold a maybe without deleting it.' },
  { element: '[data-tour="cart-send"]', title: 'Send to every rep',
    before: () => window.scrollTo({ top: 0, behavior: 'auto' }),
    savings: '🚀 One click, every rep gets their order',
    body: '<b>Send All Orders to Reps</b> dispatches one order per distributor to its assigned rep in a single click, with the notes and totals attached. Items without a rep are skipped so you can assign and resend. <b>Why it helps:</b> the whole cart goes out at once, correctly split. Then follow up with your rep.' },
];

export const launchCartTour = (navigate: (p: string) => void) =>
  launchScreenTour(navigate, '/cart', '[data-tour="cart-add"]', STEPS);
