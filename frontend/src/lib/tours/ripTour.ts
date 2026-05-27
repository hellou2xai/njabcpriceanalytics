/** RIP Products screen walkthrough: rebates and discounts, this month vs next. */
import { launchScreenTour, scrollIntoView, type ScreenStep } from '../screenTour';

const STEPS: ScreenStep[] = [
  { element: 'h2', title: 'RIP Products: rebates and discounts',
    body: 'Every product carrying an incentive: a <b>RIP</b> rebate, a <b>discount</b>, or both. Each one is shown <b>this month next to next month</b> so you can see what is changing.' },
  { element: '.rip-filter-bar', title: 'Filter to what matters',
    body: 'Filter by <b>distributor</b>, a specific <b>RIP number</b>, <b>incentive type</b> (discount or RIP), <b>category</b>, a minimum <b>saving</b> or <b>margin</b>, the <b>tier unit</b>, and <b>availability</b>. <b>Why it helps:</b> zero in on the rebates worth chasing.' },
  { element: '.search-count', title: 'Tier lines, counted',
    body: 'Each incentive tier is one line. The count tells you how many are in the current view.' },
  { element: '.rip-summary-cards', title: 'The numbers at a glance',
    before: () => scrollIntoView('.rip-summary-cards'),
    body: 'Total tier lines, the average and biggest saving per case, and how many start <b>next month</b>. <b>Why it helps:</b> size up the opportunity instantly.' },
  { element: '.rip-products-table', title: 'How a product reads',
    before: () => scrollIntoView('.rip-products-table'),
    body: 'Each product shows its case and bottle price, then its incentive tiers. Discounts and RIP rebates are <b>two separate incentives</b> and both are shown. <b>Why it helps:</b> nothing is hidden or merged.' },
  { element: '.rip-group-header', title: 'This month vs next month',
    before: () => scrollIntoView('.rip-group-header'),
    body: 'The columns split into <b>Current</b> and <b>Next</b>, side by side, so you can see a rebate starting, ending, or changing. <b>Why it helps:</b> time your buy around the program.' },
  { element: '.source-badge', title: 'Discount or RIP',
    before: () => scrollIntoView('.source-badge'),
    body: 'A tag on each line marks it as a <b>Discount</b> or a <b>RIP</b> rebate, so you always know which incentive you are looking at.' },
  { element: '.rip-code-badge', title: 'The RIP number',
    before: () => scrollIntoView('.rip-code-badge'),
    body: 'The rebate’s RIP code, matched to the product by RIP code and barcode. <b>Why it helps:</b> reference the exact program with your distributor.' },
  { element: '.rip-tier-badge', title: 'Tiers: buy more, save more',
    before: () => scrollIntoView('.rip-tier-badge'),
    body: 'Each tier reads “buy N for this price”. The effective <b>per-bottle</b> price is shown under the case price at every tier. <b>Why it helps:</b> pick the quantity that lands the best price.' },
  { element: '.sortable', title: 'Sort by the metric you care about',
    before: () => scrollIntoView('.rip-products-table'),
    body: 'Click a column heading to sort by saving, effective price, margin, or name. <b>Why it helps:</b> put the best rebates on top.' },
  { element: '.catalog-order-inline', title: 'Order from the row',
    before: () => scrollIntoView('.catalog-order-inline'),
    body: 'Set cases and bottles and <b>Add to cart</b> or <b>Add to list</b>, right here. <b>Why it helps:</b> act on a rebate without leaving the page.' },
  { element: '.pagination', title: 'Page through the rest',
    before: () => scrollIntoView('.pagination'),
    body: 'Use Prev/Next to move through, or raise the rows-per-page to see more at once. That’s RIP Products: every rebate and discount, current vs next, with the maths done.' },
];

export const launchRipTour = (navigate: (p: string) => void) =>
  launchScreenTour(navigate, '/rip-products', '.rip-filter-bar', STEPS);
