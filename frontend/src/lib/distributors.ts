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

/** Proper unit-of-measure label for the pack, driven by the DB `unit_type`
 *  (keg / bottle / can / glass ...). A keg is a single vessel sold by the
 *  gallon, so it reads "keg", never "N btl/cs" (a keg has no bottles). Falls
 *  back to the volume string when unit_type is missing. Returns null when there
 *  is no usable quantity. */
export function packLabel(
  unitVolume?: string | null,
  unitQty?: string | number | null,
  unitType?: string | null,
): string | null {
  const qty = unitQty != null && unitQty !== '' ? Number(unitQty) : null;
  if (qty == null || !isFinite(qty) || qty <= 0) return null;
  const t = String(unitType ?? '').toLowerCase();
  const vol = String(unitVolume ?? '').toLowerCase();
  // Keg: a single container, not a case of bottles.
  if (/\bkeg\b|bbl|barrel/.test(t) || /\b(gal|gallon|gallons)\b/.test(vol)) {
    return qty > 1 ? `${qty} kegs` : 'keg';
  }
  // Use the real container noun from the DB so cans don't read "btl".
  const noun = /\bcan\b/.test(t) ? 'can'
    : /bottle|btl|glass|pet|plastic/.test(t) ? 'btl'
    : 'btl';
  return `${qty} ${noun}/cs`;
}

export const ALL_DISTRIBUTORS: { value: string; label: string }[] = [
  { value: '', label: 'All' },
  ...Object.entries(DISTRIBUTOR_NAMES).map(([value, label]) => ({ value, label })),
];
