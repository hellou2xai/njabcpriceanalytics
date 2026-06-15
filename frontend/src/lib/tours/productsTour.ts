/** Products screen walkthrough — the Provi-style grouped catalog.
 *
 * The grid only renders AFTER a search or category is committed, so the tour
 * commits one for you: an early `before` clicks the first category chip (which
 * sets a category filter and paints the grid without needing an Enter key), and
 * a later `before` opens the first product card so the size rows, deal ladder
 * and cart steppers are on screen to point at. Every anchor is best-effort: if
 * an element is missing the runner just centres the popover, so the tour always
 * finishes. */
import { launchScreenTour, scrollIntoView, sleep, type ScreenStep } from '../screenTour';

/** Commit a category so the grid renders: click the first browse chip. Present
 * on both the splash and the grid, and it never needs an Enter key. */
async function browseFirstCategory() {
  const chip = document.querySelector('.products-grid-chip') as HTMLButtonElement | null;
  chip?.click();
  await sleep(700);
}

/** Open the first product card so its size rows / steppers are visible. */
async function expandFirstCard() {
  const card = document.querySelector('.prod-card');
  if (card && !card.classList.contains('is-expanded')) {
    (card.querySelector('.prod-card-head') as HTMLElement | null)?.click();
    await sleep(600);
  }
  scrollIntoView('.prod-size-row');
}

const STEPS: ScreenStep[] = [
  { element: '.products-hero-input', title: 'Find any product',
    body: 'Start here. Type a product, brand, region, varietal, a misspelling, even a barcode. Smart search figures out what you mean and finds it across every distributor. <b>Why it helps:</b> one box reaches the whole catalog, no exact spelling required.' },
  { element: '.products-grid-browse', title: 'Or browse by aisle',
    body: 'Prefer to browse? These category chips jump straight into Beer, Wine, Spirits and the rest. <b>Why it helps:</b> walk the shelves when you do not have a specific product in mind.' },
  { element: '.products-hero-box--grid', title: 'Search stays on top',
    before: browseFirstCategory,
    body: 'Once results show, the big search box stays put so you can change your query or hop to another aisle without going back. <b>Why it helps:</b> keep exploring without losing your place.' },
  { element: '.prod-filter-rail', title: 'Narrow it down',
    before: () => scrollIntoView('.prod-filter-rail'),
    body: 'The left rail filters by distributor, brand, category, size and price, plus quick toggles for <b>In QD</b>, <b>Has RIP</b> and <b>In combo</b>. Each option shows how many products match. <b>Why it helps:</b> cut a big result set down to exactly what you buy.' },
  { element: '.products-toolbar', title: 'The toolbar',
    before: () => scrollIntoView('.products-toolbar'),
    body: 'Above the cards: how many products you are seeing, and the controls for how they are shown. <b>Why it helps:</b> shape the view to how you like to shop.' },
  { element: '.products-group-toggle', title: 'Group products',
    body: 'Off (default) gives one row per size per distributor. Turn it <b>on</b> to merge a product\'s sizes and distributors into one family card. <b>Why it helps:</b> compare the same product across distributors side by side.' },
  { element: '.products-detail-toggle', title: 'Price details or Summary',
    body: 'Switch between <b>Price details</b> (every QD and RIP tier shown on the card) and <b>Summary</b> (compact cards, expand for the full ladder). <b>Why it helps:</b> see all the deal math up front, or keep the list tight.' },
  { element: '.products-sort', title: 'Sort by price',
    savings: '💰 Sort by best price to put the cheapest first',
    body: 'Sort by name, by frontline price, or by <b>best price</b> (after discounts) low to high. <b>Why it helps:</b> the cheapest options rise to the top of the list.' },
  { element: '.prod-card', title: 'Every product is a card',
    before: () => scrollIntoView('.prod-card'),
    body: 'Each card shows the image, name, type and brand, the price range across its sizes, a price history sparkline and deal badges. Click anywhere on the card to expand it. <b>Why it helps:</b> the whole product at a glance before you dig in.' },
  { element: '.prod-card-right', title: 'Price range and best price',
    before: () => scrollIntoView('.prod-card-right'),
    savings: '💰 The best price across distributors, spotted for you',
    body: 'The right edge shows the per-bottle price range and a <b>best price</b> nudge when another distributor is cheaper on the same barcode. QD and RIP chips flag where the deals are. <b>Why it helps:</b> buy from whoever is cheapest, automatically.' },
  { element: '.prod-card-spark', title: 'Price history at a glance',
    before: () => scrollIntoView('.prod-card-spark'),
    body: 'The sparkline next to the name traces this product\'s price over recent months; hover it for the numbers. <b>Why it helps:</b> tell a real deal from a normal price.' },
  { element: '.prod-size-row', title: 'Open a card for the sizes',
    before: expandFirstCard,
    body: 'Expanding a card lists every size with its pack, SKU, $/case and $/bottle, the price sparkline and the full deal ladder. <b>Why it helps:</b> pick the exact size and see what you actually pay.' },
  { element: '.prod-size-deals', title: 'The deal ladder',
    before: () => scrollIntoView('.prod-size-deals'),
    savings: '💰 Every QD and RIP tier, with the price after each',
    body: 'Each size shows its current-month quantity-discount and RIP tiers: the quantity, the dollars off, and the price after, for both case and bottle. <b>Why it helps:</b> know the break point where a bigger order pays off.' },
  { element: '.prod-size-actions', title: 'Add to cart or a list',
    before: () => scrollIntoView('.prod-size-actions'),
    body: 'Set the bottle and case quantities on a size, then <b>Add to cart</b> (grouped by sales rep) or <b>Add to list</b> for later. <b>Why it helps:</b> go from browsing to a real order without leaving the page.' },
];

export const launchProductsTour = (navigate: (p: string) => void) =>
  launchScreenTour(navigate, '/products', '.products-page', STEPS);
