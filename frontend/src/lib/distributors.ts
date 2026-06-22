export const DISTRIBUTOR_NAMES: Record<string, string> = {
  allied: 'Allied',
  fedway: 'Fedway',
  high_grade: 'Highgrade',
  opici: 'Opici',
  peerless: 'Peerless',
  kramer: 'Kramer',
  shore_point: 'Shore Point',
  jersey_beverage: 'Jersey Beverage',
  other_brothers: 'Other Brothers',
  winebow: 'Winebow',
  gallo: 'Gallo',
  regal_wine: 'Regal Wine',
  wine_enterprises: 'Wine Enterprises',
  trivin: 'Trivin',
  monsieur: 'Monsieur Touton',
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

/* ----- Unit of measure, driven by the DB `unit_type` (keg / bottle / can / ...)
   so the UI never assumes "bottle". A keg is a single vessel sold by the gallon,
   so it has no bottles and is priced per keg. Volume (GAL) is a fallback only when
   unit_type is missing. ----- */
function _isKeg(unitVolume?: string | null, unitType?: string | null): boolean {
  const t = String(unitType ?? '').toLowerCase();
  const vol = String(unitVolume ?? '').toLowerCase();
  return /\bkeg\b|bbl|barrel/.test(t) || /\b(gal|gallon|gallons)\b/.test(vol);
}

/** Singular container noun from the DB unit_type: 'keg' | 'can' | 'bottle'. */
export function containerNoun(unitVolume?: string | null, unitType?: string | null): 'keg' | 'can' | 'bottle' {
  if (_isKeg(unitVolume, unitType)) return 'keg';
  return /\bcan\b/.test(String(unitType ?? '').toLowerCase()) ? 'can' : 'bottle';
}

/** Title-cased container noun for a size heading, e.g. "Keg" / "Bottle" / "Can". */
export function containerTitle(unitVolume?: string | null, unitType?: string | null): string {
  const n = containerNoun(unitVolume, unitType);
  return n.charAt(0).toUpperCase() + n.slice(1);
}

/** Pack phrase given an already-resolved bottles/cans-per-case count. Kegs read
 *  "keg" (no per-case bottles); cases read "N bottles/case" or "N cans/case". */
export function packPhrase(packCount: number | null | undefined, unitVolume?: string | null, unitType?: string | null): string {
  if (_isKeg(unitVolume, unitType)) return packCount && packCount > 1 ? `${packCount} kegs` : 'keg';
  if (!packCount || packCount <= 0) return 'single unit';
  const noun = containerNoun(unitVolume, unitType) === 'can' ? 'cans' : 'bottles';
  return `${packCount} ${noun}/case`;
}

/** Short pack label ("keg" / "12 btl/cs" / "24 can/cs") from unit_qty directly. */
export function packLabel(
  unitVolume?: string | null,
  unitQty?: string | number | null,
  unitType?: string | null,
): string | null {
  const qty = unitQty != null && unitQty !== '' ? Number(unitQty) : null;
  if (_isKeg(unitVolume, unitType)) return qty && qty > 1 ? `${qty} kegs` : 'keg';
  if (qty == null || !isFinite(qty) || qty <= 0) return null;
  const noun = containerNoun(unitVolume, unitType) === 'can' ? 'can' : 'btl';
  return `${qty} ${noun}/cs`;
}

/** Word the CASE price is quoted in: 'keg' for kegs, else 'case'. */
export function priceUnitWord(unitVolume?: string | null, unitType?: string | null): string {
  return _isKeg(unitVolume, unitType) ? 'keg' : 'case';
}

/** Short form for the "/cs" vs "/keg" price suffix. */
export function priceUnit(unitVolume?: string | null, unitType?: string | null): string {
  return _isKeg(unitVolume, unitType) ? 'keg' : 'cs';
}

/** Per-unit noun for a $/unit price: 'keg' | 'can' | 'bottle'. */
export function perUnitNoun(unitVolume?: string | null, unitType?: string | null): string {
  return containerNoun(unitVolume, unitType);
}

/** Abbreviated per-unit suffix for "$/btl" style prices: 'btl' | 'can' | 'keg'. */
export function perUnitAbbr(unitVolume?: string | null, unitType?: string | null): string {
  const n = containerNoun(unitVolume, unitType);
  return n === 'bottle' ? 'btl' : n;
}

/** Whether this SKU is a keg (single vessel) — hide per-bottle figures for it. */
export function isKegUnit(unitVolume?: string | null, unitType?: string | null): boolean {
  return _isKeg(unitVolume, unitType);
}

export const ALL_DISTRIBUTORS: { value: string; label: string }[] = [
  { value: '', label: 'All' },
  ...Object.entries(DISTRIBUTOR_NAMES).map(([value, label]) => ({ value, label })),
];
