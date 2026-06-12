// RIP PROGRAMS per order line. One UPC can sit under several RIP rebates (a
// brand-mix RIP and a standalone product RIP, e.g. Buehler Cab: mix 100567
// pays $15 at 2cs while standalone 100714 pays $60 at the same 2cs). Programs
// do NOT stack — the buyer picks one. These helpers group a line's
// server-attached tiers by RIP code so Cart and Lists can show the choice,
// store it (rip_choice), and suggest the better-paying program.
import type { CatalogTier } from './api';

export interface RipProgramTier {
  qty: number;          // QUALIFYING quantity printed on the RIP sheet (case credits)
  physQty: number;      // REAL physical buy-in for THIS SKU (half-case rule applied)
  unit: 'case' | 'btl';
  amt: number;
}
export interface RipProgram {
  code: string | null;
  description: string | null;
  // Case-credit rate of THIS SKU under the program (FOUNDATION 3.4.1):
  // 1 physical case earns `credit` toward the case tiers. 1.0 unless a
  // half/quarter-case rule matched ("375ML 12PK = 1/2 CASE").
  credit: number;
  tiers: RipProgramTier[];
}

// Normalise a tier unit label ("Case(s)" -> "case", "Btl"/"Bottle" -> "btl").
export function normTierUnit(u?: string | null): 'case' | 'btl' {
  const s = String(u ?? '').toLowerCase().trim();
  if (s === 'b' || s.startsWith('btl') || s.startsWith('bottle')) return 'btl';
  return 'case';
}

export function ripPrograms(tiers?: CatalogTier[] | null): RipProgram[] {
  const out: RipProgram[] = [];
  for (const t of tiers ?? []) {
    if (t.source !== 'rip') continue;
    const code = String(t.code ?? '').trim() || null;
    let g = out.find(x => x.code === code);
    if (!g) { g = { code, description: t.description ?? null, credit: 1, tiers: [] }; out.push(g); }
    if (!g.description && t.description) g.description = t.description;
    const u = normTierUnit(t.unit);
    const credit = u === 'case' ? (t.case_credit ?? 1) || 1 : 1;
    if (credit !== 1) g.credit = credit;
    const phys = u === 'case' ? (t.qualified_cases ?? t.qty) : t.qty;
    const prev = g.tiers.find(x => x.qty === t.qty && x.unit === u);
    if (prev) { if (t.amount > prev.amt) prev.amt = t.amount; }
    else g.tiers.push({ qty: t.qty, physQty: phys, unit: u, amt: t.amount });
  }
  for (const g of out) g.tiers.sort((a, b) => a.qty - b.qty);
  return out;
}

/** The program this line currently runs under: the buyer's stored choice when
 *  it still exists this edition, else the CPL row's own code, else the first
 *  program. */
export function effectiveRipCode(
  line: { rip_choice?: string | null; rip_code?: string | null },
  programs: RipProgram[],
): string | null {
  const choice = String(line.rip_choice ?? '').trim();
  if (choice && programs.some(p => p.code === choice)) return choice;
  const def = String(line.rip_code ?? '').trim();
  if (def && programs.some(p => p.code === def)) return def;
  return programs[0]?.code ?? null;
}

export function fmtAmt(v: number): string {
  return v % 1 === 0 ? `$${v.toFixed(0)}` : `$${v.toFixed(2)}`;
}

/** "4cs $40 · 12cs $180" — REAL physical buy-ins (half-case rule applied),
 *  the same convention the deal ladder uses. */
export function programSummary(p: RipProgram): string {
  return p.tiers.map(t => `${t.physQty}${t.unit === 'case' ? 'cs' : 'btl'} ${fmtAmt(t.amt)}`).join(' · ');
}

/** Rebate the program pays at `physQty` PHYSICAL cases/bottles of this SKU
 *  (0 when below the entry tier). Case tiers compare in credits. */
export function programPayAt(p: RipProgram, physQty: number): number {
  let best = 0;
  for (const t of p.tiers) {
    const have = t.unit === 'case' ? physQty * p.credit : physQty;
    if (t.qty <= have) best = Math.max(best, t.amt);
  }
  return best;
}

/** A different program that pays MORE than the current one at a comparable
 *  PHYSICAL commitment (the candidate's entry buy-in, or the current quantity
 *  once past it). Returns the suggestion or null. */
export function betterProgram(
  programs: RipProgram[],
  effCode: string | null,
  haveQty: number,
): { program: RipProgram; atQty: number; pays: number; currentPays: number } | null {
  const cur = programs.find(p => p.code === effCode);
  if (!cur || programs.length < 2) return null;
  let best: { program: RipProgram; atQty: number; pays: number; currentPays: number } | null = null;
  for (const p of programs) {
    if (p.code === effCode || !p.tiers.length) continue;
    const atQty = Math.max(p.tiers[0].physQty, haveQty);
    const pays = programPayAt(p, atQty);
    const currentPays = programPayAt(cur, atQty);
    if (pays > currentPays + 0.005 && (!best || pays - currentPays > best.pays - best.currentPays)) {
      best = { program: p, atQty, pays, currentPays };
    }
  }
  return best;
}

/** "half" / "quarter" / "0.4" — for the qualifier note on a line. */
export function creditWord(credit: number): string {
  if (credit === 0.5) return 'half';
  if (credit === 0.25) return 'quarter';
  return String(credit);
}
