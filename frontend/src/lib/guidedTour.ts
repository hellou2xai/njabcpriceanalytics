/**
 * Guided product tour (driver.js). Walks the user through the REAL screens one at a
 * time, navigating routes between steps and highlighting live elements, with the
 * purpose and benefit of each page called out. Launched from the "Guided Tour" item
 * in the nav.
 *
 * If a step's element isn't found (slow load, layout change), driver.js shows the
 * popover centred instead of breaking, so the tour always completes.
 */
import { driver } from 'driver.js';
import 'driver.js/dist/driver.css';
import { showStepSavings } from './screenTour';

type NavFn = (path: string) => void;

interface Step { route?: string; element?: string; title: string; body: string; savings?: string; }

const STEPS: Step[] = [
  // ---- Welcome ----
  { route: '/', title: 'Welcome to CELR 👋',
    savings: '💰 The maths is done. You just decide.',
    body: 'CELR reads every New Jersey wholesaler’s monthly price book and works out all the discount and rebate maths for you. This is the quick overview of the whole app, about 6 minutes. For a hands-on, click-by-click tour of any single screen, the <b>Guided Tours</b> page has one per screen. Click <b>Next</b>.' },
  { route: '/', element: '.sidebar-nav', title: 'Your menu',
    body: 'Everything is grouped: <b>Overview</b> (your day), <b>Find Deals</b> (the catalogue, new items, bundles, rebates), <b>My Work</b> (favourites, to-dos, notes, orders, lists), and <b>Setup</b>. <b>Why it helps:</b> every tool is one click away.' },

  // ---- Dashboard ----
  { route: '/', element: '.kpi-grid', title: 'Dashboard: the month at a glance',
    savings: '💰 The whole month’s savings pool, up front',
    body: 'Six cards summarise this month’s price book: total items, active discounts (and the dollars on the table), clearance, price moves, and active rebates. <b>Each is clickable</b> and jumps to that list. <b>Why it helps:</b> see what changed without searching.' },
  { route: '/', element: '.filter-pills', title: 'Dashboard: focus on one distributor',
    body: 'These chips re-scope the whole dashboard to a single distributor, or all of them. <b>Why it helps:</b> see the picture for just the supplier you are working with.' },
  { route: '/', element: '.dashboard-tile-grid', title: 'Dashboard: your workspace',
    body: 'Compact tiles for your own activity: favourites, recent orders, notes. Each opens its full detail in a pop-up. <b>Why it helps:</b> pick up where you left off.' },
  { route: '/', element: '.section-label', title: 'Dashboard: three bands',
    body: 'The dashboard runs in three sections: <b>Key Metrics</b>, <b>My Workspace</b>, and <b>Insights & Opportunities</b>. <b>Why it helps:</b> numbers, your work, then the deals.' },
  { route: '/', title: 'Dashboard: opportunities found for you',
    savings: '💰 The best deals surface on their own',
    body: 'Lower down, CELR does the hunting: <b>Time-Sensitive Deals</b>, <b>Biggest Price Drops</b>, <b>Top Discounts</b>, and cross-distributor “who’s cheaper”. <b>Why it helps:</b> you never have to go looking for the best deals.' },

  // ---- Catalog ----
  { route: '/catalog', element: '.orders-header', title: 'Catalog: every product, one place',
    body: 'The full list from every distributor. The buttons top-right (All, Allied, Fedway, Highgrade, Opici, Peerless) focus on one supplier. <b>Why it helps:</b> shop one wholesaler, or compare them all.' },
  { route: '/catalog', element: '.search-bar', title: 'Catalog: smart search',
    savings: '⚡ Find anything, even misspelled',
    body: 'Search by name or barcode. <b>Shorthand and typos work</b>: “JW Blue” finds Johnnie Walker Blue, “hennesy” is corrected to Hennessy. <b>Why it helps:</b> reach any of 40,000+ products in seconds.' },
  { route: '/catalog', element: '.filter-panel', title: 'Catalog: filters',
    body: 'Narrow the whole catalogue by deal (RIP, discount, in-combo), category, brand, size and price, or show only your Favourites. <b>Why it helps:</b> go from 40,000 products to your shortlist.' },
  { route: '/catalog', element: '.catalog-table-wrap', title: 'Catalog: the real cost and tiers',
    savings: '💰 Your true cost, and the quantity that saves most',
    body: 'Each row shows the list <b>Case/Btl</b> price and the <b>Effective</b> price (after the best discount and rebate), plus quantity <b>tiers</b> (buy N for this price). <b>Why it helps:</b> buy at the smartest quantity, not the sticker price.' },
  { route: '/catalog', element: '.better-price-badge', title: 'Catalog: a cheaper source, flagged',
    savings: '💰 Never overpay: cheaper rep called out',
    body: 'When the same product is cheaper at another distributor, a <b>Better price</b> note appears under its name. <b>Why it helps:</b> you switch to the cheaper source automatically.' },
  { route: '/catalog', element: '.catalog-order-inline', title: 'Catalog: order from the row',
    savings: '⚡ Build the order as you browse',
    body: 'Set cases/bottles and <b>Add to cart</b> or <b>Add to list</b> right from the row. Items land in the cart, top-right, grouped by rep. <b>Why it helps:</b> no jumping between screens.' },
  { route: '/catalog', element: '.row-menu-btn', title: 'Right-click: quick actions anywhere',
    body: 'Right-click <b>any product</b> (or this ⋯) for: View, Search the web, Add to Cart, Favorites, List, To-Do, and Copy barcode. <b>Why it helps:</b> act on a product in one click.' },
  { route: '/catalog', element: '.toolbar', title: 'Catalog: sort and page',
    body: 'Sort by name, case price or effective price, set rows per page, and page through at the bottom. <b>Why it helps:</b> put the best value on top.' },

  // ---- New Items ----
  { route: '/new-items', element: '.orders-header', title: 'New Items: what just landed',
    savings: '⚡ Be first to this edition’s new lines',
    body: 'Products that appear this edition but were not in the last one, matched across months by barcode. <b>Why it helps:</b> spot new lines before your competitors.' },
  { route: '/new-items', element: '.tile-filter-bar', title: 'New Items: by edition',
    body: 'Filter by the month a product was introduced, with the full Catalog toolkit (search, filters, order facility) underneath. <b>Why it helps:</b> separate this month’s arrivals from older ones.' },

  // ---- Combos ----
  { route: '/combos', element: '.orders-header', title: 'Combos: bundle deals',
    savings: '💰 Bundles cost less than buying apart',
    body: 'Multi-product packs sold for less than buying each item separately. <b>Why it helps:</b> usually the biggest single saving on the board.' },
  { route: '/combos', element: '.rip-summary-cards', title: 'Combos: the savings at a glance',
    savings: '💰 Average and biggest bundle saving',
    body: 'These cards show how many bundles, the average and biggest saving, and the average discount. <b>Why it helps:</b> gauge the value fast.' },
  { route: '/combos', element: '.table-container', title: 'Combos: the bundle list',
    body: 'Each row is a bundle with its products, the combo price, and the saving vs buying separately. Click one to open the full breakdown, then add the whole pack to your cart. <b>Why it helps:</b> bigger savings in one move.' },

  // ---- RIP Products ----
  { route: '/rip-products', element: '.rip-summary-cards', title: 'RIP Products: rebates',
    savings: '💰 Average and biggest saving per case',
    body: 'Every rebate (RIP) and discount, with per-bottle effective pricing at each tier. <b>Why it helps:</b> see the rebate money on the table at a glance.' },
  { route: '/rip-products', element: '.rip-products-table', title: 'RIP Products: this month vs next',
    savings: '⚡ Buy before a rebate changes',
    body: 'Each product shows its incentive tiers with <b>this month next to next month</b>. Discounts and RIP rebates are two separate incentives and both are shown. <b>Why it helps:</b> time your volume buys before a program changes.' },
  { route: '/rip-products', element: '.source-badge', title: 'RIP Products: discount or rebate',
    savings: '💰 Know which incentive you’re getting',
    body: 'A tag marks each line as a <b>Discount</b> or a <b>RIP</b> rebate, with its RIP code and tiers. <b>Why it helps:</b> never confuse the two incentives.' },

  // ---- Cart ----
  { route: '/cart', element: '[data-tour="cart-add"]', title: 'Cart: build and top up',
    body: 'Everything you add lands here. You can also search and add products straight from the cart. <b>Why it helps:</b> finish an order without going back.' },
  { route: '/cart', element: '[data-tour="cart-send"]', title: 'Cart: grouped, priced, sent',
    savings: '⚡ A full day’s ordering in one click',
    body: 'The cart auto-groups by the rep who covers each distributor, with totals, deal tiers and combo pricing worked out. <b>Send All Orders to Reps</b> emails each rep their PO. <b>Why it helps:</b> from browsing to sent orders in minutes.' },

  // ---- Favorites ----
  { route: '/watchlist', element: '.tracker-header', title: 'Favorites: your watchlist',
    savings: '💰 Get told when it hits your price',
    body: 'Star products to track here, set a <b>target price</b>, and CELR alerts you when the market reaches it, with a buy-signal and trend on each. <b>Why it helps:</b> watch a few products and be told when to act.' },
  { route: '/watchlist', element: '.tracker-table', title: 'Favorites: target price and buy signal',
    savings: '⚡ Act at the right moment, not too late',
    body: 'Live case price, your target, the buy signal, and a quantity stepper to order on the spot. <b>Why it helps:</b> the decision is made for you.' },

  // ---- To-Do ----
  { route: '/todo', element: '.todo-board', title: 'To-Do: never lose a follow-up',
    body: 'A board where tasks sort into weekly buckets by due date, with a red <b>Past</b> column for anything overdue. <b>Why it helps:</b> your week, ordered for you.' },
  { route: '/todo', element: '.todo-board', title: 'To-Do: capture and reschedule',
    savings: '⚡ Never miss a deal deadline',
    body: 'Right-click any product anywhere and choose <b>Add to To-Do</b>, or use the <b>+</b> on a column. Drag a card to another week to reschedule. <b>Why it helps:</b> catch time-sensitive deals before they lapse.' },

  // ---- Notes ----
  { route: '/notes', element: '.tracker-header', title: 'Notes: everything in one place',
    body: 'Quick sticky notes up top, and one feed of every note you have written anywhere (a product, an order, a favourite), each linking back. <b>Why it helps:</b> nothing you jotted down gets lost.' },
  { route: '/notes', element: '.filter-bar', title: 'Notes: one searchable feed',
    body: 'Filter the feed by source and search every note by title and text. <b>Why it helps:</b> find that thing you wrote weeks ago.' },

  // ---- Orders ----
  { route: '/orders', element: '.orders-header', title: 'Orders: sent purchase orders',
    savings: '💰 See the rebate you earn back',
    body: 'Every order, with totals, the rebate you earn back, and your margin. <b>Why it helps:</b> judge the value of what you have bought.' },
  { route: '/orders', element: '.tab-bar', title: 'Orders: reopen, revise, re-share',
    body: 'List view or every order line at once. Open an order to reopen and re-submit as a new revision, cancel it, or re-share the PDF. <b>Why it helps:</b> a sent order stays editable and traceable.' },

  // ---- Lists ----
  { route: '/lists', element: '[data-tour="lists-panel"]', title: 'Lists: reusable buying lists',
    savings: '💰 Reorder a whole list in two clicks',
    body: 'Named lists (a seasonal reset, a promo, a regular reorder) built by right-clicking products and choosing <b>Add to List</b>. Move them to the cart in one go; the list stays to reuse. <b>Why it helps:</b> plan once, reorder forever.' },

  // ---- Alerts ----
  { route: '/alerts', element: '.page-header', title: 'Alerts: your daily digest',
    savings: '💰 Don’t miss a deal, avoid a mistake',
    body: 'A short, grouped digest of what changed and what to do, refreshed automatically. <b>Why it helps:</b> the important moves without scanning every screen.' },
  { route: '/alerts', element: '.alert-grid', title: 'Alerts: opportunities and watch-outs',
    body: 'Cards split into <b>opportunities</b> worth chasing and <b>watch-outs</b> to avoid a mistake. Click one to jump to the detail. <b>Why it helps:</b> a minute a day keeps you on top of the market.' },

  // ---- Setup ----
  { route: '/configuration', element: '.tab-bar', title: 'Setup: do this once',
    body: 'Three tabs: <b>Sales Reps</b>, <b>Divisions</b>, and <b>Stores</b>. <b>Why it helps:</b> this one-time setup powers the cart’s rep grouping and the auto-emailed orders.' },
  { route: '/configuration', element: '.inline-form', title: 'Setup: reps and their email',
    body: 'Add each rep with their distributor, division, and crucially their <b>email</b>, the address a sent order’s PO goes to. <b>Why it helps:</b> orders route to the right person automatically.' },

  // ---- Deep dives + finish ----
  { route: '/tours', element: '.tours-grid', title: 'Want hands-on detail?',
    body: 'Each screen has its own <b>detailed tour</b> here that runs on the real page and walks you through it click by click, including adding to the cart. <b>Why it helps:</b> learn one screen properly when you need to.' },
  { route: '/tours', element: 'a[href="/how-to-guide"]', title: 'You’re ready! 🎉',
    savings: '💰 Thousands saved every week, with less effort',
    body: 'That’s the whole loop: <b>find a deal, add to cart, send to your rep</b>, with the maths done for you. There’s a written <b>How To Guide</b> too, and you can re-run any tour any time. Happy buying!' },
];

function waitForEl(sel?: string, timeout = 4000): Promise<void> {
  return new Promise(resolve => {
    if (!sel) { setTimeout(resolve, 250); return; }
    const start = Date.now();
    const tick = () => {
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
