import type { OrderLine } from './api';

// Shared order-line math so the Order Detail table and the All Order Lines
// view show identical figures.

export function fmt(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return '$0.00';
  return '$' + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function parseNum(v: string | number | null | undefined): number {
  if (v == null) return 0;
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return isNaN(n) ? 0 : n;
}

export function computeLineCost(line: OrderLine): number {
  return parseNum(line.case_cost) * (line.qty_cases || 0);
}

export function getBestSave(line: OrderLine): number {
  if (!line.rip_tiers || line.rip_tiers.length === 0) return 0;
  const qty = line.qty_cases || 0;
  let bestSave = 0;
  for (const tier of line.rip_tiers) {
    if (qty >= tier.tier_cases) {
      const s = parseNum(tier.save_amount);
      if (s > bestSave) bestSave = s;
    }
  }
  return bestSave;
}

export function computeLineRebate(line: OrderLine): number {
  if (line.line_rip_rebate != null) return parseNum(line.line_rip_rebate);
  return getBestSave(line) * (line.qty_cases || 0);
}

export function computeLineInvoice(line: OrderLine): number {
  if (line.line_invoice != null) return parseNum(line.line_invoice);
  return computeLineCost(line);
}

export function computeLineEffective(line: OrderLine): number {
  if (line.line_effective != null) return parseNum(line.line_effective);
  return computeLineInvoice(line) - computeLineRebate(line);
}

// Optional default markup the user sets in Configuration. When no explicit
// retail price is on a line, we derive a suggested retail = list cost/btl x
// (1 + markup) so GP% can populate. Stored client-side as a preference.
export const GP_MARKUP_KEY = 'lpb_gp_markup';

export function getMarkupPct(): number | null {
  const raw = localStorage.getItem(GP_MARKUP_KEY);
  if (raw == null || raw === '') return null;
  const v = parseFloat(raw);
  return isNaN(v) || v < 0 ? null : v;
}

export interface GpResult {
  full: number | null;   // GP% at list (full) cost
  deal: number | null;   // GP% at effective (after RIP/discount) cost
  retail: number | null; // retail/btl used
  suggested: boolean;     // true when retail came from the markup, not entered
}

/**
 * Gross-profit % from the shelf price, both ways (list vs deal cost). If the
 * line has no entered retail and a markup is provided, a suggested retail is
 * derived from list cost so GP% can still show (flagged `suggested`).
 */
export function computeGp(line: OrderLine, markupPct?: number | null): GpResult {
  const pack = line.pack || 0;
  const caseCost = parseNum(line.case_cost);
  if (pack <= 0 || caseCost <= 0) return { full: null, deal: null, retail: null, suggested: false };

  let retail = line.retail_price ?? 0;
  let suggested = false;
  if ((!retail || retail <= 0) && markupPct != null && markupPct >= 0) {
    retail = (caseCost / pack) * (1 + markupPct / 100);
    suggested = true;
  }
  if (!retail || retail <= 0) return { full: null, deal: null, retail: null, suggested: false };

  const fullCostBtl = caseCost / pack;
  const dealCostBtl = (caseCost - getBestSave(line)) / pack;
  return {
    full: ((retail - fullCostBtl) / retail) * 100,
    deal: ((retail - dealCostBtl) / retail) * 100,
    retail,
    suggested,
  };
}
