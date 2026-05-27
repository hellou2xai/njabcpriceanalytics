/**
 * Guided product tour (driver.js). Walks the user through the REAL screens,
 * navigating routes between steps and highlighting live elements, with a benefit
 * called out at every stage. Launched from the "Guided Tour" item in the nav.
 *
 * If a step's element isn't found (slow load, layout change), driver.js shows the
 * popover centred instead of breaking, so the tour always completes.
 */
import { driver } from 'driver.js';
import 'driver.js/dist/driver.css';

type NavFn = (path: string) => void;

interface Step { route?: string; element?: string; title: string; body: string; }

const STEPS: Step[] = [
  { route: '/', title: 'Welcome to CELR 👋',
    body: 'A 2-minute walk through the real screens. By the end you will know how to find a deal, build an order, and send it to your rep. Click <b>Next</b> to start.' },
  { route: '/', element: '.sidebar-nav', title: 'Your menu',
    body: 'Everything is grouped: Overview, Find Deals, My Work, Setup. <b>Why it helps:</b> reach any tool in one click.' },
  { route: '/', element: '.kpi-grid', title: 'The month at a glance',
    body: 'These cards summarise this month’s price book: total items, active discounts, clearance, and what moved. Each one is clickable. <b>Why it helps:</b> see the day’s highlights without searching.' },
  { route: '/catalog', element: '.search-bar', title: 'Find any product',
    body: 'Search by name or barcode. Shorthand and typos work too — try “JW Blue” or “Henny”. <b>Why it helps:</b> find anything out of 40,000+ products instantly.' },
  { route: '/catalog', element: '.catalog-table-wrap', title: 'Read the real cost',
    body: 'Each product shows the <b>Effective</b> price — what you actually pay after the discount and RIP — plus its quantity tiers. <b>Why it helps:</b> buy at the smartest quantity, not just the sticker price.' },
  { route: '/catalog', element: '.catalog-order-inline', title: 'Add to cart',
    body: 'Set cases/bottles and <b>Add to cart</b> straight from the list (or right-click any product). The cart, top-right, groups items by sales rep. <b>Why it helps:</b> build your order as you browse.' },
  { route: '/cart', element: '[data-tour="cart-send"]', title: 'Send to your reps',
    body: 'Your cart is grouped by rep with the deal info, tiers and notes. One click — <b>Send All Orders to Reps</b> — emails each rep their purchase order. <b>Why it helps:</b> order in one click, no spreadsheets.' },
  { route: '/combos', element: '.orders-header', title: 'Bundle deals',
    body: 'Combos are multi-product packs sold cheaper than buying the items separately. Open one to see the breakdown, then add the whole bundle to your cart. <b>Why it helps:</b> bigger savings in one move.' },
  { route: '/rip-products', element: '.orders-header', title: 'Rebates (RIP)',
    body: 'Every rebate this month next to next month, with per-bottle effective pricing at each tier. <b>Why it helps:</b> time your volume buys before a program changes.' },
  { route: '/watchlist', element: '.tracker-header', title: 'Favorites & target price',
    body: 'Star products to watch, set a <b>target price</b>, and get alerted when the market reaches it. <b>Why it helps:</b> never miss your price.' },
  { route: '/todo', element: '.orders-header', title: 'To-Do board',
    body: 'Right-click any product anywhere to add a dated task, then drag cards between weeks. <b>Why it helps:</b> a follow-up never slips.' },
  { route: '/configuration', title: 'One-time setup',
    body: 'Add your sales reps and their emails under Configuration. <b>Why it helps:</b> this is what powers the cart’s rep grouping and the auto-emailed orders.' },
  { element: 'a[href="/how-to-guide"]', title: 'You’re ready! 🎉',
    body: 'That’s the whole loop: find a deal → add to cart → send to your rep. For a written reference on any screen, open the <b>How To Guide</b> any time. Happy buying!' },
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
