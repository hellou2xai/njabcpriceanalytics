/** Compare RIPs screen walkthrough. A RIP is a buy-more-save-more discount, and
 * the same bottle can RIP very differently at each distributor. This tour walks
 * the left filter rail, the summary scoreboard, and one product card top to
 * bottom so a buyer learns to read the verdict and the per-distributor panels. */
import { launchScreenTour, scrollIntoView, type ScreenStep } from '../screenTour';

const STEPS: ScreenStep[] = [
  { element: '.rip2-top', title: 'Compare RIPs',
    body: 'A RIP is a buy-more-save-more rebate. The same bottle can RIP very differently at each distributor. This screen shows who actually costs less at the volume you plan to buy. <b>Why it helps:</b> stop guessing which supplier is cheaper on a deal.' },
  { element: '.rip2-rail-head', title: 'Your filters live here',
    before: () => scrollIntoView('.rip2-rail-head'),
    body: 'The left rail scopes the whole comparison. Hide it with the X to widen the cards, reopen it with the Filters button. <b>Why it helps:</b> one place to set what you are comparing.' },
  { element: '.rip2-chips', title: 'Pick 2 or 3 distributors',
    before: () => scrollIntoView('.rip2-chips'),
    body: 'Choose the distributors you want side by side. The comparison only runs once two are selected, and you can compare up to three. <b>Why it helps:</b> compare the suppliers you actually buy from.' },
  { element: '.rip2-vol', title: 'How many cases will you buy?',
    before: () => scrollIntoView('.rip2-vol'),
    savings: '💰 The winner can flip with volume',
    body: 'Drag the slider to the order size you have in mind. Every price, verdict and "winner" on the page is judged at this exact case count. <b>Why it helps:</b> a deal that wins at 1 case can lose at 20, so set your real volume.' },
  { element: '.rip2-rail-sect:nth-of-type(3)', title: 'Search and category',
    before: () => scrollIntoView('.rip2-rail-sect:nth-of-type(3)'),
    body: 'Find a product by name, brand or barcode using smart search, then narrow by category or brand. <b>Why it helps:</b> jump straight to the item you are sourcing.' },
  { element: '.rip2-mindiff', title: 'Minimum price gap',
    before: () => scrollIntoView('.rip2-mindiff'),
    body: 'Only show products where the cheapest distributor beats the rest by at least this much per case. Set it to $0 to see every shared match. <b>Why it helps:</b> filter out ties and focus on gaps worth acting on.' },
  { element: '.rip2-rail-sect:nth-last-of-type(2)', title: 'Compare beyond price',
    before: () => scrollIntoView('.rip2-rail-sect:nth-last-of-type(2)'),
    body: 'These switches surface non-price differences: RIP timing differs, unlock quantity differs, same price but better RIP terms, and possible data issues. <b>Why it helps:</b> two suppliers at the same price are not always the same deal.' },
  { element: '.rip2-cards', title: 'The scoreboard',
    before: () => scrollIntoView('.rip2-cards'),
    body: 'Up top: how many products all of them RIP on, who wins on price at your chosen volume, and how many flip winner as you buy more. <b>Why it helps:</b> the shape of the whole comparison in one row.' },
  { element: '.rip2-product-head', title: 'A product card',
    before: () => scrollIntoView('.rip2-product-head'),
    body: 'Each card is one product matched by exact barcode and pack size. The header carries the name, size, vintage, and flags like "winner changes with volume" or "½ Case RIP". <b>Why it helps:</b> a true like-for-like row, not a name match.' },
  { element: '.rip2-verdict-banner', title: 'The verdict',
    before: () => scrollIntoView('.rip2-verdict-banner'),
    savings: '💰 See the total you save before you buy',
    body: 'The banner names the lowest-price distributor at your case count and the dollars you save in total versus the next-cheapest. <b>Why it helps:</b> the answer, in money, without reading the panels.' },
  { element: '.rip2-dist-price', title: 'What a case actually costs',
    before: () => scrollIntoView('.rip2-dist-price'),
    body: 'Each distributor panel shows pack × size, barcode, the price sparkline, then the landed price per case and per bottle at your volume. <b>Why it helps:</b> compare the real out-the-door cost, not the sticker price.' },
  { element: '.rip2-dist-breakdown', title: 'List → QD → RIP',
    before: () => scrollIntoView('.rip2-dist-breakdown'),
    body: 'The breakdown line walks from the list price, down through the quantity discount, then the RIP rebate on top, reconciling to what you pay. <b>Why it helps:</b> see exactly where each dollar of saving comes from.' },
  { element: '.rip2-metrics', title: 'The RIP terms at a glance',
    before: () => scrollIntoView('.rip2-metrics'),
    body: 'Plain-language metrics: the just-1-case price, where the RIP starts, the deepest rebate per case, how many days it runs, mix-to-qualify, and the RIP code (click it to see every product in the deal). <b>Why it helps:</b> the full terms without decoding a price book.' },
  { element: '.rip2-product-head', title: 'Open a card for the full picture',
    before: () => scrollIntoView('.rip2-product-head'),
    body: 'Click any card to expand a landed-cost curve and the full tier ladders, so you can see who wins at every order size, not just yours. <b>Why it helps:</b> plan the buy that gives you the lowest price overall.' },
];

export const launchCompareRipsTour = (navigate: (p: string) => void) =>
  launchScreenTour(navigate, '/compare-rips', '.rip2-top', STEPS);
