/**
 * Build the `months` prop for `MonthEffectiveSparkline` from any record that
 * carries the backend `price_3mo` array (last 3 EXISTING editions, each with
 * the 1-case-discount price, best-RIP price, and that edition's tier ladder).
 * Shared by the Catalog grid, the assistant comparison table, and the
 * Promotions pages so all render the same two-line 3-month sparkline + popover.
 */
import type { MonthBreakdown, RipTier } from '../components/MonthEffectiveSparkline';
import type { CatalogTier, Price3moBlock } from './api';

export interface SparkSourceItem {
  unit_qty?: number | string | null;
  unit_volume?: string | null;
  // The 3-month history the backend attaches (pricing.attach_price_3mo).
  price_3mo?: Price3moBlock[] | null;
}

function tierToRip(t: CatalogTier): RipTier {
  return {
    qty: t.qty,
    unit: t.unit,
    eff: t.price_after ?? 0,
    effBottle: t.btl_price_after ?? null,
    savePerCase: t.save_per_case ?? null,
    savePerBottle: t.save_per_bottle ?? null,
    ripOnlySave: t.rip_only_save_per_case ?? null,
    ts: !!t.is_time_sensitive,
    code: t.code ?? null,
    qualifiedCases: t.qualified_cases ?? null,
    caseCredit: t.case_credit ?? null,
    description: t.description ?? null,
    from_date: t.from_date,
    to_date: t.to_date,
    window_status: t.window_status,
    days_to_expire: t.days_to_expire,
  };
}

/** Map the backend `price_3mo` blocks (oldest->newest) into MonthBreakdown[]. */
export function buildMonths(item: SparkSourceItem): MonthBreakdown[] {
  const blocks = item.price_3mo ?? [];
  const pack = item.unit_qty != null && Number(item.unit_qty) > 0 ? Number(item.unit_qty) : null;
  const size = item.unit_volume ?? null;
  return blocks.map(b => {
    const disc = (b.tiers ?? []).filter(t => t.source === 'discount').map(tierToRip).filter(t => t.eff > 0);
    const rip = (b.tiers ?? []).filter(t => t.source === 'rip').map(tierToRip).filter(t => t.eff > 0);
    const bestDisc = disc.length ? Math.min(...disc.map(t => t.eff)) : null;
    return {
      edition: b.edition,
      frontline: b.frontline,
      frontlineUnit: b.frontline_unit_price ?? null,
      afterDiscount: bestDisc,
      discountTiers: disc,
      ripTiers: rip,
      bestEff: b.rip_price,
      disc1: b.disc1_price,
      pack,
      size,
      future: b.future ?? false,
    };
  });
}

/** Thin wrapper so `<MonthEffectiveSparkline {...buildSparkProps(item)} />` works. */
export function buildSparkProps(item: SparkSourceItem): { months: MonthBreakdown[] } {
  return { months: buildMonths(item) };
}
