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
  // Always the prominent amber 'partial' style (red when expiring) — never the
  // subtle blue 'upcoming' — so a partial deal can't be overlooked.
  const cls = t.ts ? (wb?.urgent ? 'win-partial urgent' : 'win-partial') : (wb?.cls ?? 'win-partial');
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
  const disc = [...(cur?.discountTiers ?? [])].sort(byWindow);
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
    return `${t.qty} ${uw(t.unit)}`;
  };
  const line = (kind: 'qd' | 'rip', t: RipTier, i: number) => {
    const b = btlOf(t.eff);
    const off = frontline != null && t.eff < frontline ? frontline - t.eff : null;
    // RIP rows: the rebate ALONE (the RIP-sheet number), never rebate+QD mixed.
    const ripSave = kind === 'rip' ? (t.ripOnlySave ?? null) : null;
    return (
      <div key={`${kind}${i}`} className="prod-deal-line">
        <TierBadge kind={kind} />
        {/* Dated-window sticker sits LEFT (after the pill) so its variable
            length never drags a line's tail out and wrecks the column. */}
        <PartialFlag t={t} />{' '}
        Buy {buyLabel(t)} → <strong>${t.eff.toFixed(2)}/{csWord}</strong>
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
  const multiProgram = ripGroups.length > 1;

  return (
    <>
      {disc.map((t, i) => line('qd', t, i))}
      {ripGroups.map((g, gi) => (
        <div key={`rg${gi}`} className={multiProgram ? 'prod-rip-group' : undefined}>
          {multiProgram && (
            <div className="prod-rip-group-hdr" title="A separate RIP program for this product — pick the one that matches how much you buy. These do not stack.">
              RIP{g.code ? ` ${g.code}` : ''}
            </div>
          )}
          {g.tiers.map((t, i) => line('rip', t, i))}
        </div>
      ))}
    </>
  );
}
