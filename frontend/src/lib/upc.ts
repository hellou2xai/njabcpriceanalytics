// A UPC that identifies ONE product and is safe to use as a fetch/join key.
// Distributor files carry shared placeholder barcodes (all-same-digit fillers,
// 999999… sentinels, repeated-digit fakes like 111111111117) that dozens of
// unrelated products sit under; fetching by one of those welds kegs and wine
// onto an unrelated card. Mirrors backend _is_clean_upc / celr.is_registry_upc.
export function isRealUpc(upc: string | null | undefined): boolean {
  const s = String(upc ?? '').trim();
  if (s === '' || s === '0') return false;
  if (/^(0+|9+|1+)$/.test(s)) return false;
  if (s.startsWith('999999')) return false;
  if (/^(\d)\1{8,}/.test(s)) return false;
  return s.replace(/^0+/, '').length >= 8;
}
