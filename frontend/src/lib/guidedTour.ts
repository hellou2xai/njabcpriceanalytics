/**
 * Product Quick Tour (driver.js). Walks the user through every screen they
 * can actually reach, end to end, on the real pages. The Catalog gets the
 * deepest treatment because that's where the new features live (Group by
 * Case Mix RIP with the Add All Case Mix to Cart banner, Price Drop /
 * Price Increase radio, the Pro teaser columns, the embedded order block
 * inside the tier ladder, and the this-month vs next-month sparkline).
 *
 * Admin-only screens (RIP Products, Addnl Pages, Admin, Activity, Top
 * Discounts) are intentionally skipped so a non-admin user is never sent
 * to a route they can't open.
 *
 * If a step's selector isn't on the page (slow load, layout change),
 * driver.js shows the popover centred instead of throwing, so the tour
 * always reaches the finish step.
 */
import { driver } from 'driver.js';
import 'driver.js/dist/driver.css';
import { showStepSavings } from './screenTour';

type NavFn = (path: string) => void;

interface Step { route?: string; element?: string; title: string; body: string; savings?: string; }

const STEPS: Step[] = [
  // ---- Welcome + left menu ----
  { route: '/', title: 'Welcome to CELR 👋',
    savings: '💰 The maths is done. You just decide.',
    body: "CELR reads every New Jersey wholesaler's monthly price book and works out the discount and rebate maths for you. This is a fast tour of the whole app, about 5 minutes. For a hands-on, click-by-click walk through any single screen, the <b>Guided Tours</b> page has one per screen. Click <b>Next</b>." },
  { route: '/', element: '.sidebar-nav', title: 'Your menu, grouped by job',
    body: "The left menu groups tools by job: <b>Overview</b> (your day), <b>Catalog</b> (Products, New Items, Combos), <b>Promotions</b> (Compare Prices, Compare RIPs, Time-Sensitive, Edition Comparison, Price Drops/Increases) and <b>My Work</b> (favourites, to-dos, notes, orders, lists). <b>Why it helps:</b> every tool is one click away, and related ones sit together." },

  // ---- Dashboard ----
  { route: '/dashboard', element: '.kpi-grid', title: 'Dashboard: the month at a glance',
    savings: "💰 The whole month's savings pool, up front",
    body: "The cards summarise this month's price book: total items, active discounts (and the dollars on the table), clearance, price moves and active rebates. <b>Each card is clickable</b> and jumps to that list. <b>Why it helps:</b> see what changed without searching." },
  { route: '/dashboard', element: '.filter-pills', title: 'Dashboard: focus on one distributor',
    body: "These chips re-scope the whole dashboard to a single distributor, or All. <b>Why it helps:</b> see the picture for just the supplier you're working with." },
  { route: '/dashboard', element: '.dashboard-tile-grid', title: 'Dashboard: your workspace + opportunities',
    body: 'Below the numbers, compact tiles cover your own activity (favourites, orders, notes) and the deals CELR found (time-sensitive, biggest drops, who is cheaper). Each opens its detail in a pop-up. <b>Why it helps:</b> pick up where you left off, with the best deals surfaced.' },

  // ---- Products (the main buying screen) ----
  { route: '/products', element: '.products-hero-search, .products-page', title: 'Products: the main buying screen',
    savings: '⚡ Find anything, even misspelled',
    body: 'Search any product, brand, region or barcode. <b>Shorthand and typos work</b> ("JW Blue", "hennesy"). Results group into one card per product with a left filter rail. <b>Why it helps:</b> reach any of 50,000+ products in seconds.' },
  { route: '/products', element: '.products-page', title: 'Products: deals, sparklines and one-click ordering',
    savings: '💰 Your real cost, and the qty that saves most',
    body: 'Each card shows the price range, a price sparkline, a cross-distributor <b>best-price</b> chip, and expandable size rows with the full <b>QD + RIP deal ladder</b> and Case/Bottle steppers + <b>Add to cart / Add to list</b>. <b>Why it helps:</b> compare the real (after-deal) price and order in the same place. The detailed Products tour walks every part.' },

  // ---- New Items ----
  { route: '/new-items', element: '.prod-grid, .orders-header', title: 'New Items: what just landed',
    savings: "⚡ Be first to this edition's new lines",
    body: 'The full Products toolkit, scoped to items <b>introduced in the last 3 months</b>, each tagged with a green “New · month” sticker. Matched across months by barcode, so a renamed product is still recognised. <b>Why it helps:</b> spot new lines before your competitors.' },

  // ---- Combos ----
  { route: '/combos', element: '.orders-header', title: 'Combos: bundle deals',
    savings: '💰 Bundles cost less than buying apart',
    body: 'Multi-product packs sold for less than buying each item separately. Each combo shows its members, the bundle price and the saving, and adds to the cart in one move. <b>Why it helps:</b> usually the biggest single saving on the board.' },

  // ---- Comparisons ----
  { route: '/compare-prices', element: '.cmp-picker, .cmp-cards', title: 'Compare Prices: distributor vs distributor',
    savings: '💰 Buy each product from whoever is cheapest',
    body: 'Pick 2-3 distributors and see <b>List / Best QD / Best Net</b> side by side, the spread, the winner, and a 2-month view. Expand any row for each distributor’s UPC, vendor item number and full deal ladder. <b>Why it helps:</b> never overpay because a sister distributor was cheaper.' },
  { route: '/compare-rips', element: '.rip2-top, .rip2-cards', title: 'Compare RIPs: whose rebate wins',
    savings: '💰 The rebate that actually pays off at your volume',
    body: 'Set how many cases you buy and CELR ranks each distributor’s rebate at that volume, with the landed-cost curve, break-even, half-case rules and the terms (cash to unlock, mix breadth). <b>Why it helps:</b> the same bottle can RIP very differently per distributor.' },
  { route: '/time-sensitive', element: '.deal-cards, .page-header, .orders-header', title: 'Time-Sensitive Deals',
    savings: '⏳ Act before they’re gone',
    body: 'Offers that end this month or aren’t available next month, surfaced with their deadline. <b>Why it helps:</b> grab the discount before it lapses.' },
  { route: '/edition-compare', element: '.ec-stats, .cmp-head', title: 'Edition Comparison',
    body: 'Compare two months for a distributor: what changed in price, and what was added or discontinued. <b>Why it helps:</b> see the month-over-month moves at a glance.' },
  { route: '/price-drops', element: '.pm-compare-banner, .orders-header', title: 'Price Drops',
    savings: '💰 Cheaper this edition, ranked for you',
    body: 'Products whose effective price fell versus last edition, sorted by the biggest move. <b>Why it helps:</b> the strongest new deals come to you.' },
  { route: '/price-increases', element: '.pm-compare-banner, .orders-header', title: 'Price Increases',
    savings: '⏰ Buy ahead or re-evaluate',
    body: 'Products whose effective price rose versus last edition. <b>Why it helps:</b> spot the watch-outs and stock up before a rise.' },

  // ---- Alerts ----
  { route: '/alerts', element: '.page-header, .alert-grid', title: 'Alerts: your daily digest',
    savings: "💰 Don't miss a deal, avoid a mistake",
    body: "A grouped digest of <b>opportunities</b> worth chasing and <b>watch-outs</b> to avoid, refreshed automatically. Click any card to jump to the detail. <b>Why it helps:</b> a minute a day keeps you on top of the market." },

  // ---- Cart ----
  { route: '/cart', element: '[data-tour="cart-group"], [data-tour="cart-add"]', title: 'Cart: one order per rep, priced',
    savings: '⚡ A full day of ordering in one click',
    body: "Your cart auto-groups by the rep who covers each distributor, with totals, tier pricing and combo handling worked out. RIP-qualifying mixes show their progress towards the next rebate threshold. <b>Why it helps:</b> no manual sorting, no maths." },
  { route: '/cart', element: '[data-tour="cart-send"], [data-tour="cart-add"]', title: 'Cart: send every PO at once',
    savings: '⚡ From browsing to sent orders in minutes',
    body: '<b>Send All Orders to Reps</b> emails each rep their purchase order. That closes the loop: find deals → add across distributors → send. <b>Why it helps:</b> a full day of ordering, in one button.' },

  // ---- My Work ----
  { route: '/watchlist', element: '.tracker-header', title: 'Favorites: your watchlist',
    savings: '💰 Get told when it hits your price',
    body: 'Star products to track here, set a <b>target price</b>, and CELR flags a buy signal with a trend per row. <b>Why it helps:</b> watch a few products and be told when to act.' },
  { route: '/todo', element: '.todo-board', title: 'To-Do: weekly board',
    savings: '⚡ Never miss a deal deadline',
    body: 'Tasks sort into weekly buckets by due date, with a red <b>Past</b> column for overdue. Right-click any product and choose <b>Add to To-Do</b>; drag a card to reschedule. <b>Why it helps:</b> your week, ordered for you.' },
  { route: '/notes', element: '.sticky-composer', title: 'Notes: everything in one place',
    body: 'Quick sticky notes, plus one searchable feed of every note you have written anywhere (a product, an order, a favourite), each linking back. <b>Why it helps:</b> nothing you jotted down gets lost.' },
  { route: '/orders', element: '.orders-header', title: 'Orders: sent purchase orders',
    savings: '💰 See the rebate you earn back',
    body: 'Every order, with totals, the rebate you earn back and your margin. Reopen and re-submit as a new revision, cancel, or re-share the PDF. <b>Why it helps:</b> a sent order stays editable and traceable.' },
  { route: '/lists', element: '[data-tour="lists-panel"]', title: 'Lists: reusable buying lists',
    savings: '💰 Reorder a whole list in two clicks',
    body: 'Named lists built by right-clicking products and choosing <b>Add to List</b>. Move a list to the cart in one go; the list stays to reuse. <b>Why it helps:</b> plan once, reorder forever.' },

  // ---- Setup ----
  { route: '/configuration', element: '.tab-bar', title: 'Setup: do this once',
    body: 'Tabs for <b>Sales Reps</b>, <b>Divisions</b> and <b>Stores</b>. Adding each rep with their <b>email</b> is what makes the cart auto-route every PO to the right person. <b>Why it helps:</b> a one-time setup that powers the cart for the life of the account.' },

  // ---- Finish ----
  { route: '/tours', element: '.tours-grid', title: 'Want hands-on detail?',
    body: 'Each screen has its own <b>detailed tour</b> here that runs on the real page click by click, including adding to the cart. <b>Why it helps:</b> learn one screen properly when you need to.' },
  { route: '/tours', element: 'a[href="/how-to-guide"]', title: "You're ready! 🎉",
    savings: '💰 Thousands saved a week, with less effort',
    body: "That's the whole loop: <b>find a deal, add to cart, send to your rep</b>, with the maths done for you. There's a written <b>How To Guide</b> too, and you can re-run any tour any time. Happy buying!" },
];

