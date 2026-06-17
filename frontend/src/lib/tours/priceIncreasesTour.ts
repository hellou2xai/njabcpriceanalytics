/** Price Increases screen walkthrough. Frames the page as a watch-out: products
 * whose effective case price ROSE between the two most recent editions, so you
 * can buy before it climbs further or re-evaluate the line. Anchors use the real
 * PriceMovers.tsx class names; if a conditional row is missing (empty list) the
 * popover falls back to centred. */
import { launchScreenTour, scrollIntoView, type ScreenStep } from '../screenTour';

const STEPS: ScreenStep[] = [
  { element: '.orders-header', title: 'Price Increases',
    body: 'Every product whose <b>effective</b> case price went up between the two most recent editions loaded. The biggest rises sit at the top. <b>Why it helps:</b> spot what is getting more expensive before it costs you.' },
  { element: '.pm-compare-banner', title: 'Which two months',
    before: () => scrollIntoView('.pm-compare-banner'),
    body: 'This banner spells out exactly which two editions are being compared, so a "rise" is never a mystery. <b>Why it helps:</b> you know the increase is real, not a stale comparison.' },
  { element: '.prod-filter-rail', title: 'Narrow the watch-list',
    before: () => scrollIntoView('.prod-filter-rail'),
    body: 'Filter by distributor, category, size, or a minimum rise so only the increases that matter to you show. <b>Why it helps:</b> cut a long list down to the lines you actually buy.' },
  { element: '.prod-filter-rail', title: 'Set a minimum rise',
    before: () => scrollIntoView('.prod-filter-rail'),
    savings: '⚠️ Surface only the increases worth acting on',
    body: 'Use <b>Min rise %</b> and <b>Min change / case</b> to hide tiny moves and keep the painful ones. <b>Why it helps:</b> focus on the increases big enough to change a buying decision.' },
  { element: '.prod-filter-rail', title: 'Increases that hide behind RIP',
    before: () => scrollIntoView('.prod-filter-rail'),
    body: 'The <b>Has RIP rebate</b> filter flags lines where a rebate is offsetting a list-price jump. <b>Why it helps:</b> see when a rebate is the only thing holding the price down.' },
  { element: '.promo-toolbar', title: 'Sort and switch views',
    before: () => scrollIntoView('.promo-toolbar'),
    body: 'Sort by biggest % rise or biggest dollar change, set how many show, and flip between cards and a dense table. <b>Why it helps:</b> read the increases the way that suits you.' },
  { element: '.mover-card', title: 'A single increase, explained',
    before: () => scrollIntoView('.mover-card'),
    savings: '⚠️ Buy before it climbs again',
    body: 'Each card shows the old price, the new price, and the <b>+$ / +%</b> jump for the two months being compared. <b>Why it helps:</b> the size of the increase in one glance.' },
  { element: '.deal-card-listline', title: 'When RIP absorbs the spike',
    before: () => scrollIntoView('.deal-card-listline'),
    body: 'If a card carries a <b>List:</b> line, the wholesale list price spiked but the rebate is absorbing most of it. <b>Why it helps:</b> know the increase is one rebate away from hitting you.' },
  { element: '.deal-card-spark', title: 'See the trend',
    before: () => scrollIntoView('.deal-card-spark'),
    body: 'The sparkline plots the effective price across recent months, so a rise reads as a trend rather than a one-off. <b>Why it helps:</b> tell a steady climb apart from a single bump.' },
  { element: '.deal-card-actions', title: 'Act on it',
    before: () => scrollIntoView('.deal-card-actions'),
    body: 'Favourite the line to track it, add a stock-up order while the price is lower, or save it to a list to re-evaluate. <b>Why it helps:</b> turn a warning into a buy-ahead before the next rise.' },
  { element: '.orders-header', title: 'That’s Price Increases',
    before: () => window.scrollTo({ top: 0, behavior: 'auto' }),
    body: 'A running watch-out for every line getting more expensive, with the trend and the actions to get ahead of it. <b>Why it helps:</b> never get surprised by a price climb again.' },
];

export const launchPriceIncreasesTour = (navigate: (p: string) => void) =>
  launchScreenTour(navigate, '/price-increases', '.pm-compare-banner', STEPS);
