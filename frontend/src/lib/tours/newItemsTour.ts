/** New Items screen walkthrough. New Items is the full Products experience
 * (semantic search, filter rail, grouping, sparklines, cart) scoped to SKUs
 * first introduced in the last 3 months, each carrying a green "New · <month>"
 * sticker. The grid is always shown and cards start expanded, so the size-row
 * anchors resolve without a click. */
import { launchScreenTour, scrollIntoView, type ScreenStep } from '../screenTour';

const STEPS: ScreenStep[] = [
  { element: '.orders-header', title: 'New Items: what just landed',
    savings: '⚡ Be first to this edition’s new lines',
    body: 'Every product first introduced in the <b>last 3 months</b>, across all distributors. Matched across editions by barcode (not name, since names get rewritten). <b>Why it helps:</b> spot new lines before your competitors do.' },
  { element: '.prod-new-sticker', title: 'The “New · month” sticker',
    before: () => scrollIntoView('.prod-new-sticker'),
    savings: '🟢 Tagged with the month it arrived',
    body: 'Each card and size carries a green <b>New · &lt;month&gt;</b> sticker showing exactly when it first appeared. <b>Why it helps:</b> tell this month’s arrivals apart from earlier ones at a glance.' },
  { element: '.products-hero-search', title: 'Search within new items',
    before: () => window.scrollTo({ top: 0, behavior: 'auto' }),
    body: 'The same smart search as the rest of the app: product, brand, region, varietal, barcode, shorthand and typo correction, scoped to new arrivals. Press <b>Enter</b> to run it. <b>Why it helps:</b> jump straight to a new line you heard about.' },
  { element: '.products-hero-count', title: 'How many are new',
    body: 'The live count of new items in the current view, updating as you search and filter. <b>Why it helps:</b> see the size of this edition’s arrivals at a glance.' },
  { element: '.prod-filter-rail', title: 'The full filter rail',
    before: () => scrollIntoView('.prod-filter-rail'),
    body: 'Narrow by deal (RIP, discount, in-combo), category, brand, size and price, exactly like the Products page. <b>Why it helps:</b> turn a long list of arrivals into a focused shortlist.' },
  { element: '.products-toolbar', title: 'Group, detail level, sort and rows',
    before: () => scrollIntoView('.products-toolbar'),
    body: 'Toggle <b>Group products</b> to merge sizes and distributors into one family card, switch between <b>Price details</b> and <b>Summary</b>, change the sort, and set rows per page. <b>Why it helps:</b> the full Products toolkit, on the new lines.' },
  { element: '.prod-card', title: 'A card per new product',
    before: () => scrollIntoView('.prod-card'),
    body: 'Each card shows the name, type, brand, distributor and a price range across sizes. On New Items the cards start <b>expanded</b>, so every size shows without a click. <b>Why it helps:</b> see the whole arrival in one place.' },
  { element: '.prod-card-spark', title: 'Price history sparkline',
    before: () => scrollIntoView('.prod-card-spark'),
    savings: '📈 Three months of price at a glance',
    body: 'A mini price chart sits next to the name; hover for the month-by-month case and bottle prices. <b>Why it helps:</b> judge whether a new line is settling up or down.' },
  { element: '.prod-size-row', title: 'List price vs effective price',
    before: () => scrollIntoView('.prod-size-row'),
    savings: '💰 Judge a new line on its real cost',
    body: 'Each size shows the case and per-bottle price after the best 1-case discount, with deal badges. <b>Why it helps:</b> compare a new product on what you actually pay, not the list price.' },
  { element: '.prod-size-deals', title: 'Quantity and RIP tiers',
    before: () => scrollIntoView('.prod-size-deals'),
    body: 'Where a new product has volume discounts or a RIP rebate, the tier ladder shows underneath: buy N for a better price. <b>Why it helps:</b> the deal math is on the row, no hovering needed.' },
  { element: '.prod-size-order', title: 'Add to cart or a list',
    before: () => scrollIntoView('.prod-size-order'),
    body: 'Set cases and bottles and add a new product straight to your cart or a saved list, right from the size row. <b>Why it helps:</b> act on a new line the moment you find it.' },
  { element: '.pagination', title: 'Page through the arrivals',
    before: () => scrollIntoView('.pagination'),
    body: 'Move through the new items with Prev/Next. That’s New Items: the last 3 months of new lines, with the full Products toolkit behind them. <b>Why it helps:</b> be first to what just landed.' },
];

export const launchNewItemsTour = (navigate: (p: string) => void) =>
  launchScreenTour(navigate, '/new-items', '.prod-grid', STEPS);
