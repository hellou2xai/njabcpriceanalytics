/**
 * QuantityPriceCurve — "what buying more cases does to your price".
 *
 * A step-line chart of the REAL effective price (per case and per bottle) at
 * each case quantity, driven by the SAME canonical CatalogTier rows (QD + RIP,
 * per UPC / vintage) that the size section's ladders render — so the chart can
 * never disagree with the inline deal numbers. Each tier's price_after IS the
 * achieved net price at that commitment, therefore:
 *
 *   effective(q) = min(frontline, min price_after over tiers whose threshold,
 *                      converted to cases, is <= q)
 *
 * The tooltip is the decision surface: price at this qty, total outlay, total
 * saved vs list, which deal earns it (with partial-month warnings straight
 * from the tier's validity window), and the next tier worth stretching to.
 * Transparent background by design — it sits directly on the page surface.
 */
import {
  ResponsiveContainer, ComposedChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ReferenceDot,
} from 'recharts';
import type { CatalogTier } from '../lib/api';
import { windowBadge, fmtDateRange } from '../lib/dealDates';
import TierBadge from './TierBadge';

const QD_COLOR = 'var(--accent)';
const CASE_COLOR = '#2563eb';
const BTL_COLOR = '#0d9488';
const LANDED_COLOR = '#d97706';   // the tier you actually land on at a given qty

interface CurvePoint {
  q: number;
  casePrice: number;            // BEST achievable price at <= q cases (the envelope)
  landedPrice: number;          // price of the tier you'd land on at EXACTLY q cases
  landedTier: CatalogTier | null;
  overpay: number;              // landedPrice - casePrice (>0 = over-committing costs more)
  btlPrice: number | null;
  isBreak: boolean;             // a tier threshold is crossed exactly at this qty
  active: CatalogTier | null;   // the tier earning the BEST price
  next: { tier: CatalogTier; atCases: number } | null;
  totalCost: number;
  totalSave: number;
  savePct: number;
}

function toCases(t: CatalogTier, pack: number | null): number {
  // ANY unit starting with 'b' is a bottle (Fedway uses a single "B");
  // /btl|bottle/ missed it and plotted bottle tiers at the wrong case position.
  const isBtl = /^\s*b/i.test(String(t.unit ?? ''));
  if (isBtl && pack && pack > 1) return t.qty / pack;
  return t.qty;
}

export function buildCurve(frontline: number | null, tiers: CatalogTier[],
                           pack: number | null): CurvePoint[] {
  if (frontline == null || frontline <= 0) return [];
  const usable = tiers
    .filter(t => t.price_after != null && t.price_after > 0)
    .map(t => ({ t, at: toCases(t, pack) }))
    .filter(x => x.at > 0)
    .sort((a, b) => a.at - b.at);
  if (usable.length === 0) return [];

  const maxTier = Math.ceil(usable[usable.length - 1].at);
  const maxQ = Math.max(maxTier + Math.max(1, Math.round(maxTier * 0.15)), 3);
  const points: CurvePoint[] = [];
  let prevPrice: number | null = null;
  for (let q = 1; q <= maxQ; q++) {
    const reached = usable.filter(x => x.at <= q);
    let casePrice = frontline;
    let active: CatalogTier | null = null;
    for (const x of reached) {
      if ((x.t.price_after as number) < casePrice) {
        casePrice = x.t.price_after as number;
        active = x.t;
      }
    }
    // The tier you'd LAND on committing exactly q cases = the one with the
    // deepest threshold you've reached (usable is sorted ascending by `at`, so
    // the last reached row). Its price can be HIGHER than the best (mix-RIP
    // tiers aren't monotonic) — that gap is the over-commitment overpay.
    const landedX = reached.length ? reached[reached.length - 1] : null;
    const landedPrice = landedX ? (landedX.t.price_after as number) : frontline;
    // The first tier past q that would IMPROVE on the current best price.
    const nxt = usable.find(x => x.at > q && (x.t.price_after as number) < casePrice);
    points.push({
      q,
      casePrice,
      landedPrice,
      landedTier: landedX ? landedX.t : null,
      overpay: Math.max(0, landedPrice - casePrice),
      btlPrice: pack && pack > 0 ? casePrice / pack : null,
      isBreak: prevPrice != null && casePrice < prevPrice - 0.005,
      active,
      next: nxt ? { tier: nxt.t, atCases: Math.ceil(nxt.at) } : null,
      totalCost: casePrice * q,
      totalSave: (frontline - casePrice) * q,
      savePct: frontline > 0 ? (frontline - casePrice) / frontline : 0,
    });
    prevPrice = casePrice;
  }
  return points;
}

