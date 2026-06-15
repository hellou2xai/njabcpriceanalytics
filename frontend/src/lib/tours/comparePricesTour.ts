/** Compare Prices screen walkthrough. The page needs 2+ distributors picked to
 * render the scoreboard and grid; an early step clicks a second chip if only one
 * (or none) is selected, so the table-anchored steps resolve. If a grid anchor
 * is still missing, driver.js centres the popover so the tour still completes. */
import { launchScreenTour, scrollIntoView, sleep, type ScreenStep } from '../screenTour';

/** Make sure at least two distributors are picked so the grid renders. */
async function ensureTwoPicked() {
  const chips = Array.from(document.querySelectorAll('.cmp-chip')) as HTMLButtonElement[];
  const on = chips.filter(c => c.classList.contains('on'));
  for (let i = 0; on.length + i < 2 && i < chips.length; i++) {
    const next = chips.find(c => !c.classList.contains('on') && !c.disabled);
    if (!next) break;
    next.click();
    await sleep(120);
  }
  // give the comparison query time to populate the scoreboard/grid
  await sleep(700);
}

const STEPS: ScreenStep[] = [
  { element: '.cmp-head', title: 'Compare Prices',
    body: 'Put two or three distributors side by side on every product they both carry. List price, price after quantity discounts, and the net price after RIP rebates. <b>Why it helps:</b> see who is actually cheaper, not just who looks cheaper on the list.' },
  { element: '.cmp-picker', title: 'Pick 2–3 distributors',
    before: () => scrollIntoView('.cmp-picker'),
    body: 'Tap a chip to add a distributor to the head-to-head (the number on each chip is how many products they carry). Two or three at a time. <b>Why it helps:</b> compare the suppliers you actually buy from.' },
  { element: '.cmp-cards', title: 'The scoreboard',
    before: ensureTwoPicked,
    body: 'A quick tally: products in common, how many each distributor wins, and ties. <b>Why it helps:</b> the shape of the match-up before you read a single row.' },
  { element: '.cmp-card-save', title: 'Money left on the table',
    before: () => scrollIntoView('.cmp-card-save'),
    savings: '💰 Buy each at its cheapest — this is the total saving',
    body: 'This card adds up what you would save by buying every shared product from whichever distributor is cheapest, instead of always from the dearest. <b>Why it helps:</b> one number for the whole opportunity.' },
  { element: '.cmp-insights', title: 'Smart insights',
    before: () => scrollIntoView('.cmp-insights'),
    body: 'Plain-language lines call out the patterns: who wins most, where a deal flips the winner, the biggest single gap. <b>Why it helps:</b> the takeaways without scanning the grid yourself.' },
  { element: '.cmp-filters', title: 'Filters toolbar',
    before: () => scrollIntoView('.cmp-filters'),
    body: 'Search a product, brand or UPC, narrow to a category, and shape the comparison. The search box is smart: it handles misspellings and barcodes. <b>Why it helps:</b> get to the rows you care about fast.' },
  { element: '.cmp-min', title: 'Only meaningful gaps',
    before: () => scrollIntoView('.cmp-filters'),
    savings: '💰 Hide rounding noise — lead with real price gaps',
    body: 'Min $ spread defaults to 1, so rows where distributors differ by pennies drop out. The "Only differences" tick removes products priced identically everywhere. <b>Why it helps:</b> the grid leads with gaps worth acting on.' },
  { element: '.cmp-months', title: 'This month, last month, or both',
    before: () => scrollIntoView('.cmp-filters'),
    body: 'Switch the price columns between the current edition, the prior one, or both stacked together. <b>Why it helps:</b> see whether a distributor just moved on price.' },
  { element: '.cmp-expandall', title: 'Expand or collapse every row',
    before: () => scrollIntoView('.cmp-filters'),
    body: 'Rows open with their full deal detail by default; this button collapses them all to a clean grid, or opens them again. <b>Why it helps:</b> skim the headline prices, or dig into every ladder at once.' },
  { element: '.cmp-export', title: 'Export to Excel',
    before: () => scrollIntoView('.cmp-filters'),
    body: 'Download the current grid, with the same filters, as an .xlsx to share or work offline. <b>Why it helps:</b> take the comparison into a buying conversation.' },
  { element: '.cmp-group-head', title: 'A column group per distributor',
    before: () => scrollIntoView('.cmp-table'),
    body: 'Each distributor gets three columns: <b>List</b>, <b>Best QD</b> (after quantity discount), and <b>Best Net</b> (after the RIP rebate). A separator line divides one distributor from the next. <b>Why it helps:</b> read each supplier\'s full ladder at a glance.' },
  { element: '.cmp-spread', title: 'Spread and the suspicious check',
    before: () => scrollIntoView('.cmp-spread'),
    body: 'Spread is the dollar gap between cheapest and dearest on that row. A gap over 100% gets a <b>check</b> sticker: that is almost always a filing error (a pack-size mismatch under one barcode), not a real deal. <b>Why it helps:</b> trust the gaps, and catch the data errors.' },
  { element: '.cmp-winner', title: 'The winner, after deals',
    before: () => scrollIntoView('.cmp-winner'),
    body: 'The Winner column names whoever is cheapest once QD and RIP are applied. A "flips" tag means the list-price leader loses after deals. <b>Why it helps:</b> buy from whoever actually lands cheapest.' },
  { element: '.cmp-ladders', title: 'Open a row for the full ladder',
    before: () => scrollIntoView('.cmp-table'),
    body: 'Each expanded row shows every distributor\'s UPC and vendor item number, frontline price, the QD and RIP tiers, a plain-language readout, and a sparkline of the last few months. <b>Why it helps:</b> the complete picture behind the winner, side by side.' },
];

export const launchComparePricesTour = (navigate: (p: string) => void) =>
  launchScreenTour(navigate, '/compare-prices', '.cmp-picker', STEPS);
