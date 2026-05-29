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
    body: "Five sections: <b>Overview</b> (your day), <b>Catalog</b> (the price book + new items + combos), <b>Promotions</b> (Time-Sensitive, Major Discounts, Price Drops, Price Increases), <b>My Work</b> (favourites, to-dos, notes, orders, lists) and <b>Setup</b>. <b>Why it helps:</b> every tool is one click away, and related ones sit together." },

  // ---- Dashboard ----
  { route: '/', element: '.kpi-grid', title: 'Dashboard: the month at a glance',
    savings: "💰 The whole month's savings pool, up front",
    body: "Six cards summarise this month's price book: total items, active discounts (and the dollars on the table), clearance, price moves and active rebates. <b>Each card is clickable</b> and jumps to that list. <b>Why it helps:</b> see what changed without searching." },
  { route: '/', element: '.filter-pills', title: 'Dashboard: focus on one distributor',
    body: "These chips re-scope the whole dashboard to a single distributor, or All. <b>Why it helps:</b> see the picture for just the supplier you're working with." },
  { route: '/', element: '.dashboard-tile-grid', title: 'Dashboard: your workspace',
    body: 'Compact tiles for your own activity: favourites, recent orders, notes. Each opens its full detail in a pop-up. <b>Why it helps:</b> pick up where you left off.' },

  // ---- Alerts ----
  { route: '/alerts', element: '.page-header', title: 'Alerts: your daily digest',
    savings: "💰 Don't miss a deal, avoid a mistake",
    body: "A grouped digest of <b>opportunities</b> worth chasing and <b>watch-outs</b> to avoid, refreshed automatically. Click any card to jump to the detail. <b>Why it helps:</b> a minute a day keeps you on top of the market." },

  // ---- Catalog (deep dive) ----
  { route: '/catalog', element: '.orders-header', title: 'Catalog: every product, one place',
    body: 'The full list from every distributor. The buttons top-right (All, Allied, Fedway, Highgrade, Opici, Peerless) focus on one supplier or show everyone. <b>Why it helps:</b> shop one wholesaler, or compare them all.' },
  { route: '/catalog', element: '.search-bar', title: 'Catalog: smart search',
    savings: '⚡ Find anything, even misspelled',
    body: 'Search by name or barcode. <b>Shorthand and typos work</b>: "JW Blue" finds Johnnie Walker Blue, "hennesy" is corrected to Hennessy. <b>Why it helps:</b> reach any of 40,000+ products in seconds.' },
  { route: '/catalog', element: '[data-tour="filter-favorites"]', title: 'Catalog: pills above the table',
    body: 'The row of pills along the top toggle quick filters: <b>In Favorites</b>, <b>Group by Case Mix RIP</b>, <b>Has RIP</b>, <b>Has Discount</b>, <b>Price Drop</b>, <b>Price Increase</b>. Tap one to narrow the list instantly. <b>Why it helps:</b> the common views are one click away, no dropdowns.' },
  { route: '/catalog', element: '[data-tour="filter-price-drop"]', title: 'Catalog: Price Drop / Price Increase',
    savings: '💰 Buy before a rise, wait for a drop',
    body: 'These two pills work as a radio: pick one to see only products whose <b>effective best price changes from this month to next</b>. Drop = cheaper next month (worth waiting). Increase = pricier next month (worth buying now). <b>Why it helps:</b> time your buys, not your guesses.' },
  { route: '/catalog', element: '[data-tour="filter-group-rip"]', title: 'Catalog: Group by Case Mix RIP',
    savings: '💰 Build the rebate basket without searching',
    body: 'Toggle this on and CELR clusters every product that shares a <b>Case Mix RIP</b> rebate. Each group gets a coloured stripe, and a <b>banner</b> sits above the cluster with the tier ladder, your progress and an <b>Add All Case Mix to Cart</b> button. <b>Why it helps:</b> hit the rebate threshold by buying the WHOLE qualifying mix in one click, instead of hunting members one by one.' },
  { route: '/catalog', element: '.catalog-filter-dd', title: 'Catalog: dropdown filters',
    body: 'For tighter control, the dropdowns narrow by <b>Deals, Distributors, Brand, Price (Case), Category</b> and <b>Size</b>. Every dropdown supports multi-select. <b>Why it helps:</b> go from 40,000 products to your shortlist in a few clicks.' },
  { route: '/catalog', element: '.catalog-table-wrap', title: 'Catalog: the row, top to bottom',
    savings: '💰 Your real cost, and the qty that saves most',
    body: "Each row shows the product, list <b>Case/Btl</b> price, the <b>Effective</b> price after the best discount and rebate, and any tier ladder beneath it. <b>Why it helps:</b> compare what you'll really pay, not the sticker price." },
  { route: '/catalog', element: '.catalog-pro-th', title: 'Catalog: Pro columns (Suggested Qty + Justification)',
    savings: '⚡ Buy what your store actually sells',
    body: "Two <b>Pro</b> columns preview what POS integration will surface: a <b>Suggested Qty</b> for this product and a <b>Quantity Justification</b> (your store's sell-through, current on-hand, and the case count to buy). <b>Why it helps:</b> upgrade and your buying becomes data-driven instead of gut-feel." },
  { route: '/catalog', element: '.mes-wrap', title: 'Catalog: this month vs next, at a glance',
    savings: '🗓 See the next-month move without leaving the row',
    body: "The little sparkline plots <b>this month's best effective price next to next month's</b>, with the dollar move. Hover it for a side-by-side popover showing Frontline → Discount → RIP tiers → Best for both months. <b>Why it helps:</b> spot a coming price change before it hits." },
  { route: '/catalog', element: '.better-price-badge', title: 'Catalog: a cheaper source, flagged',
    savings: '💰 Cheaper rep called out automatically',
    body: 'When the same product is cheaper at another distributor (this month or next), a <b>Better price: THIS / NEXT MONTH</b> note appears under the name. <b>Why it helps:</b> you never overpay because a sister distributor was cheaper.' },
  { route: '/catalog', element: '.catalog-row-sub', title: 'Catalog: tier ladder with the order block',
    savings: '⚡ Quantity inputs sit next to the ladder',
    body: 'Each tier sub-row shows a rung of the ladder (Buy N for $X). The <b>Case</b> and <b>Btl</b> steppers and the <b>Add to cart</b> / <b>Add to list</b> buttons are embedded on the LEFT of the first tier rung. Type any qty, the <b>best applicable tier is applied automatically</b>. <b>Why it helps:</b> ladder and inputs in one band, no scrolling between them.' },
  { route: '/catalog', element: '.row-menu-btn', title: 'Catalog: right-click for quick actions',
    body: 'Right-click any product (or this ⋯) for: View, Search the web, Add to Cart, Favorites, List, To-Do, and Copy barcode. <b>Why it helps:</b> act on a product in one click, from any list in the app.' },
  { route: '/catalog', element: '.toolbar', title: 'Catalog: sort and page',
    body: 'Sort by name, case price or effective price, set rows per page, and page through at the bottom. <b>Why it helps:</b> put the best value on top.' },

  // ---- New Items ----
  { route: '/new-items', element: '.orders-header', title: 'New Items: what just landed',
    savings: "⚡ Be first to this edition's new lines",
    body: 'Products that appear this edition but were NOT in the previous one, matched across months by barcode (so a renamed product is still recognised). <b>Why it helps:</b> spot new lines before your competitors.' },

  // ---- Combos ----
  { route: '/combos', element: '.orders-header', title: 'Combos: bundle deals',
    savings: '💰 Bundles cost less than buying apart',
    body: 'Multi-product packs sold for less than buying each item separately. Click any combo to see its members, the bundle price and the saving. Add the whole pack to your cart in one move. <b>Why it helps:</b> usually the biggest single saving on the board.' },

  // ---- Promotions group ----
  { route: '/time-sensitive', element: '.page-header, .orders-header', title: 'Promotions: Time-Sensitive Deals',
    savings: '⏳ Closeouts before they sell through',
    body: 'CPL closeouts across every distributor, surfaced with a deadline. <b>Why it helps:</b> grab the discount before the stock goes.' },
  { route: '/price-drops', element: '.page-header, .orders-header', title: 'Promotions: Price Drops',
    savings: '💰 Cheaper next edition, listed for you',
    body: "Every product whose effective price drops next month, sorted by the biggest move. <b>Why it helps:</b> wait the right week and pocket the difference." },
  { route: '/price-increases', element: '.page-header, .orders-header', title: 'Promotions: Price Increases',
    savings: '⏰ Buy now before the rise hits',
    body: 'Every product whose effective price rises next month. <b>Why it helps:</b> stock up while the current price still holds.' },
  { route: '/major-discounts', element: '.page-header, .orders-header', title: 'Promotions: Major Discounts',
    savings: '💰 The biggest discount pool this month',
    body: 'The deepest CPL discounts in the current edition. <b>Why it helps:</b> headline savings, ranked for you.' },

  // ---- Cart ----
  { route: '/cart', element: '[data-tour="cart-group"]', title: 'Cart: one order per rep, priced',
    savings: '⚡ A full day of ordering in one click',
    body: "Your cart auto-groups by the rep who covers each distributor, with totals, tier pricing and combo handling worked out. RIP-qualifying mixes show their progress towards the next rebate threshold. <b>Why it helps:</b> no manual sorting, no maths." },
  { route: '/cart', element: '[data-tour="cart-send"]', title: 'Cart: send every PO at once',
    savings: '⚡ From browsing to sent orders in minutes',
    body: '<b>Send All Orders to Reps</b> emails each rep their purchase order. That closes the loop: find deals → add across distributors → send. <b>Why it helps:</b> a full day of ordering, in one button.' },

  // ---- Favorites ----
  { route: '/watchlist', element: '.tracker-header', title: 'Favorites: your watchlist',
    savings: '💰 Get told when it hits your price',
    body: 'Star products to track here, set a <b>target price</b>, and CELR alerts you when the market reaches it, with a buy signal and trend per row. <b>Why it helps:</b> watch a few products and be told when to act.' },

  // ---- To-Do ----
  { route: '/todo', element: '.todo-board', title: 'To-Do: weekly board',
    savings: '⚡ Never miss a deal deadline',
    body: 'A board where tasks sort into weekly buckets by due date, with a red <b>Past</b> column for anything overdue. Right-click any product in the app and choose <b>Add to To-Do</b>. Drag a card to another week to reschedule. <b>Why it helps:</b> your week, ordered for you.' },

  // ---- Notes ----
  { route: '/notes', element: '.tracker-header', title: 'Notes: everything in one place',
    body: 'Quick sticky notes up top, and one searchable feed of every note you have written anywhere (a product, an order, a favourite), each linking back. <b>Why it helps:</b> nothing you jotted down gets lost.' },

  // ---- Orders ----
  { route: '/orders', element: '.orders-header', title: 'Orders: sent purchase orders',
    savings: '💰 See the rebate you earn back',
    body: 'Every order, with totals, the rebate you earn back and your margin. Open an order to reopen and re-submit as a new revision, cancel it or re-share the PDF. <b>Why it helps:</b> a sent order stays editable and traceable.' },

  // ---- Lists ----
  { route: '/lists', element: '[data-tour="lists-panel"]', title: 'Lists: reusable buying lists',
    savings: '💰 Reorder a whole list in two clicks',
    body: 'Named lists (a seasonal reset, a promo, a regular reorder) built by right-clicking products and choosing <b>Add to List</b>. Move a list to the cart in one go; the list stays to reuse. <b>Why it helps:</b> plan once, reorder forever.' },

  // ---- Setup ----
  { route: '/configuration', element: '.tab-bar', title: 'Setup: do this once',
    body: 'Three tabs: <b>Sales Reps</b>, <b>Divisions</b> and <b>Stores</b>. Adding each rep with their <b>email</b> is what makes the cart auto-route every PO to the right person. <b>Why it helps:</b> a one-time setup that powers the cart for the life of the account.' },

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
