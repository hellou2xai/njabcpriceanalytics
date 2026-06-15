/** Alerts screen walkthrough. The digest auto-generates on open, so the grid
 * usually has cards; if a section is empty the popover centres instead. */
import { launchScreenTour, scrollIntoView, type ScreenStep } from '../screenTour';

const STEPS: ScreenStep[] = [
  { element: '.page-header', title: 'Your Alerts',
    body: 'A short roll-up of the moves worth making this edition, grouped so you can scan it in seconds. <b>Why it helps:</b> the deals and the risks come to you.' },
  { element: '.page-sub', title: 'Built automatically',
    body: 'This digest refreshes every time you open the page, so the count of opportunities and watch-outs is always current. There is no button to press. <b>Why it helps:</b> nothing to set up, it just stays fresh.' },
  { element: '.section-label', title: 'Opportunities first',
    before: () => scrollIntoView('.section-label'),
    savings: '💰 The best buys, surfaced for you',
    body: 'The top band, <b>Opportunities</b>, gathers the moves that save money: expiring deals, RIP rebates, combo bundles, clearance, price drops, and target prices you have hit. <b>Why it helps:</b> the strongest deals sit at the top.' },
  { element: '.alert-grid', title: 'One card per category',
    before: () => scrollIntoView('.alert-grid'),
    body: 'Each card rolls up one kind of alert. The heading tells you what it is and the chip on the right names the category. <b>Why it helps:</b> related items stay together instead of one long list.' },
  { element: '.alert-card', title: 'A few items, then a count',
    before: () => scrollIntoView('.alert-card'),
    body: 'Every card lists the first few products with a short detail line, then shows <b>+N more</b> when there are extras. <b>Why it helps:</b> a quick preview without opening anything.' },
  { element: '.alert-cat-chip', title: 'Category at a glance',
    before: () => scrollIntoView('.alert-cat-chip'),
    body: 'The chip labels the card: Time-sensitive deals, RIP rebates, Clearance, Price drops, and so on. <b>Why it helps:</b> you know the kind of alert before you read it.' },
  { element: '.alert-foot-link', title: 'Open the source, already filtered',
    before: () => scrollIntoView('.alert-foot-link'),
    savings: '⏱️ From alert to action in one click',
    body: 'Click <b>View details</b> and the card takes you to the right page with its filter applied, for example RIP rebates open the RIP Products list. <b>Why it helps:</b> go straight from the tip to the products.' },
  { element: '.alert-card.unread, .alert-card', title: 'Read and unread',
    before: () => scrollIntoView('.alert-card'),
    body: 'New cards stand out as unread. Opening one marks it read so the next visit highlights only what has changed. <b>Why it helps:</b> you spot fresh alerts at a glance.' },
  { element: '.section-label:last-of-type', title: 'Watch-outs',
    before: () => scrollIntoView('.section-label:last-of-type'),
    body: 'The second band, <b>Watch-outs</b>, flags things to avoid: lost discounts, price increases, items rising next month, and draft orders worth a second look. <b>Why it helps:</b> dodge a mistake before it costs you.' },
  { element: '.btn-secondary', title: 'Clear the slate',
    before: () => window.scrollTo({ top: 0, behavior: 'auto' }),
    body: 'Read everything? <b>Mark all read</b> clears the unread highlight in one click; new alerts still appear here as the data changes. <b>Why it helps:</b> start fresh, keep watching.' },
  { element: '.page-header', title: 'That’s Alerts',
    before: () => window.scrollTo({ top: 0, behavior: 'auto' }),
    body: 'Opportunities up top, watch-outs below, each card a click from the products behind it. <b>Why it helps:</b> the next move finds you, no hunting required.' },
];

export const launchAlertsTour = (navigate: (p: string) => void) =>
  launchScreenTour(navigate, '/alerts', '.page-header', STEPS);
