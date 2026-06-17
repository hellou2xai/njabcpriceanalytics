/** Price Drops screen walkthrough. This page (PriceMovers with direction="down")
 * lists products whose effective case price FELL between the two most recent
 * editions loaded; bigger drops first. Anchors come from the real markup:
 * the compare banner, the filter sidebar, the toolbar, and the deal cards. */
import { launchScreenTour, scrollIntoView, type ScreenStep } from '../screenTour';

const STEPS: ScreenStep[] = [
  { element: '.orders-header', title: 'Price Drops',
    body: 'Every product whose <b>effective case price went down</b> between the two most recent editions loaded. The biggest drops sit at the top. <b>Why it helps:</b> the prices that just got cheaper, in one list.' },
  { element: '.pm-compare-banner', title: 'Which two months',
    before: () => scrollIntoView('.pm-compare-banner'),
    body: 'This banner spells out the exact editions being compared, e.g. <b>May 2026 → Jun 2026</b>. The page always lines up the two most recent months of prices in the system. <b>Why it helps:</b> no guessing what "dropped" is measured against.' },
  { element: '.prod-filter-rail', title: 'Narrow the list',
    before: () => scrollIntoView('.prod-filter-rail'),
    body: 'Filter by distributor, category, size, or whether a RIP rebate stacks on top. <b>Why it helps:</b> jump straight to the drops on products you actually buy.' },
  { element: '.prod-filter-sect', title: 'Set a minimum drop',
    before: () => scrollIntoView('.prod-filter-sect'),
    savings: '💰 Hide the rounding noise, keep the real cuts',
    body: 'Use <b>Min drop %</b> and <b>Min change / case</b> to drop out the tiny moves and keep only the meaningful cuts. <b>Why it helps:</b> a $40-a-case drop is worth your time; a 30c one usually is not.' },
  { element: '.promo-toolbar', title: 'Sort and switch views',
    before: () => scrollIntoView('.promo-toolbar'),
    body: 'Sort by biggest % drop, biggest $ change, or name, and flip between cards and a dense table. <b>Why it helps:</b> rank the list the way you think about value.' },
  { element: '.deal-card', title: 'One product, one card',
    before: () => scrollIntoView('.deal-card'),
    body: 'Each card carries the product, its distributor, and a green <b>Price drop</b> tag for the months the change is live in. <b>Why it helps:</b> the full story of one drop at a glance.' },
  { element: '.deal-card-price', title: 'Was, now, and how much',
    before: () => scrollIntoView('.deal-card-price'),
    savings: '💰 See the per-case dollars you save',
    body: 'The price line shows the old case price, the new one in green, and the saving as both <b>dollars per case</b> and a percentage. <b>Why it helps:</b> the size of the cut in plain numbers.' },
  { element: '.deal-btl-now', title: 'Net price per bottle',
    before: () => scrollIntoView('.deal-btl-now'),
    body: 'For multi-bottle cases the card breaks the net price down <b>per bottle</b>, after every deal. <b>Why it helps:</b> compare against your shelf price without doing the math.' },
  { element: '.deal-card-spark', title: 'The price trend',
    before: () => scrollIntoView('.deal-card-spark'),
    body: 'The sparkline plots the effective price across recent editions; hover it for the full discount, RIP, and best-price breakdown. <b>Why it helps:</b> tells a real drop from a price that just bounced back.' },
  { element: '.deal-card-actions', title: 'Act on a drop',
    before: () => scrollIntoView('.deal-card-actions'),
    body: 'Favourite the product, add the case to your cart, or drop it on a list straight from the card. <b>Why it helps:</b> turn a price cut into an order without leaving the page.' },
  { element: '.orders-header', title: "That's Price Drops",
    before: () => window.scrollTo({ top: 0, behavior: 'auto' }),
    body: 'Find what got cheaper, screen out the noise, then buy. <b>Why it helps:</b> the month’s downward price moves, ready to act on.' },
];

export const launchPriceDropsTour = (navigate: (p: string) => void) =>
  launchScreenTour(navigate, '/price-drops', '.pm-compare-banner', STEPS);
