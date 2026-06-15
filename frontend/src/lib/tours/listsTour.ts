/** Lists screen walkthrough. Lists may be empty, so the ready anchor is the
 * list-selector panel, which always renders; item-level steps fall back to a
 * centred popover when a list has no rows. */
import { launchScreenTour, scrollIntoView, type ScreenStep } from '../screenTour';

const STEPS: ScreenStep[] = [
  { element: '[data-tour="lists-panel"]', title: 'Your buying lists',
    body: 'Lists are reusable groups of products you want to track or order together: a weekly reorder, a seasonal set, a "watch the price" shortlist. <b>Why it helps:</b> keep the products that matter in one place, ready to act on.' },
  { element: '[data-tour="lists-panel"]', title: 'My lists',
    before: () => scrollIntoView('[data-tour="lists-panel"]'),
    body: 'Every list you have made sits here, each with its item count. Keep as many as you like and switch between them. <b>Why it helps:</b> separate jobs stay separate instead of one giant pile.' },
  { element: '[data-tour="lists-new"]', title: 'Make a new list',
    before: () => scrollIntoView('[data-tour="lists-panel"]'),
    body: 'The <b>+</b> button creates a new list: give it a name and it becomes the active one straight away. <b>Why it helps:</b> spin up a fresh list the moment you start a new buying job.' },
  { element: '.nav-link', title: 'Pick a list to open it',
    before: () => scrollIntoView('[data-tour="lists-panel"]'),
    body: 'Click a list name to load it on the right. The highlighted one is what you are looking at now. <b>Why it helps:</b> one click to jump between your different lists.' },
  { element: '[data-tour="lists-detail"]', title: 'The list itself',
    before: () => scrollIntoView('[data-tour="lists-detail"]'),
    body: 'The selected list opens here with every saved product, its code, distributor, size, pack, and current pricing. Rename or delete the whole list from the buttons up top. <b>Why it helps:</b> the full picture of what is on this list, with live prices.' },
  { element: '[data-tour="lists-items"]', title: 'Adding items',
    before: () => scrollIntoView('[data-tour="lists-detail"]'),
    body: 'You build a list from anywhere in the app: right-click a product (Catalog, RIP Products, Price 360) and choose <b>Add to List</b>. The checkbox on each row is how you pick which items to act on. <b>Why it helps:</b> save a product the instant you spot it, then come back later.' },
  { element: '[data-tour="lists-move"]', title: 'Move a list into the cart',
    before: () => scrollIntoView('[data-tour="lists-move"]'),
    savings: '🛒 Turn a saved list into an order in one click',
    body: 'The <b>Move to cart</b> button copies your selected rows (or the whole list when nothing is ticked) straight into the cart, ready to order. The list itself stays intact for next time. <b>Why it helps:</b> a saved shortlist becomes a real order without re-finding each product.' },
  { element: '[data-tour="lists-move"]', title: 'Tidy up and analyze',
    before: () => scrollIntoView('[data-tour="lists-move"]'),
    savings: '💰 Find tier-gap and case-mix savings on the list',
    body: '<b>Delete selected</b> drops rows you no longer want, and <b>Analyze for Savings</b> runs the same engine as the cart over the whole list: tier gaps, case mixing, and price rises. <b>Why it helps:</b> see what you could save before you ever place the order.' },
  { element: '[data-tour="lists-move"]', title: 'Group by RIP',
    before: () => scrollIntoView('[data-tour="lists-move"]'),
    body: 'Turn on <b>Group by RIP</b> to bucket items that share a RIP rebate code, each with its own colour band and a per-group "Move all to cart". <b>Why it helps:</b> keep rebate-linked products together so you order them as a set.' },
  { element: '[data-tour="lists-detail"]', title: 'That’s Lists',
    before: () => scrollIntoView('[data-tour="lists-detail"]'),
    body: 'Save products from anywhere, organise them into named lists, check the savings, then push a list into the cart when you are ready to buy. <b>Why it helps:</b> the gap between "interesting product" and "placed order" closes to a couple of clicks.' },
];

export const launchListsTour = (navigate: (p: string) => void) =>
  launchScreenTour(navigate, '/lists', '[data-tour="lists-panel"]', STEPS);
