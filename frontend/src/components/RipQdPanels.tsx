/**
 * RipQdPanels — the ONE shared "RIP details + QD prices chart" layout.
 *
 * Used wherever a product's QD / RIP tiers are shown (product detail page,
 * Products list expanded rows, Quick View) so every surface renders the SAME
 * two panels and users get a uniform read:
 *
 *   RIP          — one row per program per month: Current/Next Month | Dates |
 *                  Sizes | Levels. Sizes is the RIP-sheet free text
 *                  (rip_description, column M) with each pack rule on its own
 *                  line; Levels are qualifying cases : total rebate $.
 *   Prices chart — stacked Current Month / Next Month cards (distinct header
 *                  bands), each: Type | Price by case | Price by bottle, rows =
 *                  1 Bottle + 1 Case + every quantity-discount bracket.
 *
 * Driven from the SAME buildMonths(price_3mo) series the sparkline/ladder use,
 * so the numbers can never disagree with the rest of the app.
 */
import { Fragment, useMemo } from 'react';
import { buildMonths } from '../lib/promotionsSparkline';
import { currentMonth, type MonthBreakdown, type RipTier } from './MonthEffectiveSparkline';
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
function caseQty(t: RipTier, pack: number | null): number {
  return isBottleUnit(t.unit) && pack && pack > 0 ? t.qty / pack : t.qty;
}
function buyCases(t: RipTier, pack: number | null): number {
  if (isBottleUnit(t.unit) && pack && pack > 0) return t.qty / pack;
  if (t.qualifiedCases != null && t.qualifiedCases !== t.qty) return t.qualifiedCases;
  return t.qty;
}
function fmtCs(n: number): string {
  return String(Math.round(n * 100) / 100);
}
export function afterOneCase(b: MonthBreakdown | null): number | null {
  if (!b) return null;
  return b.disc1 ?? b.frontline ?? null;
}

// ISO validity window "2026-06-01 - 2026-06-30" (matches the RIP sheet). A
// missing window reads "Full month".
function isoRange(from?: string | null, to?: string | null): string {
  const a = from ? String(from).slice(0, 10) : null;
  const b = to ? String(to).slice(0, 10) : null;
  if (a && b) return `${a} - ${b}`;
  if (a) return `from ${a}`;
  if (b) return `until ${b}`;
  return 'Full month';
}

// Split the RIP free text (rip_description) so each pack rule / clause is on its
// own line, e.g. "GLENLIVET 12YR 12PK 375ML = 1/2 CASE 6PK 750ML = 1/2 CASE
// EXCLUDES VAP" -> ["GLENLIVET 12YR", "12PK 375ML = 1/2 CASE",
// "6PK 750ML = 1/2 CASE", "EXCLUDES VAP"]. The sheet uses no newlines, so we
// break before each pack token (Npk) and before INCLUDES/EXCLUDES clauses.
function splitRipSizes(desc?: string | null): string[] {
  if (!desc) return [];
  const s = String(desc).replace(/\s+/g, ' ').trim()
    // Break after each "… CASE" (the end of one size rule) so the next size
    // rule starts on its own line, before pack tokens, and before any
    // INCLUDE/EXCLUDE clause (INCLUDES, EXCLUDING, EXCLUDES, …).
    .replace(/(\bCASE\b)\s+(?=\S)/gi, '$1\n')
    .replace(/\s+(?=\d+\s*PK\b)/gi, '\n')
    .replace(/\s+(?=(?:EXCLUD|INCLUD))/gi, '\n');
  return s.split('\n').map(x => x.trim()).filter(Boolean);
}

// Time-sensitive sticker — shown on EVERY RIP or QD line valid only on partial
// dates (not the whole month), so a limited-window deal is never mistaken for
// the dependable monthly price.
const TsSticker = () => (
  <span className="pdx-ts" title="Time-sensitive: valid only on the dates shown, not the whole month.">TS</span>
);

// ───────────────────────── RIP panel ─────────────────────────
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

interface RipRow { code: string | null; dates: string; sizes: string[]; levels: RipLevel[]; ts: boolean; isNext: boolean; noRip?: boolean; }

