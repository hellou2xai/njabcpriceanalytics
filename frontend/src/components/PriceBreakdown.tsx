import type { RipTier, DiscountTier } from '../lib/api';

/**
 * Decision-led price breakdown — reads like a receipt, not a chart.
 * One table per distributor column: List → every CPL discount tier → every RIP
 * tier (best of each flagged) → You pay, all per case AND per bottle, with a
 * "best buy" banner so the buying call (and which tier to hit) is obvious.
 */
export interface BreakdownSide {
  label: string;
  list: number;
  afterDiscount: number;   // best_case_price (list minus best CPL discount)
  effective: number;       // effective_case_price (afterDiscount minus best RIP)
  pack: number;            // bottles per case (unit_qty)
  ripTiers: RipTier[];
  discountTiers: DiscountTier[];
}

const m = (v: number) => `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
// Only meaningful when a case holds >1 bottle. Many SKUs are recorded as a
// single unit (pack = 1), where per-bottle == per-case — showing both is noise.
const perBtl = (v: number, pack: number) => (pack > 1 ? m(v / pack) : null);
const isBtl = (unit: string) => /^b/i.test(unit || '');

const ripKey = (t: RipTier) => `${t.qty}|${isBtl(t.unit) ? 'btl' : 'cs'}`;
const ripLabel = (t: RipTier) => `Buy ${t.qty} ${isBtl(t.unit) ? 'btl' : 'cs'}`;

// Discount tier: numeric `quantity` + `unit` ("Cases" | "Bottles").
const discKey = (t: DiscountTier) => `${t.quantity}|${isBtl(t.unit ?? '') ? 'btl' : 'cs'}`;
const discLabel = (t: DiscountTier) => `Buy ${t.quantity}+ ${isBtl(t.unit ?? '') ? 'btl' : 'cs'}`;

function parts(s: BreakdownSide) {
  const disc = Math.max(0, s.list - s.afterDiscount);
  const save = Math.max(0, s.list - s.effective);
  const pct = s.list > 0 ? (save / s.list) * 100 : 0;
  return { disc, save, pct };
}

// A total (List / You pay): case price with per-bottle underneath.
function Cell({ value, pack, tone }: { value: number; pack: number; tone?: string }) {
  const btl = perBtl(value, pack);
  return (
    <td className={tone}>
      <div>{m(value)}/cs</div>
      {btl && <div className="pb-btl">{btl}/btl</div>}
    </td>
  );
}

// A deduction step: the amount saved AND the running effective price you'd pay
// after applying it — both per case and per bottle.
function StepCell({ save, effective, pack, best, none }: {
  save: number; effective: number; pack: number; best?: boolean; none?: boolean;
}) {
  if (none) return <td className="pb-save-cell">—</td>;
  const sb = perBtl(save, pack);
  const eb = perBtl(effective, pack);
  return (
    <td className={`pb-step-cell ${best ? 'pb-tier-best' : ''}`}>
      <div className="pb-step-save">
        −{m(save)}/cs{sb ? ` · −${sb}/btl` : ''}{best && <span className="pb-best-flag">✓ best</span>}
      </div>
      <div className="pb-step-eff">→ {m(effective)}/cs{eb ? ` · ${eb}/btl` : ''}</div>
    </td>
  );
}

/** Merge a per-side list of tiers into a union of row-keys, with best-per-side. */
function mergeTiers<T>(
  sides: BreakdownSide[],
  pick: (s: BreakdownSide) => T[],
  keyOf: (t: T) => string,
  labelOf: (t: T) => string,
  saveOf: (t: T) => number,
) {
  const maps = sides.map(s => {
    const map = new Map<string, T>();
    for (const t of pick(s)) map.set(keyOf(t), t);
    return map;
  });
  const labelByKey = new Map<string, string>();
  for (const s of sides) for (const t of pick(s)) labelByKey.set(keyOf(t), labelOf(t));
  const keys = Array.from(labelByKey.keys()).sort((a, b) => {
    const [qa, ua] = a.split('|'); const [qb, ub] = b.split('|');
    return Number(qa) - Number(qb) || ua.localeCompare(ub);
  });
  const bestKeyPerSide = sides.map(s => {
    let key: string | null = null, bestSave = 0;
    for (const t of pick(s)) { if (saveOf(t) > bestSave) { bestSave = saveOf(t); key = keyOf(t); } }
    return key;
  });
  return { maps, labelByKey, keys, bestKeyPerSide };
}

export default function PriceBreakdown({ sides }: { sides: BreakdownSide[] }) {
  if (sides.length === 0) return null;
  const compare = sides.length > 1;
  const calcs = sides.map(parts);

  let winIdx = 0;
  sides.forEach((s, i) => { if (s.effective < sides[winIdx].effective) winIdx = i; });
  const others = sides.filter((_, i) => i !== winIdx);
  // Identify EVERY side that ties at the winning price (within 1 cent),
  // and the WORST side so the "best buy" narrative reads "X cheaper
  // than the worst", which is the spread the buyer actually cares
  // about — not the spread vs the next-closest side.
  const tol = 0.01;
  const tiedAtBestIdx = sides
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => Math.abs(s.effective - sides[winIdx].effective) < tol)
    .map(({ i }) => i);
  const worstEff = sides.reduce((a, c) => c.effective > a ? c.effective : a, sides[0].effective);
  const worstIdx = sides.findIndex(s => Math.abs(s.effective - worstEff) < tol);
  // "Tie" now means EVERY side is within tol of the winner. With Apr $24,
  // May $24, Jun $145.08 in the user's K JACK CHARD card, the partial
  // tie (Apr=May=$24, Jun=$145) used to read "Same effective cost
  // either way" because the old check looked at min(others) only. Now
  // it falls to the Best-buy banner that names BOTH tied-at-best sides
  // and quotes the gap vs the worst side.
  const tie = compare && (worstEff - sides[winIdx].effective) < tol;
  const gap = worstEff - sides[winIdx].effective;
  const pctLess = worstEff > 0 ? (gap / worstEff) * 100 : 0;
  const bestLabel = tiedAtBestIdx.length > 1
    ? tiedAtBestIdx.map(i => sides[i].label).join(' / ')
    : sides[winIdx].label;
  const worstLabel = worstIdx >= 0 ? sides[worstIdx].label : (others[0]?.label ?? '');

  const disc = mergeTiers(sides, s => s.discountTiers, discKey, discLabel, t => t.amount_per_case);
  const rip = mergeTiers(sides, s => s.ripTiers, ripKey, ripLabel, t => t.per_case_savings);
  const anyDisc = disc.keys.length > 0;
  const anyDiscFallback = !anyDisc && calcs.some(c => c.disc > 0); // closeout w/o tier rows

  return (
    <div className="price-breakdown">
      {compare && (
        <div className={`pb-banner ${tie ? 'pb-banner-tie' : ''}`}>
          {tie ? (
            <span>Same effective cost — <strong>{m(sides[winIdx].effective)}/case</strong> across all months</span>
          ) : (
            <span>
              ✓ Best buy: <strong>{bestLabel}</strong> — <strong>{m(sides[winIdx].effective)}/case</strong>
              {sides[winIdx].pack > 1 && <span className="pb-banner-sub"> ({m(sides[winIdx].effective / sides[winIdx].pack)}/btl)</span>}
              <span className="pb-banner-sub"> · {m(gap)} cheaper than {worstLabel} ({pctLess.toFixed(0)}% less)</span>
            </span>
          )}
        </div>
      )}
      <table className="pb-table">
        <thead>
          <tr>
            <th></th>
            {sides.map((s, i) => (
              <th key={s.label} className={compare && i === winIdx ? 'pb-win' : ''}>{s.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className="pb-label">List price</td>
            {sides.map(s => <Cell key={s.label} value={s.list} pack={s.pack} />)}
          </tr>

          {/* CPL discount — all tiers (each is an alternative threshold) */}
          {anyDisc && (
            <tr className="pb-section">
              <td className="pb-label" colSpan={sides.length + 1}>− CPL discount · all tiers (✓ = best, applied below)</td>
            </tr>
          )}
          {anyDisc && disc.keys.map(key => (
            <tr key={`d-${key}`} className="pb-sub pb-tier-row">
              <td className="pb-label pb-tier-label">{disc.labelByKey.get(key)}</td>
              {sides.map((s, i) => {
                const t = disc.maps[i].get(key);
                if (!t) return <StepCell key={i} none save={0} effective={0} pack={s.pack} />;
                const best = disc.bestKeyPerSide[i] === key;
                const eff = Math.max(0, s.list - t.amount_per_case); // discount is the first stage
                return <StepCell key={i} save={t.amount_per_case} effective={eff} pack={s.pack} best={best} />;
              })}
            </tr>
          ))}
          {anyDiscFallback && (
            <tr className="pb-sub">
              <td className="pb-label">− CPL discount</td>
              {calcs.map((c, i) => (
                <StepCell key={i} none={c.disc <= 0} save={c.disc} effective={sides[i].afterDiscount} pack={sides[i].pack} />
              ))}
            </tr>
          )}

          {/* RIP rebate — all tiers (stack on top of the best discount) */}
          {rip.keys.length > 0 && (
            <tr className="pb-section">
              <td className="pb-label" colSpan={sides.length + 1}>− RIP rebate · all tiers (stacks with discount; ✓ = best, applied below)</td>
            </tr>
          )}
          {rip.keys.map(key => (
            <tr key={`r-${key}`} className="pb-sub pb-tier-row">
              <td className="pb-label pb-tier-label">{rip.labelByKey.get(key)}</td>
              {sides.map((s, i) => {
                const t = rip.maps[i].get(key);
                if (!t) return <StepCell key={i} none save={0} effective={0} pack={s.pack} />;
                const best = rip.bestKeyPerSide[i] === key;
                // Running effective = list − best CPL discount − this RIP tier.
                const eff = Math.max(0, s.afterDiscount - t.per_case_savings);
                return <StepCell key={i} save={t.per_case_savings} effective={eff} pack={s.pack} best={best} />;
              })}
            </tr>
          ))}

          <tr className="pb-total">
            <td className="pb-label">Price after RIP</td>
            {sides.map((s, i) => (
              <Cell key={s.label} value={s.effective} pack={s.pack} tone={compare && i === winIdx && !tie ? 'pb-win' : ''} />
            ))}
          </tr>
          <tr className="pb-savings">
            <td className="pb-label">You save</td>
            {calcs.map((c, i) => (
              <td key={i}>{c.save > 0 ? `${m(c.save)} (${c.pct.toFixed(0)}%)` : '—'}</td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}
