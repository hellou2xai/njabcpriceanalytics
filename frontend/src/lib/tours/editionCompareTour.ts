/** Edition Comparison screen walkthrough. The page lands on the latest two
 * editions for a distributor, so the selectors, summary cards, and delta table
 * all resolve once data loads. */
import { launchScreenTour, scrollIntoView, type ScreenStep } from '../screenTour';

const STEPS: ScreenStep[] = [
  { element: '.cmp-head', title: 'Edition Comparison',
    body: 'This screen compares two price-book editions for one distributor and shows what actually moved between them. <b>Why it helps:</b> see exactly how this month differs from last.' },
  { element: '.ec-dist', title: 'Pick the distributor',
    before: () => scrollIntoView('.ec-selectors'),
    body: 'Choose whose price book you want to compare. Switching distributor resets the two editions to that supplier’s own months. <b>Why it helps:</b> every distributor has its own dates and items.' },
  { element: '.ec-editions', title: 'Older vs newer edition',
    before: () => scrollIntoView('.ec-editions'),
    body: 'The two dropdowns set the months to compare: <b>Older</b> on the left, <b>Newer</b> on the right. It defaults to the latest two on record. <b>Why it helps:</b> compare any two months, not just consecutive ones.' },
  { element: '.ec-stats', title: 'The month in one row',
    before: () => scrollIntoView('.ec-stats'),
    savings: '💰 See where costs fell at a glance',
    body: 'These cards count products compared, how many net costs <b>fell</b> or <b>rose</b>, new items, removed items, and RIP changes. <b>Why it helps:</b> the shape of the change before you read a single row.' },
  { element: '.ec-context', title: 'Everything is net cost',
    before: () => scrollIntoView('.ec-context'),
    body: 'Every change here is in <b>effective net cost</b>: after all discounts and RIP rebates, not list price. <b>Why it helps:</b> you compare what you actually pay, not the sticker.' },
  { element: '.cmp-filters', title: 'Search, filter, sort',
    before: () => scrollIntoView('.cmp-filters'),
    body: 'Search for a product or brand, filter by the kind of change (cost up, cost down, new, removed, RIP changed), and sort by biggest $ or % move. <b>Why it helps:</b> jump straight to the changes you care about.' },
  { element: '.ec-table', title: 'The change table',
    before: () => scrollIntoView('.ec-table'),
    body: 'One row per product, with its net cost in the older month next to the newer month. <b>Why it helps:</b> side-by-side numbers make the move obvious.' },
  { element: '.ec-pill', title: 'What changed, at a glance',
    before: () => scrollIntoView('.ec-pill'),
    savings: '💡 Red is up, green is down',
    body: 'The change pill shows the per-case move and percent: green when net cost dropped, red when it rose, plus tags for <b>New</b>, <b>Removed</b>, or not comparable. <b>Why it helps:</b> spot wins and watch-outs in colour.' },
  { element: '.ec-layers', title: 'Why the cost moved',
    before: () => scrollIntoView('.ec-layers'),
    body: 'The “What moved” tags break the change into its parts: list price, discount, and RIP added, removed, or changed. Hover a row for the full price breakdown. <b>Why it helps:</b> know whether it was the deal, the rebate, or the base price.' },
  { element: '.ec-prodname', title: 'Open the full product',
    before: () => scrollIntoView('.ec-prodname'),
    body: 'Click any product name to open its full detail, scoped to this distributor. <b>Why it helps:</b> go from a single change to the whole price history in one click.' },
  { element: '.cmp-actions', title: 'Act on a row',
    before: () => scrollIntoView('.cmp-actions'),
    body: 'Each row carries the same quick actions as the rest of the app: add to cart, add to a list, take a note. <b>Why it helps:</b> turn a price move into an order without leaving the page.' },
  { element: '.ec-stats', title: 'That’s Edition Comparison',
    before: () => scrollIntoView('.ec-stats'),
    body: 'Pick a distributor and two months, read the counts up top, then drill into the rows to see what moved and why. <b>Why it helps:</b> month-over-month price intelligence in one screen.' },
];

export const launchEditionCompareTour = (navigate: (p: string) => void) =>
  launchScreenTour(navigate, '/edition-compare', '.ec-stats', STEPS);
