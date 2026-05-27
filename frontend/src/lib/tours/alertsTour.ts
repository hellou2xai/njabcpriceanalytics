/** Alerts screen walkthrough. Card-level steps centre gracefully when there are
 * no alerts. */
import { launchScreenTour, scrollIntoView, type ScreenStep } from '../screenTour';

const STEPS: ScreenStep[] = [
  { element: '.page-header', title: 'Alerts: your daily digest',
    body: 'A short, grouped digest of what changed and what to do about it, refreshed for you automatically. <b>Why it helps:</b> the important moves, without scanning every screen.' },
  { element: '.page-sub', title: 'Opportunities and watch-outs',
    body: 'The summary counts two kinds: <b>opportunities</b> worth chasing and <b>watch-outs</b> to avoid a mistake. <b>Why it helps:</b> know the balance at a glance.' },
  { element: '.page-header', title: 'Clear them in one go',
    body: 'The <b>Mark all read</b> button clears the unread state once you have scanned them. <b>Why it helps:</b> start fresh tomorrow.' },
  { element: '.section-label', title: 'Opportunities first',
    before: () => scrollIntoView('.section-label'),
    body: 'The first band is <b>Opportunities</b>: deals expiring, rebates worth taking, prices that just dropped. <b>Why it helps:</b> the upside, up front.' },
  { element: '.alert-grid', title: 'Grouped, not a firehose',
    before: () => scrollIntoView('.alert-grid'),
    body: 'Alerts are rolled up into a handful of cards by theme, instead of one row per product. <b>Why it helps:</b> a digest you can read in a minute.' },
  { element: '.alert-card', title: 'An alert card',
    before: () => scrollIntoView('.alert-card'),
    body: 'Each card is one theme, with the products it covers underneath. Click the card to jump to the full list behind it. <b>Why it helps:</b> from the headline to the detail in one click.' },
  { element: '.alert-cat-chip', title: 'What kind of alert',
    before: () => scrollIntoView('.alert-cat-chip'),
    body: 'A chip names the category, like time-sensitive deals or RIP rebates. <b>Why it helps:</b> know what you are looking at instantly.' },
  { element: '.alert-items', title: 'The products inside',
    before: () => scrollIntoView('.alert-items'),
    body: 'Each card lists the products it is about, with the key detail. <b>Why it helps:</b> see exactly what triggered the alert.' },
  { element: '.alert-card', title: 'Read vs unread',
    body: 'Unread alerts stand out; opening or marking one settles it. <b>Why it helps:</b> only what is new draws your eye.' },
  { element: '.section-label', title: 'Then the watch-outs',
    before: () => scrollIntoView('.section-label'),
    body: 'The second band is <b>Watch-outs</b>: price increases and deals ending, so you avoid an expensive surprise. <b>Why it helps:</b> the downside, flagged early.' },
  { element: '.page-header', title: 'Generated for you',
    before: () => window.scrollTo({ top: 0, behavior: 'auto' }),
    body: 'There is no button to press: alerts regenerate automatically from the latest data each time you open this page (and nightly). <b>Why it helps:</b> the digest is always ready.' },
  { element: '.alert-grid', title: 'That’s Alerts',
    before: () => scrollIntoView('.alert-grid'),
    body: 'Opportunities and watch-outs, grouped, scannable, and one click from the detail. <b>Why it helps:</b> stay on top of the market in a minute a day.' },
];

export const launchAlertsTour = (navigate: (p: string) => void) =>
  launchScreenTour(navigate, '/alerts', '.page-header', STEPS);
