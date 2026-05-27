/** Lists screen walkthrough. Anchors use data-tour markers added to Lists.tsx;
 * item-level steps centre gracefully when a list is empty. */
import { launchScreenTour, scrollIntoView, type ScreenStep } from '../screenTour';

const STEPS: ScreenStep[] = [
  { element: 'h2', title: 'Lists: reusable buying lists',
    body: 'Named lists you build once and reorder from again and again, a seasonal reset, a promo, a regular order. Pick what you want and move it to the cart in one go; the list itself stays intact.' },
  { element: '[data-tour="lists-panel"]', title: 'Your lists',
    before: () => scrollIntoView('[data-tour="lists-panel"]'),
    body: 'Every list you have created, each with its item count. Click one to open it. <b>Why it helps:</b> all your saved sets in one column.' },
  { element: '[data-tour="lists-new"]', title: 'Create a list',
    body: 'The <b>+</b> starts a new named list. <b>Why it helps:</b> spin up a list for any occasion in seconds.' },
  { element: '[data-tour="lists-detail"]', title: 'The selected list',
    before: () => scrollIntoView('[data-tour="lists-detail"]'),
    body: 'The list you picked opens here, with its name, actions, and its products. <b>Why it helps:</b> work on one list at a time.' },
  { element: '[data-tour="lists-detail"]', title: 'Rename or delete the list',
    body: 'The pencil renames the list; the bin deletes it. <b>Why it helps:</b> keep your lists meaningful and current.' },
  { element: '[data-tour="lists-items"]', title: 'The products in the list',
    before: () => scrollIntoView('[data-tour="lists-items"]'),
    body: 'Each product you have saved, with its distributor and size. <b>Why it helps:</b> see the whole set at a glance.' },
  { element: '[data-tour="lists-items"]', title: 'Tick what you want',
    body: 'Use the checkboxes to pick specific items, or the header checkbox to select all. <b>Why it helps:</b> reorder part of a list, not always the whole thing.' },
  { element: '[data-tour="lists-move"]', title: 'Move to cart',
    before: () => scrollIntoView('[data-tour="lists-move"]'),
    body: 'Send the ticked items (or the whole list) straight to your cart, ready to order. The list stays as it was, to use again. <b>Why it helps:</b> plan once, reorder forever.' },
  { element: '[data-tour="lists-move"]', title: 'Or remove items',
    body: 'Delete selected items you no longer want on the list. <b>Why it helps:</b> prune a list without rebuilding it.' },
  { element: '[data-tour="lists-items"]', title: 'How items get here',
    before: () => scrollIntoView('[data-tour="lists-items"]'),
    body: 'Add products from anywhere: right-click a product (on the Catalog, New Items, anywhere) and choose <b>Add to List</b>. <b>Why it helps:</b> build a list as you browse.' },
  { element: '[data-tour="lists-panel"]', title: 'Built for repeat orders',
    before: () => scrollIntoView('[data-tour="lists-panel"]'),
    body: 'Because a list survives being moved to the cart, your regular orders become a two-click job each cycle. <b>Why it helps:</b> stop rebuilding the same order every month.' },
  { element: 'h2', title: 'That’s Lists',
    before: () => window.scrollTo({ top: 0, behavior: 'auto' }),
    body: 'Save sets of products, reorder them in two clicks, and keep them for next time. <b>Why it helps:</b> turn recurring buys into a routine.' },
];

export const launchListsTour = (navigate: (p: string) => void) =>
  launchScreenTour(navigate, '/lists', '[data-tour="lists-panel"]', STEPS);
