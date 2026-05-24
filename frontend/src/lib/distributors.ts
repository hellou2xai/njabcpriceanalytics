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

export const ALL_DISTRIBUTORS: { value: string; label: string }[] = [
  { value: '', label: 'All' },
  ...Object.entries(DISTRIBUTOR_NAMES).map(([value, label]) => ({ value, label })),
];
