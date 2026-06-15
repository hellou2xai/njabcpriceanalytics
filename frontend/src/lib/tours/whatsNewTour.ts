/** What's New for You screen walkthrough. The hero, stats and the "what's on
 * this page" note always render on load; the change sections, savings stat and
 * savings panel are conditional on the buyer actually tracking products that
 * changed this edition, so those steps fall back to a centred popover when the
 * page is empty or all-clear. */
import { launchScreenTour, scrollIntoView, type ScreenStep } from '../screenTour';

const STEPS: ScreenStep[] = [
  { element: '.wn-hero', title: 'What’s New for You',
    body: 'Your personalised monthly digest. The moment a new edition lands, this page shows only what changed for the products you track. <b>Why it helps:</b> skip the whole price book and see just your items.' },
  { element: '.wn-hero-sub', title: 'This edition, in one line',
    before: () => scrollIntoView('.wn-hero-sub'),
    body: 'The subtitle names the current edition, how many items you track, and how many of them changed this month. <b>Why it helps:</b> you know at a glance whether there is anything to act on.' },
  { element: '.wn-stats', title: 'Your numbers up top',
    before: () => scrollIntoView('.wn-stats'),
    savings: '💰 The dollars on your items, totalled',
    body: 'The stat cards total the <b>savings available</b> on your items, the spend to <b>lock in before prices rise</b>, and how many <b>products you track</b>. <b>Why it helps:</b> the money is on screen before you scroll.' },
  { element: '.wn-stat.is-opp', title: 'Savings available',
    before: () => scrollIntoView('.wn-stat.is-opp'),
    savings: '💰 Capture this before the edition turns over',
    body: 'This is the opportunity total: what you could save right now across every tracked item with a live deal. <b>Why it helps:</b> one number that says how much is on the table.' },
  { element: '.wn-note', title: 'What this page covers',
    before: () => scrollIntoView('.wn-note'),
    body: 'It pulls only from the products you track: your <b>Favorites</b>, <b>Cart</b> and <b>Lists</b>, and only the ones that <b>changed this edition</b>. <b>Why it helps:</b> no noise, just your shortlist when something moves.' },
  { element: '.wn-section', title: 'Grouped by what changed',
    before: () => scrollIntoView('.wn-section'),
    body: 'Changes are split into sections: expiring rebates, limited-time deals, buy-before-a-rise, new and deeper RIPs, target-price hits, RIPs that ended, and prices easing next month. <b>Why it helps:</b> urgent things and good news are kept apart.' },
  { element: '.wn-section-head', title: 'Each section explains itself',
    before: () => scrollIntoView('.wn-section-head'),
    savings: '⏱️ Act on the red sections before they expire',
    body: 'Every section has a title, a count, and a one-line reason it matters. Risk sections (expiring, limited-time, buy-before) are the ones to clear first. <b>Why it helps:</b> you triage by colour and count, not by reading every card.' },
  { element: '.wn-card', title: 'The product card',
    before: () => scrollIntoView('.wn-card'),
    body: 'Each card shows the product, its distributor, the UPC and vendor code, the exact change, the per-case price, and a price sparkline. <b>Why it helps:</b> everything you need to decide is on the card.' },
  { element: '.wn-card-change', title: 'What actually changed',
    before: () => scrollIntoView('.wn-card-change'),
    body: 'This line spells out the change in plain terms: a rebate that appeared, deepened, or ended, a target you hit, or a price about to rise. Click the card to open the full product. <b>Why it helps:</b> no guessing why an item is here.' },
  { element: '.wn-section .wn-grid', title: 'Your biggest savings moves',
    before: () => scrollIntoView('.wn-grid'),
    savings: '💰 A ranked plan to capture the total above',
    body: 'When there are savings to capture, the page ends with a ranked plan showing how to bank the opportunity total from the top. <b>Why it helps:</b> the digest tells you what changed, then what to do about it.' },
  { element: '.wn-hero', title: 'That’s What’s New for You',
    before: () => window.scrollTo({ top: 0, behavior: 'auto' }),
    body: 'Open this whenever a new edition lands: your tracked items, what moved, and the savings, all filtered to you. <b>Why it helps:</b> the monthly catch-up takes a minute, not an hour.' },
];

export const launchWhatsNewTour = (navigate: (p: string) => void) =>
  launchScreenTour(navigate, '/whats-new', '.wn-hero', STEPS);
