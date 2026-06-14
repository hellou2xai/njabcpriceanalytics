/**
 * New Items — the full Products experience (semantic search, filter rail, facet
 * counts, grouping, price sparklines, cart) scoped to SKUs first introduced in
 * the last 3 editions. Each item card/size carries a "New · <month>" sticker
 * showing when it was introduced. All the heavy lifting lives in <Products>; the
 * `newItems` flag forces the new-items universe (introduced_within_months=3) and
 * the introduced stickers.
 */
import Products from './Products';

export default function NewItems() {
  return <Products newItems />;
}
