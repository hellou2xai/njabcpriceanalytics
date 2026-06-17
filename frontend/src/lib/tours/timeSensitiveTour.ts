/** Time-Sensitive Deals screen walkthrough. This page lists promotions and
 * special prices that end on a specific date and do not recur next month, so
 * most anchors (header, filter sidebar, deal cards) resolve when data is
 * present; if a card is missing on an empty page the popover centres instead. */
import { launchScreenTour, scrollIntoView, type ScreenStep } from '../screenTour';

const STEPS: ScreenStep[] = [
  { element: '.orders-header', title: 'Time-Sensitive Deals',
    body: 'Promotions and special prices that end on a specific date and do not carry over to next month. The kind of deal that is easy to miss. <b>Why it helps:</b> the deals with a clock on them, all in one place.' },
  { element: '.prod-filter-rail', title: 'Narrow it down',
    before: () => scrollIntoView('.prod-filter-rail'),
    body: 'The filter rail re-scopes the list: search by product or brand, pick a distributor, a category, a size, or just your favourites. <b>Why it helps:</b> go straight to the deals that matter to your shelf.' },
  { element: '.prod-filter-sect', title: 'Deal validity',
    before: () => scrollIntoView('.prod-filter-rail'),
    savings: '⏰ Catch deals before they expire',
    body: 'The validity pills split deals by their window: <b>Ends this week</b>, <b>Ends this month</b>, <b>Continues next month</b>, and <b>Future Deals</b> that have not started yet. <b>Why it helps:</b> sort by urgency, buy before the price is gone.' },
  { element: '.deal-cards', title: 'Each deal is a card',
    before: () => scrollIntoView('.deal-cards'),
    body: 'Every card is one dated promotion: the product, its distributor, the price now versus before, and the dollars you save per case. <b>Why it helps:</b> the full picture of a deal without opening anything.' },
  { element: '.deal-urgency', title: 'How long is left',
    before: () => scrollIntoView('.deal-card'),
    savings: '🔥 Hot deals end in 3 days or less',
    body: 'The corner badge counts down: <b>Ends today</b>, <b>Ends in N days</b>, or <b>Future deal</b> for one that has not begun. The card colour heats up as the deadline nears. <b>Why it helps:</b> see at a glance what needs action today.' },
  { element: '.deal-card-price', title: 'Price now versus before',
    before: () => scrollIntoView('.deal-card-price'),
    savings: '💰 Save per case, every case',
    body: 'The old frontline price is struck through, the deal price is bold, and the green line shows the saving per case and the percent off. <b>Why it helps:</b> the exact money the deal puts back in your pocket.' },
  { element: '.deal-card-meta', title: 'GP, RIP and closeouts',
    before: () => scrollIntoView('.deal-card-meta'),
    body: 'Tags here flag the gross profit percent, whether a <b>RIP rebate stacks</b> on top, and whether the item is a <b>Closeout</b>. <b>Why it helps:</b> spot the deals that pay twice, or that will not be reordered.' },
  { element: '.deal-card-spark', title: 'This month versus next',
    before: () => scrollIntoView('.deal-card-spark'),
    body: 'The little sparkline plots this edition against next, with the deal window dated below it. Hover for the full Frontline / Discount / RIP / Best ladder. <b>Why it helps:</b> see whether the price holds or jumps once the deal ends.' },
  { element: '.deal-card-actions', title: 'Act on a deal',
    before: () => scrollIntoView('.deal-card-actions'),
    body: 'From the card you can favourite it, add it straight to your cart, drop it on a list, or open the row menu for more. <b>Why it helps:</b> from spotting the deal to ordering it without leaving the page.' },
  { element: '.promo-toolbar', title: 'Sort and page',
    before: () => scrollIntoView('.promo-toolbar'),
    body: 'Order the list by ending soonest, biggest dollar saving, biggest percent off, or name, and set how many cards per page. <b>Why it helps:</b> lead with the deals you care about most.' },
  { element: '.ts-view-toggle', title: 'Cards or table',
    before: () => scrollIntoView('.promo-toolbar'),
    body: 'Switch between the visual card grid and a dense table you can scan column by column and export. <b>Why it helps:</b> browse visually, or work the numbers in a spreadsheet view.' },
  { element: '.orders-header', title: 'That’s Time-Sensitive Deals',
    before: () => window.scrollTo({ top: 0, behavior: 'auto' }),
    body: 'Dated deals, sorted by urgency, with the saving and the stacking RIP spelled out on every card. <b>Why it helps:</b> never miss a deal that quietly disappears next month.' },
];

export const launchTimeSensitiveTour = (navigate: (p: string) => void) =>
  launchScreenTour(navigate, '/time-sensitive', '.deal-cards', STEPS);
