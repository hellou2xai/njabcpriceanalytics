/** Favorites (Watchlist) screen walkthrough. Row-level steps centre gracefully
 * when the watchlist is empty. */
import { launchScreenTour, scrollIntoView, type ScreenStep } from '../screenTour';

const STEPS: ScreenStep[] = [
  { element: '.tracker-header', title: 'Favorites: the products you watch',
    body: 'Star any product anywhere and it lands here, with live pricing. Set a target price and CELR tells you when the market reaches it. The Export CSV button up here saves the whole list.' },
  { element: '.filter-bar', title: 'Search and filter your list',
    before: () => scrollIntoView('.filter-bar'),
    body: 'Search within your favourites, filter by category, and set how many rows show. <b>Why it helps:</b> find the one you care about fast.' },
  { element: '.tracked-toggle', title: 'Group by category',
    body: 'Flip this to group your favourites by category (Spirits, Wine, and so on) instead of one flat list.' },
  { element: '.signal-summary-bar', title: 'Buy signals at a glance',
    before: () => scrollIntoView('.signal-summary-bar'),
    body: 'A summary of where your watched products stand right now: how many are a buy, how many to hold. <b>Why it helps:</b> see the whole list’s state in one strip.' },
  { element: '.signal-pill', title: 'What a signal means',
    before: () => scrollIntoView('.signal-pill'),
    body: 'Each signal weighs the current price against its history and your target, into a simple call. <b>Why it helps:</b> know when to act without reading every number.' },
  { element: '.tracker-table', title: 'Your tracked products',
    before: () => scrollIntoView('.tracker-table'),
    body: 'The table shows each favourite with its live case price, target, signal and quantity. <b>Why it helps:</b> everything you are watching, in one view.' },
  { element: '.inline-edit-input', title: 'Set a target price',
    before: () => scrollIntoView('.inline-edit-input'),
    body: 'Click the target cell and type the price you want to pay. CELR watches for it and alerts you. <b>Why it helps:</b> let the app wait for your price.' },
  { element: '.qty-stepper', title: 'Order straight from a favourite',
    before: () => scrollIntoView('.qty-stepper'),
    body: 'Set a quantity to add a watched product to your cart without hunting for it again.' },
  { element: '.fav-wrapper', title: 'The star: track and untrack',
    before: () => scrollIntoView('.fav-wrapper'),
    body: 'The star toggles tracking. You add favourites by clicking the star (or right-clicking, then Add to Favorites) on any product, anywhere in the app.' },
  { element: '.row-menu-btn', title: 'Quick actions on a favourite',
    before: () => scrollIntoView('.row-menu-btn'),
    body: 'The same ⋯ menu as everywhere: View, Search the web, Add to Cart/List/To-Do, Copy barcode.' },
  { element: '.tracker-header', title: 'That’s Favorites',
    before: () => window.scrollTo({ top: 0, behavior: 'auto' }),
    body: 'Track the handful of products you care about, set your price, and let CELR tell you when to move. Export the list any time with the button up here. <b>Why it helps:</b> watch less, miss nothing.' },
];

export const launchFavoritesTour = (navigate: (p: string) => void) =>
  launchScreenTour(navigate, '/watchlist', '.tracker-header', STEPS);