// One FLAT list of RIP rows — one per (code, validity window), current-month
// windows first then next-month. RIP codes are reissued every edition, so we
// never pair a current code with a "next month" of the same code; instead, if
// next month's edition is loaded and has NO RIP at all, we add ONE
// "No RIP Next Month" line at the end.
function buildRipRows(cur: MonthBreakdown | null, next: MonthBreakdown | null, pack: number | null): RipRow[] {
  const rows: RipRow[] = [];
  const addBlock = (block: MonthBreakdown | null, isNext: boolean) => {
    const tiers = (block?.ripTiers ?? []).filter(t => (t.ripOnlySave ?? 0) > 0.005);
    const byCode = new Map<string, RipTier[]>();
    for (const t of tiers) {
      const k = t.code ?? '';
      const arr = byCode.get(k);
      if (arr) arr.push(t); else byCode.set(k, [t]);
    }
    for (const [code, gt] of byCode) {
      const byWin = new Map<string, RipTier[]>();
      for (const t of gt) {
        const wk = `${t.from_date ?? ''}|${t.to_date ?? ''}`;
        const arr = byWin.get(wk);
        if (arr) arr.push(t); else byWin.set(wk, [t]);
      }
      for (const wt of byWin.values()) {
        const t0 = wt[0];
        rows.push({
          code: code || null,
          dates: isoRange(t0.from_date, t0.to_date),
          sizes: splitRipSizes(wt.map(t => t.description).find(d => d && d.trim())),
          levels: ripLevels(wt, pack),
          ts: wt.some(t => t.ts),
          isNext,
        });
      }
    }
  };
  addBlock(cur, false);
  addBlock(next, true);
  const hasCurrent = rows.some(r => !r.isNext);
  const hasNext = rows.some(r => r.isNext);
  // No RIP this month -> a "No RIP This Month" line under Current Month.
  if (!hasCurrent) {
    rows.unshift({ code: null, dates: '', sizes: [], levels: [], ts: false, isNext: false, noRip: true });
  }
  // Next month's edition loaded with no RIP -> a single "No RIP Next Month" line.
  if (next && !hasNext) {
    rows.push({ code: null, dates: '', sizes: [], levels: [], ts: false, isNext: true, noRip: true });
  }
  return rows;
}

function RipPanel({ rows }: { rows: RipRow[] }) {
  return (
    <section className="pdx-panel pdx-rip">
      <h3 className="pdx-panel-h">RIP</h3>
      {rows.length === 0 ? (
        <p className="pdx-empty">No RIP this month.</p>
      ) : (
        <table className="pdx-rip-table">
          <thead>
            <tr><th>RIP</th><th>Dates</th><th>Sizes</th><th>Levels</th></tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const prev = i > 0 ? rows[i - 1] : null;
              // Group label before the first current-month and first next-month row.
              const header = (!r.isNext && (!prev || prev.isNext)) ? 'Current Month'
                : (r.isNext && (!prev || !prev.isNext)) ? 'Next Month' : null;
              return (
                <Fragment key={i}>
                  {header && (
                    <tr className="pdx-rip-grouphdr"><td colSpan={4}>{header}</td></tr>
                  )}
                  {r.noRip ? (
                    <tr><td className="pdx-rip-norip" colSpan={4}>{r.isNext ? 'No RIP Next Month' : 'No RIP This Month'}</td></tr>
                  ) : (
                    <tr>
                      <td className="pdx-rip-codecell">RIP{r.code ? ` ${r.code}` : ''}{r.ts && <TsSticker />}</td>
                      <td className="pdx-rip-dates">{r.dates}</td>
                      <td className="pdx-rip-sizes">
                        {r.sizes.length === 0 ? '—' : r.sizes.map((line, li) => (
                          <div className="pdx-rip-sizeline" key={li}>{line}</div>
                        ))}
                      </td>
                      <td className="pdx-rip-levels">
                        {r.levels.length === 0 ? '—' : r.levels.map((l, li) => (
                          <span className="pdx-rip-level" key={li}>
                            {fmtCs(l.cases)} {l.cases === 1 ? 'case' : 'cases'}: <strong>{moneyRound(l.total)}</strong>
                          </span>
                        ))}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
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

function QdCard({ title, variant, rows, csWord, btlWord }: {
  title: string; variant: 'current' | 'next'; rows: QdRow[]; csWord: string; btlWord: string;
}) {
  const best = rows.reduce<number | null>((m, r) => r.perCase != null ? (m == null ? r.perCase : Math.min(m, r.perCase)) : m, null);
  return (
    <div className={`pdx-qd-card pdx-qd-card--${variant}`}>
      <div className="pdx-qd-title">{title}</div>
      <div className="pdx-qd-band">Prices Chart</div>
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
      <div className="pdx-qd-stack">
        {curRows.length > 0 && <QdCard title="CURRENT MONTH" variant="current" rows={curRows} csWord={csWord} btlWord={btlWord} />}
        {next && nextRows.length > 0 && <QdCard title="NEXT MONTH" variant="next" rows={nextRows} csWord={csWord} btlWord={btlWord} />}
      </div>
    </section>
  );
}

// ───────────────────────── public component ─────────────────────────
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
  const ripRows = useMemo(() => buildRipRows(cur, next, pack), [cur, next, pack]);
  return (
    <div className={`pdx-detail-grid${className ? ` ${className}` : ''}`}>
      <RipPanel rows={ripRows} />
      <QdChart cur={cur} next={next} pack={pack} frontlineUnit={frontlineUnit} csWord={csWord} btlWord={btlWord} />
    </div>
  );
}
