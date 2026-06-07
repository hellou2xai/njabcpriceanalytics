export const DISTRIBUTOR_NAMES: Record<string, string> = {
  allied: 'Allied',
  fedway: 'Fedway',
  high_grade: 'Highgrade',
  opici: 'Opici',
  peerless: 'Peerless',
  kramer: 'Kramer',
  shore_point: 'Shore Point',
  jersey_beverage: 'Jersey Beverage',
};

export function distributorName(code: string): string {
  return DISTRIBUTOR_NAMES[code] ?? code;
}

export const ALLIED = 'allied';

// Distributors that carry their own item number (shown next to the UPC). The
// backend sets the SKU only on these distributors' own rows, so a number never
// leaks across a shared UPC.
const SKU_LABELS: Record<string, string> = { allied: 'ABG', fedway: 'Fedway' };

/** Distributor item number to show next to a UPC, only for distributors that
 *  have one (Allied, Fedway); '' otherwise. */
export function abgSku(wholesaler?: string | null, sku?: string | null): string {
  return wholesaler && sku && (wholesaler in SKU_LABELS) ? String(sku) : '';
}

/** Prefix shown before the SKU number, e.g. 'ABG' (Allied) or 'Fedway'. */
export function skuLabel(wholesaler?: string | null): string {
  return (wholesaler && SKU_LABELS[wholesaler]) || 'SKU';
}

export const ALL_DISTRIBUTORS: { value: string; label: string }[] = [
  { value: '', label: 'All' },
  ...Object.entries(DISTRIBUTOR_NAMES).map(([value, label]) => ({ value, label })),
];
