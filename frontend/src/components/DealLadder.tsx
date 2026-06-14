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
import type { MonthBreakdown, RipTier } from './MonthEffectiveSparkline';
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

export default function DealLadder({ months, pack, emptyText, unitVolume, unitType }: {
  months: MonthBreakdown[];
  pack: number | null;
  // When set, renders this note if there are no deals; when omitted, renders
  // nothing (so callers that only want the ladder stay clean).
  emptyText?: string;
  // Container so prices read in the real unit (keg/can/bottle), not always btl/cs.
  unitVolume?: string | null;
  unitType?: string | null;
}) {
  const csWord = priceUnit(unitVolume, unitType);   // 'keg' | 'cs'
  const unitNoun = perUnitAbbr(unitVolume, unitType); // 'keg' | 'can' | 'btl'
  const keg = isKegUnit(unitVolume, unitType);       // kegs have no per-bottle
  const cur = months.length ? months[months.length - 1] : null;
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
  const line = (kind: 'qd' | 'rip', t: RipTier, i: number, noFlag = false) => {
    const b = btlOf(t.eff);
    const off = frontline != null && t.eff < frontline ? frontline - t.eff : null;
    // RIP rows: the rebate ALONE (the RIP-sheet number), never rebate+QD mixed.
    const ripSave = kind === 'rip' ? (t.ripOnlySave ?? null) : null;
    return (
      <div key={`${kind}${i}`} className="prod-deal-line">
        <TierBadge kind={kind} />
        {/* Dated-window sticker sits LEFT (after the pill) so its variable
            length never drags a line's tail out and wrecks the column.
            Suppressed when the whole RIP group shares one window — the
            sticker then renders ONCE on the group header instead. */}
        {!noFlag && <PartialFlag t={t} />}{' '}
        {buyLabel(t)} → <strong>${t.eff.toFixed(2)}/{csWord}</strong>
        {b != null && !keg && <span className="prod-deal-btl"> · ${b.toFixed(2)}/{unitNoun}</span>}
        {kind === 'rip' && ripSave != null && ripSave > 0.005 && (
          <span className="prod-deal-off"
            title="The RIP rebate alone, per case — the number on the RIP sheet. The price shown already includes any stacked case discount.">
            {' '}(RIP -${ripSave.toFixed(2)}/{csWord})
          </span>
        )}
        {kind === 'qd' && off != null && off > 0.005 && (
          <span className="prod-deal-off"
            title="Total discount off the list price at this tier, per case.">
            {' '}(−${off.toFixed(2)}/{csWord})
          </span>
        )}
      </div>
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

  // "RIP Tier" glance line ADDED above the detailed RIP rows: each tier's real
  // buy-in and the TOTAL RIP rebate at that tier = cases x RIP-per-case (what
  // the buyer actually gets back), NOT the per-case figure and NOT the price —
  // "5 cs/$50.00, 10 cs/$150.00, 20 cs/$400.00", ascending, in the RIP colour.
  // The per-tier price/bottle/window detail stays below.
  const sortQty = (t: RipTier) => (t.qualifiedCases ?? caseQty(t));
  const summaryMap = new Map<string, { q: number; total: number }>();
  for (const t of rip) {
    const per = t.ripOnlySave ?? null;
    if (per == null || per <= 0) continue;
    const q = sortQty(t);
    const total = Math.round(q * per * 100) / 100;   // cases x RIP per case
    const label = buyLabel(t);
    const prev = summaryMap.get(label);
    if (!prev || total > prev.total) summaryMap.set(label, { q, total });
  }
  const summary = [...summaryMap.entries()]
    .map(([label, v]) => ({ label, ...v }))
    .sort((a, b) => a.q - b.q);

  return (
    <>
      {disc.map((t, i) => line('qd', t, i))}
      {summary.length > 0 && (
        <div className="prod-deal-line prod-deal-rip-summary"
          title="RIP Tier — the total RIP rebate at each tier (cases x RIP per case), i.e. the dollars you get back, not the per-case figure or the price.">
          <span className="prod-rip-tier-label">RIP Tier</span>{' '}
          <span className="prod-rip-tiers">
            {summary.map((s, i) => (
              <span key={i}>{i > 0 && ', '}{s.label}/<strong>${s.total.toFixed(2)}</strong></span>
            ))}
          </span>
        </div>
      )}
      {ripGroups.map((g, gi) => {
        const hoist = hoistedFlag(g);
        return (
          <div key={`rg${gi}`} className={multiProgram ? 'prod-rip-group' : undefined}>
            {(multiProgram || hoist) && (
              <div className="prod-rip-group-hdr" title="A separate RIP program for this product — pick the one that matches how much you buy. These do not stack.">
                RIP{g.code ? ` ${g.code}` : ''}
                {hoist && <PartialFlag t={hoist} />}
              </div>
            )}
            {g.tiers.map((t, i) => line('rip', t, i, !!hoist))}
          </div>
        );
      })}
    </>
  );
}
