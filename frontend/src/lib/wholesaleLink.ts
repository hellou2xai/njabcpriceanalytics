/**
 * Wholesale availability deep-links (open-only).
 *
 * Builds a search URL into a distributor's own ordering portal, prefilled with
 * the item. The merchant is logged into that portal under THEIR OWN credentials
 * and reads stock there visually — CELR never handles distributor credentials
 * and never reads anything back. Covered distributors: Allied and Fedway only.
 *
 * Search term, in priority order: the distributor item number when CELR has it
 * mapped (precise, single result), otherwise the CELR item name as a keyword
 * fallback. Item numbers are kept as strings so source formatting (leading
 * zeros, e.g. "0449840") is preserved — Allied's search tolerates dropped
 * leading zeros, but we keep them for auditability against the CPL filings.
 */
export type WholesaleDistributor = 'allied' | 'fedway';

export const WHOLESALE_DISTRIBUTORS: readonly WholesaleDistributor[] = ['allied', 'fedway'];

export function isWholesaleDistributor(w?: string | null): w is WholesaleDistributor {
  return w === 'allied' || w === 'fedway';
}

// Confirmed-working portal search URL formats.
//  - Fedway (IBM WebSphere Commerce): term in the query string `searchTerm`.
//  - Allied (Salesforce Experience Cloud + Coveo): term in the URL fragment
//    `q`, with numberOfResults=100; numeric match tolerates leading zeros.
export const PORTAL_SEARCH: Record<WholesaleDistributor, (term: string) => string> = {
  fedway: (term) =>
    `https://www.fedway.com/wcs/shop/en/fedwaystore/SearchDisplay?searchTerm=${encodeURIComponent(String(term).trim())}`,
  allied: (term) =>
    `https://allin.alliedbeverage.com/s/global-search/@uri#q=${encodeURIComponent(String(term).trim())}&numberOfResults=100`,
};

/** The search term for an item at its OWN distributor: the mapped item number
 *  if present, else the item name as a keyword fallback, else null. */
export function searchTermFor(itemNumber?: string | null, name?: string | null): string | null {
  if (itemNumber != null && String(itemNumber).trim() !== '') return String(itemNumber).trim();
  if (name && name.trim() !== '') return name.trim();
  return null;
}

/** The portal URL for a covered distributor, or null when there's nothing to
 *  search (no item number and no name). */
export function availabilityUrl(
  distributor: WholesaleDistributor,
  itemNumber?: string | null,
  name?: string | null,
): string | null {
  const term = searchTermFor(itemNumber, name);
  return term ? PORTAL_SEARCH[distributor](term) : null;
}

/** Open the distributor portal search in a new tab (noopener), prefilled. */
export function openAvailability(
  distributor: WholesaleDistributor,
  itemNumber?: string | null,
  name?: string | null,
): void {
  const url = availabilityUrl(distributor, itemNumber, name);
  if (url) window.open(url, '_blank', 'noopener');
}
