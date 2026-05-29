/**
 * Build the `curr` + `next` MonthBreakdown props for the Catalog-style
 * MonthEffectiveSparkline from any Promotions card payload. Used by the
 * Time-Sensitive Deals, Price Drops / Increases and Major Discounts
 * pages so all four render the same popover (Frontline / Discount tiers
 * / RIP tiers / Best for both months).
 *
 * The backend's attach_promotion_tiers helper (catalog.py) already
 * attaches `tiers` + `next_tiers` arrays per card; this helper just
 * partitions them by source and produces the shape the sparkline
 * component expects. Fields the Promotions endpoints don't expose
 * (afterDiscount as a single number) are derived from the tier ladder.
 */
import type { MonthBreakdown } from '../components/MonthEffectiveSparkline';
import type { CatalogTier } from './api';

// Inputs are union-typed so all three Promotions card shapes fit, with
// optional fields for the ones that vary across pages.
export interface SparkSourceItem {
  edition?: string | null;
  // Headline figures
  frontline_case_price?: number | null;
  effective_case_price?: number | null;
  // Mover-only fields (Price Drops / Increases): list price for next month
  // and the curr/next effective price under different names.
  frontline_next_case_price?: number | null;
  case_price?: number | null;
  next_case_price?: number | null;
  next_effective_case_price?: number | null;
  // Editions for movers
  cur_edition?: string | null;
  next_edition?: string | null;
  // Mover-only: previous-edition values, used when the headline drop /
  // rise happened on the prev→cur transition rather than cur→next.
  prev_case_price?: number | null;
  frontline_prev_case_price?: number | null;
  prev_edition?: string | null;
  // Mover-only: which transition is the headline (`'cur'` = prev→cur,
  // `'next'` = cur→next). The sparkline plots THIS transition so rows
  // that qualify because of prev→cur don't appear flat.
  headline_period?: 'cur' | 'next';
  // Tier ladders
  tiers?: CatalogTier[];
  next_tiers?: CatalogTier[];
  // Time-Sensitive carries a from_date instead of an edition string
  from_date?: string | null;
}

function buildBlock(
  tiers: CatalogTier[] | undefined,
  frontline: number | null,
  bestEff: number | null,
  edition: string | null,
): MonthBreakdown {
  const disc = (tiers ?? []).filter(t => t.source === 'discount');
  const rip  = (tiers ?? []).filter(t => t.source === 'rip');
  const bestDisc = disc.length
    ? Math.min(...disc
        .map(t => t.price_after ?? Infinity)
        .filter(v => Number.isFinite(v)))
    : null;
  return {
    edition,
    frontline,
    afterDiscount: bestDisc != null && Number.isFinite(bestDisc) ? bestDisc : null,
    discountTiers: disc
      .map(t => ({ qty: t.qty, unit: t.unit, eff: t.price_after ?? 0 }))
      .filter(t => t.eff > 0),
    ripTiers: rip
      .map(t => ({ qty: t.qty, unit: t.unit, eff: t.price_after ?? 0 }))
      .filter(t => t.eff > 0),
    bestEff,
  };
}

function nextEdition(curr: string | null): string | null {
  const m = /^(\d{4})-(\d{1,2})/.exec(curr ?? '');
  if (!m) return null;
  const y = parseInt(m[1], 10), mo = parseInt(m[2], 10);
  const ny = mo === 12 ? y + 1 : y;
  const nm = mo === 12 ? 1 : mo + 1;
  return `${ny}-${String(nm).padStart(2, '0')}`;
}

export function buildSparkProps(item: SparkSourceItem):
  { curr: MonthBreakdown; next: MonthBreakdown } {
  // Mover rows can qualify on EITHER transition (prev→cur or cur→next).
  // If we always plot cur→next, rows that qualified because prev→cur
  // dropped show up as a flat line (user feedback: "products where
  // price is not changing but they are flagged as price drop"). Plot
  // the headline transition instead so the line always reflects the
  // actual movement that put the row on the page.
  const isMover = item.headline_period != null
              || item.case_price != null
              || item.next_case_price != null;

  if (isMover && item.headline_period === 'cur') {
    // prev → cur is the headline. Use prev_* as the LEFT dot and the
    // mover's "current" values (case_price / cur_edition) as the RIGHT
    // dot. Tier ladders aren't computed for the prev edition, so the
    // popover's left column shows only Frontline / Best for prev.
    const leftEd  = item.prev_edition ?? null;
    const rightEd = item.cur_edition ?? item.edition ?? null;
    return {
      curr: buildBlock(undefined, item.frontline_prev_case_price ?? null,
                       item.prev_case_price ?? null, leftEd),
      next: buildBlock(item.tiers,
                       item.frontline_case_price ?? null,
                       item.case_price ?? null, rightEd),
    };
  }

  // Default: cur → next. Movers (headline 'next') and the
  // non-mover Time-Sensitive / Major Discounts shapes both land here.
  const currEd = item.cur_edition
    ?? item.edition
    ?? (item.from_date ? item.from_date.slice(0, 7) : null)
    ?? null;
  const nextEd = item.next_edition ?? nextEdition(currEd);

  const currFront = item.frontline_case_price ?? null;
  const currBest  = isMover
    ? (item.case_price ?? null)
    : (item.effective_case_price ?? null);
  const nextFront = item.frontline_next_case_price ?? null;
  const nextBest  = isMover
    ? (item.next_case_price ?? null)
    : (item.next_effective_case_price ?? null);

  return {
    curr: buildBlock(item.tiers, currFront, currBest, currEd),
    next: buildBlock(item.next_tiers, nextFront, nextBest, nextEd),
  };
}
