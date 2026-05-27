/** Dashboard screen walkthrough. The Dashboard always has data, so most anchors
 * resolve; specific opportunity tiles are described on a tile step. */
import { launchScreenTour, scrollIntoView, type ScreenStep } from '../screenTour';

const STEPS: ScreenStep[] = [
  { element: '.smart-header', title: 'Your Dashboard',
    body: 'The home screen: the month’s price book in numbers, your own workspace, and the opportunities CELR has found for you. <b>Why it helps:</b> your day starts here.' },
  { element: '.filter-pills', title: 'Focus on one distributor',
    before: () => scrollIntoView('.filter-pills'),
    body: 'These chips re-scope the whole dashboard to one distributor, or all of them. <b>Why it helps:</b> see the picture for just the supplier you are working with.' },
  { element: '.section-label', title: 'Three sections',
    before: () => scrollIntoView('.section-label'),
    body: 'The dashboard runs in three bands: <b>Key Metrics</b>, <b>My Workspace</b>, and <b>Insights & Opportunities</b>. <b>Why it helps:</b> numbers, your work, then the deals.' },
  { element: '.kpi-grid', title: 'The month at a glance',
    before: () => scrollIntoView('.kpi-grid'),
    body: 'These cards summarise this edition: total items, active discounts, clearance, price moves, and active rebates. <b>Why it helps:</b> the shape of the month in one look.' },
  { element: '.kpi-card', title: 'Every card is a shortcut',
    before: () => scrollIntoView('.kpi-card'),
    body: 'Click a card to jump straight to that list, already filtered. Card two also shows the total <b>savings pool</b> on the table. <b>Why it helps:</b> from a number to the products behind it in one click.' },
  { element: '.dashboard-tile-grid', title: 'Your workspace',
    before: () => scrollIntoView('.dashboard-tile-grid'),
    body: 'Compact tiles for your own activity: favourites, recent orders, notes. <b>Why it helps:</b> pick up where you left off.' },
  { element: '.dashboard-tile', title: 'Tiles expand for detail',
    before: () => scrollIntoView('.dashboard-tile'),
    body: 'Each tile shows a quick preview; click it to open the full detail in a pop-up without leaving the page. <b>Why it helps:</b> a glance now, the detail when you want it.' },
  { element: '.dashboard-tile', title: 'Time-sensitive deals',
    before: () => scrollIntoView('.dashboard-tile'),
    body: 'In Insights, the <b>Time-Sensitive Deals</b> tile surfaces offers that expire soon or whose price is not available next month. <b>Why it helps:</b> act before they are gone.' },
  { element: '.dashboard-tile', title: 'Biggest price drops and top discounts',
    body: 'Other tiles rank the <b>biggest price drops</b> and the <b>top discounts</b> this edition. <b>Why it helps:</b> the strongest deals come to you.' },
  { element: '.dashboard-tile', title: 'Who is cheaper',
    body: 'Cross-distributor tiles flag where one supplier beats another on the same product. <b>Why it helps:</b> buy from whoever is cheapest, automatically spotted.' },
  { element: '.smart-header', title: 'It updates with the data',
    before: () => window.scrollTo({ top: 0, behavior: 'auto' }),
    body: 'Every number and tile reflects the current edition and your distributor filter. <b>Why it helps:</b> the dashboard is always current, never stale.' },
  { element: '.kpi-grid', title: 'That’s the Dashboard',
    before: () => scrollIntoView('.kpi-grid'),
    body: 'Numbers up top, your work in the middle, the best deals below. <b>Why it helps:</b> the whole month, and your next move, on one screen.' },
];

export const launchDashboardTour = (navigate: (p: string) => void) =>
  launchScreenTour(navigate, '/', '.kpi-grid', STEPS);
