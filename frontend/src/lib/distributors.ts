export const DISTRIBUTOR_NAMES: Record<string, string> = {
  allied: 'Allied',
  fedway: 'Fedway',
  high_grade: 'Highgrade',
  opici: 'Opici',
  peerless: 'Peerless',
};

export function distributorName(code: string): string {
  return DISTRIBUTOR_NAMES[code] ?? code;
}

// The app's wholesaler code for Allied Beverage Group. The ABG (Allied) SKU is
// only meaningful for Allied rows; the same UPC exists under other distributors,
// so callers MUST gate the SKU on this.
export const ALLIED = 'allied';

/** ABG SKU to show next to a UPC, but only for Allied rows; '' otherwise. */
export function abgSku(wholesaler?: string | null, sku?: string | null): string {
  return wholesaler === ALLIED && sku ? String(sku) : '';
}

export const ALL_DISTRIBUTORS: { value: string; label: string }[] = [
  { value: '', label: 'All' },
  ...Object.entries(DISTRIBUTOR_NAMES).map(([value, label]) => ({ value, label })),
];
