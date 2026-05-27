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

type NavFn = (path: string) => void;

interface Step { route?: string; element?: string; title: string; body: string; }

const STEPS: Step[] = [
  // ---- Welcome ----
  { route: '/', title: 'Welcome to CELR 👋',
    body: 'CELR reads every New Jersey wholesaler’s monthly price book and does all the discount and rebate maths for you. This tour walks each screen one at a time: what it’s for and how it helps. It takes about 3 minutes. Click <b>Next</b>.' },
  { route: '/', element: '.sidebar-nav', title: 'The menu',
    body: 'Screens are grouped: <b>Overview</b> (your day), <b>Find Deals</b> (the catalogue, new items, bundles, rebates), <b>My Work</b> (favourites, to-dos, notes, orders, lists), and <b>Setup</b>. <b>Why it helps:</b> every tool is one click away.' },

  // ---- Dashboard ----
  { route: '/', element: '.kpi-grid', title: 'Dashboard: the month at a glance',
    body: 'These six cards are the shape of this month’s price book: total items, active discounts (and the dollars on the table), clearance, price drops and increases, active rebates. <b>Each card is clickable</b> and jumps to that list. <b>Why it helps:</b> see what changed without searching.' },
  { route: '/', title: 'Dashboard: opportunities found for you',
    body: 'Below the cards, CELR does the hunting: <b>Time-Sensitive Deals</b> (expiring soon), <b>Biggest Price Drops</b>, <b>Top Discounts</b>, and cross-distributor “who’s cheaper”. <b>Why it helps:</b> the best deals surface on their own, so you never miss one.' },

  // ---- Catalog ----
  { route: '/catalog', element: '.orders-header', title: 'Catalog: every product, one place',
    body: 'The full product list from every distributor. Use the buttons top-right (All Distributors, Allied, Fedway, Highgrade, Opici, Peerless) to focus on one supplier. <b>Why it helps:</b> shop one wholesaler, or compare them all.' },
  { route: '/catalog', element: '.search-bar', title: 'Catalog: smart search',
    body: 'Search by name or barcode. <b>Shorthand and typos work</b>: “JW Blue” finds Johnnie Walker Blue, “Henny” finds Hennessy, “hennesy” is auto-corrected. <b>Why it helps:</b> find anything out of 40,000+ products, even if you’re not sure of the exact name.' },
  { route: '/catalog', element: '.catalog-table-wrap', title: 'Catalog: the real cost and tiers',
    body: 'Each row shows the list <b>Case/Btl</b> price and the <b>Effective</b> price, what you truly pay after the best discount and rebate. Underneath are the quantity <b>tiers</b> (buy N cases for this price), so you can see exactly how many to buy to hit a better deal. <b>Why it helps:</b> decide the smartest quantity, not just the sticker price.' },
  { route: '/catalog', element: '.catalog-order-inline', title: 'Catalog: add to cart',
    body: 'Set cases/bottles and click <b>Add to cart</b> (or <b>Add to list</b>) right from the row. Items land in the cart, top-right, grouped by sales rep. <b>Why it helps:</b> build your order while you browse.' },
  { route: '/catalog', element: '.row-menu-btn', title: 'Right-click: quick actions anywhere',
    body: 'Right-click <b>any product</b> on any page, or click this “⋯” button, for instant actions: <b>View details</b>, <b>Search the web</b> for retail prices, <b>Add to Cart</b>, <b>Add to Favorites</b>, <b>Add to List</b>, <b>Add to To-Do</b>, and <b>Copy barcode</b>. <b>Why it helps:</b> act on a product without leaving the page.' },

  // ---- Cart ----
  { route: '/cart', element: '[data-tour="cart-send"]', title: 'Cart: grouped by sales rep',
    body: 'Your cart auto-groups items by the rep who covers each distributor, with per-line and per-rep totals, the deal tiers, notes, and save-for-later. One click, <b>Send All Orders to Reps</b>, turns each group into a purchase order and emails it. <b>Why it helps:</b> from browsing to a sent order in one click. You can also add products right here with the search box.' },

  // ---- Combos ----
  { route: '/combos', element: '.orders-header', title: 'Combos: bundle deals',
    body: 'Multi-product packs sold for less than buying the items separately. The cards show average and biggest savings; click any bundle to see exactly what’s inside and the per-item saving, then add the whole pack to your cart. <b>Why it helps:</b> bigger savings in one move.' },

  // ---- RIP Products ----
  { route: '/rip-products', element: '.orders-header', title: 'RIP Products: rebates',
    body: 'Every rebate (RIP) and discount, with <b>this month next to next month</b> and per-bottle effective pricing at each tier. Filter by distributor, type, minimum saving or margin. <b>Why it helps:</b> time your volume buys before a rebate program changes.' },

  // ---- Favorites ----
  { route: '/watchlist', element: '.tracker-header', title: 'Favorites: your watchlist',
    body: 'Star products to track them here. Set a <b>target price</b> and CELR alerts you when the market reaches it; see a buy-signal and price trend on each. <b>Why it helps:</b> watch the handful of products you care about and get told when to act.' },

  // ---- To-Do (full feature demo) ----
  { route: '/todo', element: '.todo-board', title: 'To-Do: never let a follow-up slip',
    body: 'A simple board so nothing gets forgotten. Tasks sort into buckets by due date: a red <b>Past</b> (overdue) column, then <b>This week</b>, <b>Next week</b>, <b>In 2 weeks</b>, and <b>3+ weeks / Later</b>, each with its dates and a count.' },
  { route: '/todo', element: '.todo-board', title: 'To-Do: add a task',
    body: 'Add one two ways: <b>right-click any product</b> anywhere and choose <b>Add to To-Do</b> (the product and the page are saved with it for context), or use the <b>+</b> on a column for a standalone task with a note and due date. <b>Why it helps:</b> capture “come back to this” the moment you think of it.' },
  { route: '/todo', element: '.todo-board', title: 'To-Do: manage and reschedule',
    body: 'On each card you can tick it <b>done</b>, <b>edit</b> it, <b>delete</b> it, or click the product to open it. <b>Drag a card to another week</b> to reschedule and the due date moves with it. Overdue tasks stay red in Past; finished ones collect in a Done list. <b>Why it helps:</b> your follow-ups stay dated, sorted by urgency, and one drag from rescheduled.' },

  // ---- Notes ----
  { route: '/notes', element: '.tracker-header', title: 'Notes: everything in one place',
    body: 'Quick sticky notes up top, and below them one feed of every note you’ve written anywhere, on a product, an order, or a favourite, each linking back to where it came from. <b>Why it helps:</b> nothing you jotted down gets lost.' },

  // ---- Lists ----
  { route: '/lists', title: 'Lists: reusable buying lists',
    body: 'Build named lists (a seasonal reset, a promo, a regular reorder) by right-clicking products and choosing <b>Add to List</b>. Later, tick what you want and move it to the cart in one go; the list stays intact to reuse. <b>Why it helps:</b> plan once, reorder forever.' },

  // ---- Orders ----
  { route: '/orders', element: '.orders-header', title: 'Orders: sent purchase orders',
    body: 'Every order you’ve sent, with totals, the rebate you’ll earn back, and your margin. Reopen one to edit and re-submit as a new revision, cancel it, or re-share the PDF. <b>Why it helps:</b> a sent order is still traceable and editable, with your rep kept in sync.' },

  // ---- Setup ----
  { route: '/configuration', title: 'Setup: do this once',
    body: 'Under <b>Configuration</b>, add your sales reps with their <b>email</b> (that’s where a sent order’s PO goes), your divisions, and your stores. <b>Why it helps:</b> this one-time setup is what powers the cart’s rep grouping and the auto-emailed orders.' },

  // ---- Finish ----
  { element: 'a[href="/how-to-guide"]', title: 'You’re ready! 🎉',
    body: 'That’s the whole loop: <b>find a deal, add to cart, send to your rep</b>, with the maths done for you. For a written reference on any screen, open the <b>How To Guide</b> any time. You can re-run this tour from <b>Guided Tour</b> whenever you like. Happy buying!' },
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
    onNextClick: async (_el: Element | undefined, _step: unknown, opts: any) => {
      const next = STEPS[(opts.state.activeIndex ?? 0) + 1];
      if (next) {
        if (next.route && window.location.pathname !== next.route) navigate(next.route);
        await waitForEl(next.element);
      }
      opts.driver.moveNext();
    },
    onPrevClick: async (_el: Element | undefined, _step: unknown, opts: any) => {
      const prev = STEPS[(opts.state.activeIndex ?? 0) - 1];
      if (prev) {
        if (prev.route && window.location.pathname !== prev.route) navigate(prev.route);
        await waitForEl(prev.element);
      }
      opts.driver.movePrevious();
    },
  });

  const first = STEPS[0];
  if (first.route && window.location.pathname !== first.route) navigate(first.route);
  await waitForEl(first.element);
  drv.drive();
}