function waitForEl(sel?: string, timeout = 4000): Promise<void> {
  return new Promise(resolve => {
    if (!sel) { setTimeout(resolve, 250); return; }
    const start = Date.now();
    const tick = () => {
      // Each step gets the FIRST element it can find from a comma-separated
      // list, so steps that target a slightly different selector across
      // related pages (e.g. ".page-header, .orders-header") still resolve.
      if (document.querySelector(sel) || Date.now() - start > timeout) resolve();
      else requestAnimationFrame(tick);
    };
    tick();
  });
}

export async function startGuidedTour(navigate: NavFn) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const drv = driver({
    showProgress: true,
    allowClose: true,
    overlayColor: 'rgba(15, 23, 42, 0.55)',
    stagePadding: 6,
    popoverClass: 'celr-tour',
    nextBtnText: 'Next →',
    prevBtnText: '← Back',
    doneBtnText: 'Finish',
    steps: STEPS.map(s => ({
      element: s.element,
      popover: { title: s.title, description: s.body },
    })),
    onHighlighted: (_el: Element | undefined, _step: unknown, opts: any) => {
      showStepSavings(STEPS[opts.state.activeIndex ?? 0]?.savings);
    },
    onNextClick: async (_el: Element | undefined, _step: unknown, opts: any) => {
      showStepSavings(undefined);
      const next = STEPS[(opts.state.activeIndex ?? 0) + 1];
      if (next) {
        if (next.route && window.location.pathname !== next.route) navigate(next.route);
        await waitForEl(next.element);
      }
      opts.driver.moveNext();
    },
    onPrevClick: async (_el: Element | undefined, _step: unknown, opts: any) => {
      showStepSavings(undefined);
      const prev = STEPS[(opts.state.activeIndex ?? 0) - 1];
      if (prev) {
        if (prev.route && window.location.pathname !== prev.route) navigate(prev.route);
        await waitForEl(prev.element);
      }
      opts.driver.movePrevious();
    },
    onDestroyed: () => showStepSavings(undefined),
  });

  const first = STEPS[0];
  if (first.route && window.location.pathname !== first.route) navigate(first.route);
  await waitForEl(first.element);
  drv.drive();
}
