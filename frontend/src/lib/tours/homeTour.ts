/** Home screen walkthrough. Home is the search-first storefront you land on after
 * login: a hero search, quick category chips, rails of real products per category,
 * and your distributors. The hero always renders, so the top anchors resolve; the
 * rails and distributors load from the catalog/compare APIs. */
import { launchScreenTour, scrollIntoView, type ScreenStep } from '../screenTour';

const STEPS: ScreenStep[] = [
  { element: '.home-hero', title: 'Welcome to Celr AI',
    body: 'This is where you land after login: a search-first storefront across every distributor you can see. <b>Why it helps:</b> start from the product you need, not a menu.' },
  { element: '.home-brand', title: 'Celr AI',
    body: 'One place to find any product at any of your distributors, with live pricing from the current month’s books. <b>Why it helps:</b> the whole catalogue in one search bar.' },
  { element: '.home-search', title: 'Search anything',
    body: 'Type a product, a brand, or a distributor. It runs the smart/semantic search, so misspellings, aliases, and barcodes still land on the right product. <b>Why it helps:</b> you find it even when you don’t know the exact name.' },
  { element: '.home-search input', title: 'Type and press Enter',
    body: 'Hitting Enter or the Search button takes you to the full Products page, already filtered to your query. <b>Why it helps:</b> from a half-remembered name to the real list in one step.' },
  { element: '.home-search-go', title: 'Search button',
    body: 'Same as pressing Enter: jump to Products with your search applied. <b>Why it helps:</b> no extra clicks to get to the results.' },
  { element: '.home-browse', title: 'Browse by category',
    body: 'No search in mind? These chips drop you straight into Products filtered to Beer, Wine, Spirits, RTD, and the rest. <b>Why it helps:</b> browse a whole category in one tap.' },
  { element: '.home-chip', title: 'Category chips',
    body: 'Each chip opens the Products page pre-filtered to that category. <b>Why it helps:</b> a fast way in when you’re just looking.' },
  { element: '.home-rail', title: 'Top products from your distributors',
    before: () => scrollIntoView('.home-rail'),
    savings: '💰 Real mid-priced offers, cheapest first',
    body: 'Each rail shows real, in-stock products for a category, de-duplicated to the best-priced offer per item. <b>Why it helps:</b> see what’s actually available and what it costs, without searching.' },
  { element: '.home-card', title: 'Open any product',
    before: () => scrollIntoView('.home-card'),
    body: 'Every card shows the image, size, distributor, and case price. Click it to open the full product detail. <b>Why it helps:</b> from a thumbnail to the full pricing in one click.' },
  { element: '.home-rail-head .home-link', title: 'View all in a category',
    before: () => scrollIntoView('.home-rail-head'),
    body: 'The “View all” link opens the Products page filtered to that whole category. <b>Why it helps:</b> the rail is a taste; this is the full list.' },
  { element: '.home-dists', title: 'Your distributors',
    before: () => scrollIntoView('.home-dists'),
    body: 'A tile per distributor your account can see, with how many products each carries. Click one to browse just that supplier. <b>Why it helps:</b> scope the catalogue to who you actually buy from.' },
  { element: '.home-hero', title: 'That’s Home',
    before: () => window.scrollTo({ top: 0, behavior: 'auto' }),
    body: 'Search up top, categories and rails below, your distributors at the end. <b>Why it helps:</b> every route into the catalogue starts on this one screen.' },
];

export const launchHomeTour = (navigate: (p: string) => void) =>
  launchScreenTour(navigate, '/', '.home-hero', STEPS);