const usd = (v: number, dp = 2) =>
  `$${v.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;

function TierLabel({ t }: { t: CatalogTier }) {
  const kind = t.source === 'rip' ? 'RIP' : 'QD';
  const wb = windowBadge(t);
  const range = fmtDateRange(t.from_date, t.to_date);
  return (
    <span>
      <TierBadge kind={t.source === 'rip' ? 'rip' : 'qd'} label={kind} />
      {' '}Buy {t.qty} {t.unit}
      {t.source === 'rip' && t.amount > 0 && <> · ${t.amount.toFixed(2)} rebate</>}
      {(t.is_time_sensitive || wb) && (
        <span className="qpc-warn"> ⏱ partial month{range ? ` (${range})` : ''}</span>
      )}
    </span>
  );
}

function CurveTooltip({ active, payload, sizeLabel }: {
  active?: boolean; payload?: { payload: CurvePoint }[]; sizeLabel?: string | null;
}) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="qpc-tip">
      <div className="qpc-tip-head">
        Buying <strong>{p.q} case{p.q === 1 ? '' : 's'}</strong>
        {sizeLabel ? <span className="text-muted"> · {sizeLabel}</span> : null}
      </div>
      <div className="qpc-tip-row">
        <span>Best at {p.q} cs</span><strong>{usd(p.casePrice)}</strong>
      </div>
      {p.overpay > 0.005 && (
        <div className="qpc-tip-row qpc-tip-warn">
          <span>This commitment's tier</span>
          <strong>{usd(p.landedPrice)} (+{usd(p.overpay)}/cs)</strong>
        </div>
      )}
      {p.btlPrice != null && (
        <div className="qpc-tip-row">
          <span>Per bottle</span><strong>{usd(p.btlPrice)}</strong>
        </div>
      )}
      <div className="qpc-tip-row">
        <span>Total outlay</span><strong>{usd(p.totalCost, 0)}</strong>
      </div>
      {p.totalSave > 0.005 ? (
        <div className="qpc-tip-row qpc-tip-save">
          <span>Saved vs list</span>
          <strong>{usd(p.totalSave, 0)} ({Math.round(p.savePct * 100)}%)</strong>
        </div>
      ) : (
        <div className="qpc-tip-row text-muted"><span>At list price — no deal reached yet</span></div>
      )}
      {p.active && (
        <div className="qpc-tip-deal">Earned by: <TierLabel t={p.active} /></div>
      )}
      {p.next && (
        <div className="qpc-tip-next">
          Next: +{p.next.atCases - p.q} more case{p.next.atCases - p.q === 1 ? '' : 's'} →{' '}
          <strong>{usd(p.next.tier.price_after as number)}/cs</strong>
          {' '}(save {usd(p.casePrice - (p.next.tier.price_after as number))}/cs more)
        </div>
      )}
    </div>
  );
}

export default function QuantityPriceCurve({ frontline, tiers, pack, sizeLabel }: {
  frontline: number | null;
  tiers: CatalogTier[];
  pack: number | null;
  sizeLabel?: string | null;
}) {
  const data = buildCurve(frontline, tiers, pack);
  if (data.length === 0) return null;
  const showBtl = pack != null && pack > 1;
  const breaks = data.filter(d => d.isBreak);

  return (
    <div className="qpc">
      <div className="qpc-title">
        Volume pricing
        <span className="text-muted"> — how the price falls as you commit more cases</span>
      </div>
      <ResponsiveContainer width="100%" height={210}>
        <ComposedChart data={data} margin={{ top: 8, right: showBtl ? 4 : 12, bottom: 2, left: 4 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} strokeOpacity={0.35} />
          <XAxis dataKey="q" tickFormatter={(v: number) => `${v}cs`}
                 fontSize={11} tickLine={false} axisLine={false} />
          <YAxis yAxisId="case" orientation="left" fontSize={11} tickLine={false} axisLine={false}
                 width={52} domain={['auto', 'auto']}
                 tickFormatter={(v: number) => `$${Math.round(v)}`} />
          {showBtl && (
            <YAxis yAxisId="btl" orientation="right" fontSize={11} tickLine={false} axisLine={false}
                   width={48} domain={['auto', 'auto']}
                   tickFormatter={(v: number) => `$${v.toFixed(v < 20 ? 2 : 0)}`} />
          )}
          <Tooltip content={<CurveTooltip sizeLabel={sizeLabel} />} cursor={{ strokeOpacity: 0.25 }} />
          <Line yAxisId="case" type="stepAfter" dataKey="casePrice" name="Best per case"
                stroke={CASE_COLOR} strokeWidth={2.25} dot={false} activeDot={{ r: 4 }}
                isAnimationActive={false} />
          {/* the tier you actually land on at each commitment — steps up AND down
              for non-monotonic mix-RIP tiers; the gap above the best line is the
              over-commitment overpay */}
          <Line yAxisId="case" type="stepAfter" dataKey="landedPrice" name="Tier at this qty"
                stroke={LANDED_COLOR} strokeWidth={1.75} strokeDasharray="5 3" dot={false}
                activeDot={{ r: 3.5 }} isAnimationActive={false} />
          {showBtl && (
            <Line yAxisId="btl" type="stepAfter" dataKey="btlPrice" name="Per bottle"
                  stroke={BTL_COLOR} strokeWidth={1.75} strokeDasharray="5 3" dot={false}
                  activeDot={{ r: 3.5 }} isAnimationActive={false} />
          )}
          {/* Mark every tier breakpoint so the cliffs are visible at a glance. */}
          {breaks.map(b => (
            <ReferenceDot key={b.q} yAxisId="case" x={b.q} y={b.casePrice} r={4}
                          fill={b.active?.source === 'rip' ? 'var(--green)' : QD_COLOR}
                          stroke="var(--surface)" strokeWidth={1.5} />
          ))}
        </ComposedChart>
      </ResponsiveContainer>
      <div className="qpc-legend">
        <span><i className="qpc-swatch" style={{ background: CASE_COLOR }} /> best per case</span>
        <span><i className="qpc-swatch qpc-swatch--dash" style={{ borderColor: LANDED_COLOR }} /> tier at this qty</span>
        {showBtl && <span><i className="qpc-swatch qpc-swatch--dash" style={{ borderColor: BTL_COLOR }} /> per bottle</span>}
        <span><i className="qpc-swatch qpc-dot" style={{ background: QD_COLOR }} /> QD tier</span>
        <span><i className="qpc-swatch qpc-dot" style={{ background: 'var(--green)' }} /> RIP tier</span>
      </div>
    </div>
  );
}
