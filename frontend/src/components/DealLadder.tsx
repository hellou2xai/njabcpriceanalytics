/**
 * DealLadder — the ONE reusable quantity-discount + RIP tier ladder.
 *
 * Renders, for the current month, every QD and RIP tier as
 *   "QD/RIP  Buy N cs → $price/cs · $price/btl (−$savings)"
 * driven from the SAME `buildMonths(price_3mo)` data the sparkline uses, so the
 * inline numbers can never disagree with the chart or the price-schedule
 * tooltip. The savings figure differs BY KIND on purpose:
 *   - QD rows show the discount off list (list − net price at that tier).
 *   - RIP rows show the REBATE ALONE (rip_only_save_per_case) — the number on
 *     the RIP sheet and in the rep's quote. The net price already includes any
 *     stacked case discount, but folding that $ into the RIP's parenthetical
 *     made a $42 rebate read as "−$48", which confused everyone.
 *
 * Used by the Products list expanded size rows AND the collapsed product card,
 * so there is exactly one place that turns canonical tiers into UI.
 */
import { Fragment } from 'react';
import type { MonthBreakdown, RipTier } from './MonthEffectiveSparkline';
import { currentMonth } from './MonthEffectiveSparkline';
import TierBadge from './TierBadge';
import { windowBadge, fmtDateRange } from '../lib/dealDates';
import { priceUnit, perUnitAbbr, isKegUnit } from '../lib/distributors';

const unitWord = (u: string) => (/^\s*b/i.test(u) ? 'btl' : 'cs');

// Partial-month (time-sensitive) RIP/discount flag with its date window — so a
// deal that's only valid part of the month is never mistaken for the dependable
// full-month price. Full-month / evergreen tiers render nothing.
function PartialFlag({ t }: { t: RipTier }) {
  const wb = windowBadge(t);
  if (!t.ts && !wb) return null;
  const range = fmtDateRange(t.from_date, t.to_date);
  // Colour by window STATUS so the three states read apart at a glance:
  // amber = active now (green blended into the RIP pills around it), blue =
  // starts later, gray = expired; red overrides amber when the active window
  // ends within a week (urgent).
  const cls = `${wb?.cls ?? 'win-partial'}${wb?.urgent ? ' urgent' : ''}`;
  const label = t.ts ? `⏱ Partial · ${range || 'limited dates'}` : (wb?.label ?? '');
  return (
    <span className={`win-badge ${cls}`}
      title={`Partial-month deal — only valid ${range || 'on limited dates'}${wb ? ` (${wb.label})` : ''}. Not part of the full-month price.`}>
      {label}{t.ts && wb ? ` · ${wb.label}` : ''}
    </span>
  );
}

