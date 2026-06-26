/**
 * RipQdPanels — the ONE shared "RIP details + QD prices chart" layout.
 *
 * Used wherever a product's QD / RIP tiers are shown (product detail page,
 * Products list expanded rows, Quick View) so every surface renders the SAME
 * two panels and users get a uniform read:
 *
 *   RIP details   — one row per program per month: Dates | Sizes | Levels,
 *                   where Sizes is the RIP-sheet free text (rip_description,
 *                   column M) and Levels are qualifying cases : total rebate $.
 *   Prices chart  — per month: Type | Price by case | Price by bottle, rows =
 *                   1 Bottle + 1 Case + every quantity-discount bracket.
 *
 * Driven from the SAME buildMonths(price_3mo) series the sparkline/ladder use,
 * so the numbers can never disagree with the rest of the app.
 */
import { useMemo } from 'react';
import { buildMonths } from '../lib/promotionsSparkline';
import { currentMonth, type MonthBreakdown, type RipTier } from './MonthEffectiveSparkline';
import { fmtDateRange } from '../lib/dealDates';
import { bottlesPerCase, sizeToMl } from '../lib/productSizes';
import { priceUnitWord, perUnitNoun } from '../lib/distributors';
import type { Product } from '../lib/api';

// ---- shared formatting / math (exported for the summary card etc.) ----
export const money = (v: number | null | undefined) =>
  v == null ? null : `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const moneyRound = (v: number | null | undefined) =>
  v == null ? null : `$${Math.round(v).toLocaleString()}`;
export function ozPerBottle(uv?: string | null): number | null {
  const ml = sizeToMl(uv);
  return ml === Number.MAX_SAFE_INTEGER ? null : ml / 29.5735;
}

// Any unit starting with 'b' is a bottle (Fedway abbreviates bottles "B").
const isBottleUnit = (unit?: string | null) => /^\s*b/i.test(String(unit ?? ''));
// Case-equivalent quantity for a tier: a bottle-unit tier divided by the pack.
function caseQty(t: RipTier, pack: number | null): number {
  return isBottleUnit(t.unit) && pack && pack > 0 ? t.qty / pack : t.qty;
}
// Real physical buy-in in cases (honours the half-case qualifying quantity).
function buyCases(t: RipTier, pack: number | null): number {
  if (isBottleUnit(t.unit) && pack && pack > 0) return t.qty / pack;
  if (t.qualifiedCases != null && t.qualifiedCases !== t.qty) return t.qualifiedCases;
  return t.qty;
}
function fmtCs(n: number): string {
  const r = Math.round(n * 100) / 100;
  return String(r);
}
// Case price after the 1-case (entry) quantity discount for a month block — the
// headline "what you pay for one case", no RIP. disc1 is the precomputed
// after-1cs price; fall back to the frontline list price.
export function afterOneCase(b: MonthBreakdown | null): number | null {
  if (!b) return null;
  return b.disc1 ?? b.frontline ?? null;
}

// Time-sensitive sticker — shown on EVERY RIP or QD line whose deal is valid
// only on partial dates (not the whole month), so a limited-window deal is
// never mistaken for the dependable monthly price.
const TsSticker = () => (
  <span className="pdx-ts" title="Time-sensitive: valid only on the dates shown, not the whole month.">TS</span>
);

// ───────────────────────── RIP details panel ─────────────────────────
interface RipLevel { cases: number; per: number; total: number; }
function ripLevels(tiers: RipTier[], pack: number | null): RipLevel[] {
  const m = new Map<number, RipLevel>();
  for (const t of tiers) {
    const per = t.ripOnlySave ?? 0;
    if (per <= 0.005) continue;
    const cases = buyCases(t, pack);
    const total = Math.round(cases * per * 100) / 100;
    const prev = m.get(cases);
    if (!prev || total > prev.total) m.set(cases, { cases, per, total });
  }
  return [...m.values()].sort((a, b) => a.cases - b.cases);
}

type MonthLabel = 'Current Month' | 'Next Month';
interface RipProgramRow { month: MonthLabel; dates: string; sizes: string | null; levels: RipLevel[]; ts: boolean; }
interface RipProgram { code: string | null; rows: RipProgramRow[]; }

// Build one row PER (program code, validity window) PER month, so a full-month
// RIP and a time-sensitive (partial-window) RIP under the same code each get
// their own row under the right month. Next Month rows appear only when that
// edition is loaded (the `next` block is present).
function buildRipPrograms(cur: MonthBreakdown | null, next: MonthBreakdown | null, pack: number | null): RipProgram[] {
  const byCode = new Map<string, RipProgram>();
  const add = (month: MonthLabel, block: MonthBreakdown | null) => {
    const tiers = (block?.ripTiers ?? []).filter(t => (t.ripOnlySave ?? 0) > 0.005);
    if (!tiers.length) return;
    // group by RIP code, then by validity window within the code
    const byCodeTiers = new Map<string, RipTier[]>();
    for (const t of tiers) {
      const k = t.code ?? '';
      const arr = byCodeTiers.get(k);
      if (arr) arr.push(t); else byCodeTiers.set(k, [t]);
    }
    for (const [code, gt] of byCodeTiers) {
      const prog = byCode.get(code) ?? { code: code || null, rows: [] };
      const byWin = new Map<string, RipTier[]>();
      for (const t of gt) {
        const wk = `${t.from_date ?? ''}|${t.to_date ?? ''}`;
        const arr = byWin.get(wk);
        if (arr) arr.push(t); else byWin.set(wk, [t]);
      }
      for (const wt of byWin.values()) {
        const t0 = wt[0];
        prog.rows.push({
          month,
          dates: fmtDateRange(t0.from_date, t0.to_date) || 'Full month',
          sizes: wt.map(t => t.description).find(d => d && d.trim()) ?? null,
          levels: ripLevels(wt, pack),
          ts: wt.some(t => t.ts),
        });
      }
      byCode.set(code, prog);
    }
  };
  add('Current Month', cur);
  add('Next Month', next);
  return [...byCode.values()];
}

function RipPanel({ programs }: { programs: RipProgram[] }) {
  return (
    <section className="pdx-panel pdx-rip">
      <h3 className="pdx-panel-h">RIP</h3>
      {programs.length === 0 ? (
        <p className="pdx-empty">No RIP this month.</p>
      ) : (
        <div className="pdx-rip-progs">
          {programs.map((p, i) => (
            <div className="pdx-rip-prog" key={`${p.code ?? 'rip'}-${i}`}>
              <div className="pdx-rip-code">RIP{p.code ? ` ${p.code}` : ''}</div>
              <table className="pdx-rip-table">
                <thead>
                  <tr><th></th><th>Dates</th><th>Sizes</th><th>Levels</th></tr>
                </thead>
                <tbody>
                  {p.rows.map((r, ri) => (
                    <tr key={ri}>
                      <td className="pdx-rip-month">
                        {r.month}
                        {r.ts && <TsSticker />}
                      </td>
                      <td className="pdx-rip-dates">{r.dates}</td>
                      <td className="pdx-rip-sizes">{r.sizes ?? '—'}</td>
                      <td className="pdx-rip-levels">
                        {r.levels.length === 0 ? '—' : r.levels.map((l, li) => (
                          <span className="pdx-rip-level" key={li}>
                            {fmtCs(l.cases)} {l.cases === 1 ? 'case' : 'cases'}: <strong>{moneyRound(l.total)}</strong>
                          </span>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ───────────────────────── QD prices chart ─────────────────────────
interface QdRow { label: string; perCase: number | null; perBottle: number | null; ts: boolean; }
function buildQdRows(block: MonthBreakdown | null, pack: number | null, frontlineUnit: number | null): QdRow[] {
  if (!block) return [];
  const rows: QdRow[] = [];
  const bottleList = block.frontline != null && pack ? block.frontline / pack : frontlineUnit;
  // 1 Bottle (list single bottle) and 1 Case (after the 1-case QD) are the
  // dependable monthly headline prices — never time-sensitive.
  rows.push({ label: '1 Bottle', perCase: null, perBottle: bottleList, ts: false });
  const oneCase = afterOneCase(block);
  rows.push({ label: '1 Case', perCase: oneCase, perBottle: oneCase != null && pack ? oneCase / pack : null, ts: false });
  const seen = new Map<string, QdRow>();
  for (const t of (block.discountTiers ?? [])) {
    const cs = caseQty(t, pack);
    if (cs <= 1 + 1e-9) continue;
    const label = `${fmtCs(cs)} ${cs === 1 ? 'Case' : 'Cases'}`;
    const row: QdRow = { label, perCase: t.eff, perBottle: pack ? t.eff / pack : null, ts: !!t.ts };
    const prev = seen.get(label);
    if (!prev || (row.perCase ?? Infinity) < (prev.perCase ?? Infinity)) seen.set(label, row);
  }
  const brackets = [...seen.values()].sort((a, b) => (a.perCase ?? 0) - (b.perCase ?? 0));
  return [...rows, ...brackets];
}

function QdMonth({ title, rows, csWord, btlWord }: { title: string; rows: QdRow[]; csWord: string; btlWord: string }) {
  const best = rows.reduce<number | null>((m, r) => r.perCase != null ? (m == null ? r.perCase : Math.min(m, r.perCase)) : m, null);
  return (
    <div className="pdx-qd-month">
      <div className="pdx-qd-month-h">{title}</div>
      <table className="pdx-qd-table">
        <thead>
          <tr><th>Type</th><th className="pdx-num">Price by {csWord}</th><th className="pdx-num">Price by {btlWord}</th></tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const isBest = r.perCase != null && best != null && r.perCase <= best + 1e-9 && /case/i.test(r.label) && r.label !== '1 Case';
            return (
              <tr key={i} className={isBest ? 'pdx-qd-best' : undefined}>
                <td>{r.label}{r.ts && <TsSticker />}</td>
                <td className="pdx-num">{money(r.perCase) ?? '—'}</td>
                <td className="pdx-num">{money(r.perBottle) ?? '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function QdChart({ cur, next, pack, frontlineUnit, csWord, btlWord }: {
  cur: MonthBreakdown | null; next: MonthBreakdown | null; pack: number | null;
  frontlineUnit: number | null; csWord: string; btlWord: string;
}) {
  const curRows = buildQdRows(cur, pack, frontlineUnit);
  const nextRows = buildQdRows(next, pack, frontlineUnit);
  return (
    <section className="pdx-panel pdx-qd">
      <h3 className="pdx-panel-h">Prices chart</h3>
      <div className="pdx-qd-grid">
        {curRows.length > 0 && <QdMonth title="Current Month" rows={curRows} csWord={csWord} btlWord={btlWord} />}
        {next && nextRows.length > 0 && <QdMonth title="Next Month" rows={nextRows} csWord={csWord} btlWord={btlWord} />}
      </div>
    </section>
  );
}

// ───────────────────────── public component ─────────────────────────
/**
 * Render the uniform RIP details + QD prices chart for one product listing.
 * `name` (the product family name) is used only to correct slash-multipack
 * sizing; defaults to the row's own product_name.
 */
export default function RipQdPanels({ size, name, className }: {
  size: Product;
  name?: string;
  className?: string;
}) {
  const pname = name ?? size.product_name;
  const pack = bottlesPerCase(pname, size.unit_qty);
  const months = useMemo(() => buildMonths(size), [size]);
  const cur = currentMonth(months);
  const next = months.find(m => m.future) ?? null;
  const csWord = priceUnitWord(size.unit_volume, size.unit_type);
  const btlWord = perUnitNoun(size.unit_volume, size.unit_type);
  const frontlineUnit = pack && size.frontline_case_price != null
    ? size.frontline_case_price / pack : (size.frontline_unit_price ?? null);
  const programs = useMemo(() => buildRipPrograms(cur, next, pack), [cur, next, pack]);
  return (
    <div className={`pdx-detail-grid${className ? ` ${className}` : ''}`}>
      <RipPanel programs={programs} />
      <QdChart cur={cur} next={next} pack={pack} frontlineUnit={frontlineUnit} csWord={csWord} btlWord={btlWord} />
    </div>
  );
}