export default function DealLadder({ months, pack, emptyText, unitVolume, unitType, monthMode = 'current' }: {
  months: MonthBreakdown[];
  pack: number | null;
  // When set, renders this note if there are no deals; when omitted, renders
  // nothing (so callers that only want the ladder stay clean).
  emptyText?: string;
  // Container so prices read in the real unit (keg/can/bottle), not always btl/cs.
  unitVolume?: string | null;
  unitType?: string | null;
  // Which month's RIP/QD ladder to show: 'current' (the calendar month, default)
  // or 'next' (the early-loaded next edition, when present). Driven by the
  // Products rail "RIP / QD month" filter.
  monthMode?: 'current' | 'next';
}) {
  const csWord = priceUnit(unitVolume, unitType);   // 'keg' | 'cs'
  const unitNoun = perUnitAbbr(unitVolume, unitType); // 'keg' | 'can' | 'btl'
  const keg = isKegUnit(unitVolume, unitType);       // kegs have no per-bottle
  // Which block to show. 'current' = newest NON-future block (the calendar
  // month); 'next' = the early-loaded next edition when present (else fall back
  // to current). The sparkline still plots every month regardless.
  const cur = monthMode === 'next'
    ? (months.find(m => m.future) ?? currentMonth(months))
    : currentMonth(months);
  const frontline = cur?.frontline ?? null;
  // Sort by the deal's EFFECTIVE WINDOW first (evergreen/full-month before
  // dated; earlier windows before later), then by CASE-EQUIVALENT qty — so a
  // bottle-unit tier (shown as a fraction of a case) and case-unit tiers form
  // ONE clean ascending "buy more → pay less" ladder instead of interleaving
  // (2cs, 3btl, 5cs, 6btl read as a jumbled pile that looks like many RIPs).
  const caseQty = (t: RipTier) =>
    (/^\s*b/i.test(t.unit) && pack && pack > 0 ? t.qty / pack : t.qty);
  const byWindow = (a: RipTier, b: RipTier) =>
    (a.from_date ?? '0000').localeCompare(b.from_date ?? '0000')
    || (a.to_date ?? '9999').localeCompare(b.to_date ?? '9999')
    || caseQty(a) - caseQty(b);
  // RIP tiers: ascending by rebate amount (consistent everywhere RIP shows)
  const byRebate = (a: RipTier, b: RipTier) =>
    (a.ripOnlySave ?? 0) - (b.ripOnlySave ?? 0) || caseQty(a) - caseQty(b);
  // Status rank: current (active / evergreen / full-month) first, then
  // future (upcoming), then expired last. Applied to QD tiers AND RIP groups.
  const statusRank = (t: RipTier) =>
    t.window_status === 'upcoming' ? 1 : t.window_status === 'expired' ? 2 : 0;
  const disc = [...(cur?.discountTiers ?? [])]
    .sort((a, b) => statusRank(a) - statusRank(b) || byWindow(a, b));
  const rip = [...(cur?.ripTiers ?? [])].sort(byRebate);
  const btlOf = (c?: number | null) => (pack && c != null ? c / pack : null);
  // Best (lowest) case price reached by a QD tier and by a RIP tier — those
  // lines get the yellow "best deal" highlight (red font). A 1-case QD is just
  // the single-case price, not a quantity discount, so it's excluded from the
  // best-QD band (matches the "In QD (>1 CS)" filter).
  const realQd = disc.filter(t => caseQty(t) > 1 + 1e-9);
  const bestQdEff = realQd.length ? Math.min(...realQd.map(t => t.eff)) : null;
  const bestRipEff = rip.length ? Math.min(...rip.map(t => t.eff)) : null;

  if (disc.length === 0 && rip.length === 0) {
    return emptyText ? <span className="prod-deals-none">{emptyText}</span> : null;
  }

  // Prefer CASES for the buy quantity so the whole ladder reads in the same
  // unit as the /cs prices. A bottle-unit tier (e.g. "24 btl") is converted to
  // cases via the pack size ("1 cs"); when the item is 1 bottle/case a bottle
  // tier IS a case tier. Falls back to bottles only when the pack is unknown.
  const uw = (u: string) => (pack === 1 ? 'cs' : unitWord(u));
  const fmtCs = (n: number) => {
    const r = Math.round(n * 100) / 100;
    return Number.isInteger(r) ? String(r) : String(r);
  };
  const buyLabel = (t: RipTier) => {
    const isBtl = /^\s*b/i.test(t.unit);
    if (isBtl && pack && pack > 0) return `${fmtCs(t.qty / pack)} cs`;
    // Half-case rule (case-credit model): show the REAL physical buy-in,
    // not the printed qualifying quantity ("buy 2 cs" for a 1-cs tier).
    if (t.qualifiedCases != null && t.qualifiedCases !== t.qty) {
      return `${fmtCs(t.qualifiedCases)} ${uw(t.unit)}`;
    }
    return `${t.qty} ${uw(t.unit)}`;
  };

  // Per-tier TOTAL glance lines shown ABOVE the table: at each tier, the dollars
  // the buyer actually gets (cases x per-case), not the per-case figure or the
  // price. RIP total = cases x RIP-per-case; QD total = cases x discount-off.
  // "5 cs / $50.00 · 10 cs / $150.00 · 20 cs / $400.00", ascending, best in the
  // red-on-yellow highlight. The detailed per-tier ladder stays in the table.
  const sortQty = (t: RipTier) => (t.qualifiedCases ?? caseQty(t));
  // Each tier summary carries: q (cases), per (the per-case $ — discount off for
  // QD, rebate for RIP), total (cases x per), and the representative tier so the
  // line can show its date window when the deal is time-sensitive.
  const tierTotals = (tiers: RipTier[], perOf: (t: RipTier) => number | null) => {
    const m = new Map<string, { q: number; total: number; per: number; tier: RipTier }>();
    for (const t of tiers) {
      const per = perOf(t);
      if (per == null || per <= 0.005) continue;
      const q = sortQty(t);
      const total = Math.round(q * per * 100) / 100;
      const label = buyLabel(t);
      const prev = m.get(label);
      if (!prev || total > prev.total) m.set(label, { q, total, per, tier: t });
    }
    const list = [...m.entries()].map(([label, v]) => ({ label, ...v })).sort((a, b) => a.q - b.q);
    const best = list.length ? Math.max(...list.map(s => s.total)) : null;
    return { list, best };
  };
  const ripTotals = tierTotals(rip, t => t.ripOnlySave ?? null);
  const qdTotals = tierTotals(disc, t => (frontline != null && t.eff < frontline ? frontline - t.eff : null));

  // One tier as a TABLE ROW (Type | Buy | $/cs | $/btl | Save). Best tier in its
  // class gets the red-on-yellow highlight (unchanged convention).
  const Row = (kind: 'qd' | 'rip', t: RipTier, i: number, noFlag = false) => {
    const b = btlOf(t.eff);
    const off = frontline != null && t.eff < frontline ? frontline - t.eff : null;
    // RIP rows: the rebate ALONE (the RIP-sheet number), never rebate+QD mixed.
    const ripSave = kind === 'rip' ? (t.ripOnlySave ?? null) : null;
    // RIP Profit % = rebate / after-QD outlay (= price_after + rebate) * 100 —
    // the return on the cash you put down, the SAME identity Compare RIPs /
    // Best RIPs use (FOUNDATION). >60% is treated as a source-data anomaly and
    // suppressed rather than shown.
    const afterQd = ripSave != null ? t.eff + ripSave : null;
    const ripProfitPct = (ripSave != null && ripSave > 0.005 && afterQd != null && afterQd > 0
      && ripSave / afterQd <= 0.60) ? (ripSave / afterQd) * 100 : null;
    const isBest = (kind === 'qd' && bestQdEff != null && caseQty(t) > 1 + 1e-9 && t.eff <= bestQdEff + 1e-9)
      || (kind === 'rip' && bestRipEff != null && t.eff <= bestRipEff + 1e-9);
    return (
      <tr key={`${kind}${i}`} className={`prod-deal-trow${isBest ? ' prod-deal-best' : ''}`}>
        <td className="prod-deal-td-type"><TierBadge kind={kind} />{!noFlag && <PartialFlag t={t} />}</td>
        <td className="prod-deal-td-buy">{buyLabel(t)}</td>
        <td className="prod-deal-num"><strong>${t.eff.toFixed(2)}</strong></td>
        <td className="prod-deal-num">{b != null && !keg ? `$${b.toFixed(2)}` : '—'}</td>
        <td className="prod-deal-num prod-deal-save">
          {kind === 'rip' && ripSave != null && ripSave > 0.005
            ? <span title="The RIP rebate alone, per case — the RIP-sheet number.">−${ripSave.toFixed(2)}</span>
            : kind === 'qd' && off != null && off > 0.005
              ? <span title="Total discount off list at this tier, per case.">−${off.toFixed(2)}</span>
              : '—'}
        </td>
        <td className="prod-deal-num prod-deal-profit">
          {ripProfitPct != null
            ? <span title="RIP profit: the rebate as a % of the after-QD cash you put down (rebate ÷ (price after RIP + rebate)).">{ripProfitPct.toFixed(1)}%</span>
            : '—'}
        </td>
      </tr>
    );
  };

  // Group RIP tiers by their RIP code (program). One UPC can sit under more
  // than one RIP — showing them as separate labeled blocks makes clear they're
  // alternative programs (you pick one by how much you buy), not one big pile
  // where "every RIP is available".
  const ripGroups: { code: string | null; tiers: RipTier[] }[] = [];
  for (const t of rip) {
    const code = t.code ?? null;
    const g = ripGroups.find(x => x.code === code);
    if (g) g.tiers.push(t);
    else ripGroups.push({ code, tiers: [t] });
  }
  // Programs ordered current -> future -> expired (a group counts as the BEST
  // status among its tiers, so a program with any live tier sorts as current).
  // Array.sort is stable, so same-status groups keep their original order.
  ripGroups.sort((a, b) =>
    Math.min(...a.tiers.map(statusRank)) - Math.min(...b.tiers.map(statusRank)));
  const multiProgram = ripGroups.length > 1;

  // A RIP program's tiers share one validity window almost always; repeating
  // the same dated sticker on every tier line is noise. When the whole group
  // shares one flagged window, hoist the sticker to the group header (next to
  // the RIP number) and keep the tier lines clean. Mixed windows inside one
  // group (rare) keep their per-line stickers because that IS the information.
  const winKey = (t: RipTier) => `${t.ts ? 1 : 0}|${t.from_date ?? ''}|${t.to_date ?? ''}`;
  const hoistedFlag = (g: { tiers: RipTier[] }): RipTier | null => {
    const t0 = g.tiers[0];
    if (!t0 || !(t0.ts || windowBadge(t0))) return null;
    return g.tiers.every(t => winKey(t) === winKey(t0)) ? t0 : null;
  };

  return (
    <div className="prod-deal-wrap">
      {(qdTotals.list.length > 0 || ripTotals.list.length > 0) && (
        <div className="prod-deal-totals">
          {qdTotals.list.length > 0 && (
            <div className="prod-deal-tot prod-deal-tot-qd"
              title="QD Tier — the total quantity-discount you save at each tier (cases x discount off list per case), i.e. the dollars off, not the per-case figure or the price.">
              <span className="prod-deal-tot-k">QD Tier</span>
              <span className="prod-deal-tot-vals">
                {qdTotals.list.map((s, i) => (
                  <span key={i} className={qdTotals.best != null && s.total >= qdTotals.best - 1e-9 ? 'prod-deal-tot-best' : undefined}>
                    {s.label} / ${s.per.toFixed(2)}/{csWord} / <strong>${s.total.toFixed(2)}</strong>
                    <PartialFlag t={s.tier} />
                  </span>
                ))}
              </span>
            </div>
          )}
          {ripTotals.list.length > 0 && (
            <div className="prod-deal-tot prod-deal-tot-rip"
              title="RIP Tier — the total RIP rebate at each tier (cases x RIP per case), i.e. the dollars you get back, not the per-case figure or the price.">
              <span className="prod-deal-tot-k">RIP Tier</span>
              <span className="prod-deal-tot-vals">
                {ripTotals.list.map((s, i) => (
                  <span key={i} className={ripTotals.best != null && s.total >= ripTotals.best - 1e-9 ? 'prod-deal-tot-best' : undefined}>
                    {s.label} / ${s.per.toFixed(2)}/{csWord} / <strong>${s.total.toFixed(2)}</strong>
                    <PartialFlag t={s.tier} />
                  </span>
                ))}
              </span>
            </div>
          )}
        </div>
      )}
    <table className="prod-deal-table">
      <thead>
        {/* Grouped header: the price columns are the landed price AFTER QD/RIP,
            the last column is the savings PER CASE. Spelt out so the buyer never
            has to guess what /cs and /btl mean here. */}
        <tr className="prod-deal-hgrp">
          <th></th>
          <th></th>
          <th className="prod-deal-num prod-deal-hgrp-c" colSpan={2}>After QD / RIP</th>
          <th className="prod-deal-num prod-deal-hgrp-c">Savings</th>
          <th className="prod-deal-num prod-deal-hgrp-c">RIP profit</th>
        </tr>
        <tr>
          <th>Tier</th>
          <th>Buy</th>
          <th className="prod-deal-num">/{csWord}</th>
          <th className="prod-deal-num">/{unitNoun}</th>
          <th className="prod-deal-num">/{csWord}</th>
          <th className="prod-deal-num">%</th>
        </tr>
      </thead>
      <tbody>
        {disc.map((t, i) => Row('qd', t, i))}
        {ripGroups.map((g, gi) => {
          const hoist = hoistedFlag(g);
          // List EVERY tier in this program on its header row, each as
          // "case qty / rebate per case / total rebate" (cases x per-case) — the
          // same format as the top RIP Tier summary, scoped to this program, so
          // the buyer sees ALL of a program's tiers (not just the best) without
          // reading the rows.
          const grpList = tierTotals(g.tiers, t => t.ripOnlySave ?? null).list;
          return (
            <Fragment key={`rg${gi}`}>
              {(multiProgram || hoist) && (
                <tr className="prod-deal-grouphdr">
                  <td colSpan={6}
                    title="A separate RIP program for this product — pick the one matching how much you buy. These do not stack.">
                    RIP{g.code ? ` ${g.code}` : ''}
                    {grpList.length > 0 && (
                      <span className="prod-deal-grouphdr-tot"
                        style={{ fontWeight: 400, color: 'var(--text-muted)' }}
                        title="Every tier in this program: case quantity / rebate per case / total rebate (cases x rebate per case).">
                        {grpList.map((s, i) => (
                          <Fragment key={i}>
                            {' · '}{s.label} / ${s.per.toFixed(2)}/{csWord} / <strong style={{ color: 'var(--green)' }}>${s.total.toFixed(2)}</strong>
                          </Fragment>
                        ))}
                        {' total RIP'}
                      </span>
                    )}
                    {hoist && <PartialFlag t={hoist} />}
                  </td>
                </tr>
              )}
              {g.tiers.map((t, i) => Row('rip', t, i, !!hoist))}
            </Fragment>
          );
        })}
      </tbody>
    </table>
    </div>
  );
}
