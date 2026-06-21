import { useEffect, useMemo, useState, Fragment } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams, useNavigate, Link } from 'react-router-dom';
import {
  Percent, Zap, Sparkles, AlertTriangle, Clock, CalendarClock,
  TrendingDown, ChevronDown, ChevronRight, SlidersHorizontal, X, Trophy,
  HelpCircle, Tag, ExternalLink, Layers,
} from 'lucide-react';
import { compare } from '../lib/api';
import type { CompareQDRow, CompareQDDist } from '../lib/api';
import { distributorName, perUnitNoun, priceUnitWord, skuLabel } from '../lib/distributors';
import ProductSearchBox from '../components/ProductSearchBox';
import NextMonthChip from '../components/NextMonthChip';
import RowActions from '../components/RowActions';
import PriceSparklines from '../components/PriceSparklines';
import { ErrorState } from '../components/DataState';
import DataLoading from '../components/DataLoading';
import './CompareQD.css';

const money = (v?: number | null) => (v == null ? '-' : `$${Number(v).toFixed(2)}`);
const ACCENTS = ['#2563eb', '#d97706', '#7c3aed'];
const DEFAULT = ['allied', 'fedway'];

// show the vintage on the card only for wine-family products with a real vintage
const wineVintage = (type?: string | null, vintage?: string | null): string | null => {
  if (!vintage) return null;
  const v = String(vintage).trim();
  if (!v || ['0', 'nan', 'none', 'null'].includes(v.toLowerCase())) return null;
  const isWine = /wine|sparkling|vermouth|champagne|port|sherry/i.test(type || '');
  if (!isWine && !/^(19|20)\d{2}$|^nv$/i.test(v)) return null;  // year or NV
  return v.toUpperCase() === 'NV' ? 'NV' : v;
};

// full-page product detail deep link (same scheme as Products / ProductsGrid)
const detailUrl = (w: string, name?: string | null, upc?: string | null) => {
  const q = new URLSearchParams({ w, n: name || '' });
  if (upc) q.set('u', String(upc));
  return `/product?${q.toString()}`;
};

/* ---- a QD is a buy-more-save-more quantity discount: cash off the price you
   pay TODAY (no rebate comes back later). Everything here explains the QD in
   plain terms: what you pay, when the discount starts, how big it gets, how
   long it lasts, and who wins at the volume you actually plan to buy. ---- */

/** Stepped buy-$/case curve, one line per distributor. */
function QDCurve({ row, slugs, accent }: { row: CompareQDRow; slugs: string[]; accent: Record<string, string> }) {
  const pts = row.curve;
  const vals = pts.flatMap(p => slugs.map(w => p.landed[w])).filter((v): v is number => typeof v === 'number');
  if (pts.length < 2 || !vals.length) return null;
  const W = 460, H = 150, padX = 46, padY = 14;
  const maxC = pts[pts.length - 1].cases;
  const min = Math.min(...vals), max = Math.max(...vals);
  const span = Math.max(0.0001, max - min);
  const x = (c: number) => padX + (Math.min(c, maxC) / maxC) * (W - padX - 12);
  const y = (v: number) => padY + (1 - (v - min) / span) * (H - padY * 2);
  return (
    <div className="qd2-curve">
      <div className="qd2-sub-title">How your buy price per case drops as you buy more</div>
      <svg width={W} height={H + 18}>
        <text x={2} y={y(max) + 4} className="cmp-trend-tick">{money(max)}</text>
        <text x={2} y={y(min) + 4} className="cmp-trend-tick">{money(min)}</text>
        {pts.map(p => (
          <text key={p.cases} x={x(p.cases)} y={H + 13} textAnchor="middle" className="cmp-trend-tick">{p.cases}</text>
        ))}
        <text x={W / 2} y={H + 17} textAnchor="middle" className="cmp-trend-axis">cases you buy</text>
        {slugs.map(w => {
          const seq = pts.map(p => ({ c: p.cases, v: p.landed[w] })).filter((q): q is { c: number; v: number } => typeof q.v === 'number');
          if (seq.length < 2) return null;
          let d = `M${x(seq[0].c).toFixed(1)},${y(seq[0].v).toFixed(1)}`;
          for (let i = 1; i < seq.length; i++) d += ` H${x(seq[i].c).toFixed(1)} V${y(seq[i].v).toFixed(1)}`;
          return (
            <g key={w}>
              <path d={d} fill="none" stroke={accent[w]} strokeWidth={2} />
              {seq.map(q => <circle key={q.c} cx={x(q.c)} cy={y(q.v)} r={3} fill={accent[w]} />)}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** A small, discoverable info cue. */
function Info({ text }: { text: string }) {
  return (
    <span className="qd2-tip" title={text} tabIndex={0}>
      <HelpCircle size={11} className="qd2-tip-ico" />
    </span>
  );
}

function Metric({ icon, label, value, hint, tone }: {
  icon: React.ReactNode; label: string; value: React.ReactNode; hint: string; tone?: 'good' | 'warn';
}) {
  return (
    <div className={`qd2-metric${tone ? ` qd2-metric--${tone}` : ''}`} title={hint}>
      <span className="qd2-metric-ico">{icon}</span>
      <span className="qd2-metric-label">{label}<Info text={hint} /></span>
      <span className="qd2-metric-val">{value}</span>
    </div>
  );
}

// Total discount at a tier = per-case discount × cases-to-unlock (QD amount is
// per-case; this is the buyer-facing "total off" the chip shows).
const tierTotal = (t: { rebate_per_case: number | null; cases_to_unlock: number | null }): number | null =>
  t.rebate_per_case != null && t.cases_to_unlock != null
    ? +(t.rebate_per_case * t.cases_to_unlock).toFixed(2)
    : t.rebate_per_case;

/** Per-distributor panel for one product, in plain language. */
function DistPanel({ w, d, row, cases, accent, isWinner }: {
  w: string; d: CompareQDDist; row: CompareQDRow; cases: number; accent: string; isWinner: boolean;
}) {
  const pack = row.unit_qty ? parseFloat(row.unit_qty) : null;
  const unitNoun = perUnitNoun(d.unit_volume, d.unit_type);
  const caseWord = priceUnitWord(d.unit_volume, d.unit_type);
  const btl = (v?: number | null) => (v != null && pack ? `${money(v / pack)}/${unitNoun}` : null);
  const expiring = d.expires_in_days != null;

  // QD DIFFERENCE highlight: a tier is "common" when EVERY distributor has the
  // same buy-in + unit + total discount AND the same VALIDITY (a tier that runs
  // all month is NOT the same as the same discount only live for 2 days). Tiers
  // NOT common to all are the actual QD difference — yellow bg / red font.
  const tierKey = (t: { cases_to_unlock: number | null; unit: string | null; rebate_per_case: number | null;
    is_time_sensitive?: boolean; from_date?: string | null; to_date?: string | null }) =>
    `${t.cases_to_unlock ?? ''}|${(t.unit ?? '').toLowerCase().startsWith('b') ? 'b' : 'c'}|` +
    `${t.rebate_per_case != null ? Math.round(t.rebate_per_case * 100) : ''}|` +
    `${t.is_time_sensitive ? `ts:${t.from_date ?? ''}~${t.to_date ?? ''}` : 'all'}`;
  const allDists = Object.values(row.dists);
  const commonTierKeys = allDists.length > 1
    ? allDists
        .map(dd => new Set((dd.qd_tiers ?? []).map(tierKey)))
        .reduce((acc, s) => new Set([...acc].filter(k => s.has(k))))
    : new Set<string>();
  const isDiffTier = (t: typeof d.qd_tiers[number]) =>
    allDists.length > 1 && !commonTierKeys.has(tierKey(t));

  // total cash you actually outlay at this volume, here vs the competition
  const myTotal = d.landed_at_n != null ? d.landed_at_n * cases : null;
  const rivals = Object.entries(row.dists)
    .filter(([k, dd]) => k !== w && dd.landed_at_n != null)
    .map(([k, dd]) => ({ name: distributorName(k), total: (dd.landed_at_n as number) * cases }));
  const cheapestRival = rivals.length ? rivals.reduce((a, b) => (a.total <= b.total ? a : b)) : null;
  const vsText = myTotal != null
    ? (cheapestRival
        ? `Total to buy ${cases} case${cases !== 1 ? 's' : ''} here: ${money(myTotal)}. ` +
          `Cheapest rival (${cheapestRival.name}): ${money(cheapestRival.total)}. ` +
          (myTotal <= cheapestRival.total
            ? `You save ${money(cheapestRival.total - myTotal)} overall by going here.`
            : `You'd pay ${money(myTotal - cheapestRival.total)} more here.`)
        : `Total to buy ${cases} case${cases !== 1 ? 's' : ''} here: ${money(myTotal)}.`)
    : '';
  // Front headline = the discounted CASH buy price after a single-case QD.
  // For a pure-QD board this is just landed_at_1 (no RIP to strip out).
  const buy1cs = d.landed_at_1 ?? d.frontline;
  const buy1csHint =
    `Cash buy price per case after a single-case quantity discount` +
    (d.frontline != null ? ` (list ${money(d.frontline)}/case)` : '') +
    `. The discount is cash off TODAY — see the tier ladder and the net buy price below.`;
  const priceHint =
    `Your buy cost per case after the best quantity discount you qualify for at ${cases} case${cases !== 1 ? 's' : ''}. ` +
    (d.frontline != null ? `List is ${money(d.frontline)}/case` : '') +
    (d.qd_at_n ? `; the QD takes off ${money(d.qd_at_n)}/case.` : '.') +
    (myTotal != null ? ` That is ${money(myTotal)} total for ${cases} case${cases !== 1 ? 's' : ''}.` : '');

  return (
    <div className={`qd2-dist${isWinner ? ' is-winner' : ''}`} style={{ borderTopColor: accent }}>
      <div className="qd2-dist-head">
        <span className="qd2-dist-name">{distributorName(w)}</span>
        {isWinner && (
          <span className="qd2-best-tag" title={vsText}>
            <Trophy size={11} /> lowest price at {cases} cs <HelpCircle size={10} className="qd2-tip-ico" />
          </span>
        )}
      </div>
      {/* each distributor's own size + barcode, so you can see it's like-for-like */}
      <div className="qd2-dist-size"
        title="Products are matched by exact barcode, bottle size and bottles-per-case, so this is a like-for-like comparison.">
        {(d.unit_qty ?? row.unit_qty)} × {(d.unit_volume ?? row.unit_volume)}
        {wineVintage(row.product_type, d.vintage ?? row.vintage) && (
          <span className="qd2-dist-vintage"
            title="This distributor's vintage. Wine is matched by vintage, so both distributors are the same year.">
            {' · '}{wineVintage(row.product_type, d.vintage ?? row.vintage)}
          </span>
        )}
        {d.upc && <span className="qd2-dist-upc"> · UPC {d.upc}</span>}
        {d.item_no && (
          <span className="qd2-dist-itemno" title={`${distributorName(w)} ${skuLabel(w)}`}>
            {' · '}{skuLabel(w)} {d.item_no}
          </span>
        )}
      </div>
      {/* open this distributor's exact product to verify the price and the facts */}
      {d.product_name && (
        <Link className="qd2-dist-link" to={detailUrl(w, d.product_name, d.upc)}
          target="_blank" rel="noopener noreferrer"
          onClick={e => e.stopPropagation()}
          title={`Open ${distributorName(w)}'s "${d.product_name}" to verify the price and details`}>
          {d.product_name} <ExternalLink size={11} />
        </Link>
      )}

      <div className="qd2-dist-spark">
        <PriceSparklines wholesaler={w} productName={d.product_name ?? row.product_name}
          upc={d.upc} unitVolume={d.unit_volume ?? row.unit_volume}
          unitQty={d.unit_qty ?? row.unit_qty} vintage={d.vintage ?? row.vintage} />
      </div>

      {/* the headline: the discounted CASH buy price after a 1-case quantity discount. */}
      <div className="qd2-dist-price" title={buy1csHint}>
        {money(buy1cs)}<span className="qd2-per">/{caseWord}</span>
        {btl(buy1cs) && <span className="qd2-dist-btl">{btl(buy1cs)}</span>}
        <Info text={buy1csHint} />
      </div>
      <div className="qd2-dist-pricenote">
        buy price after 1-case QD
        {d.landed_at_n != null && (
          <span className="qd2-dist-total" title={priceHint}>
            {' · '}net {money(d.landed_at_n)}/cs at {cases} cs{myTotal != null ? ` (${money(myTotal)} total)` : ''}
          </span>
        )}
      </div>
      {/* ALL QD tiers up front in a single ladder (a QD has one discount ladder
          — no RIP code grouping). Each chip is buy-in → TOTAL $ off. */}
      {(() => {
        const tiers = (d.qd_tiers ?? []).slice()
          .sort((a, b) => (a.cases_to_unlock ?? 1e9) - (b.cases_to_unlock ?? 1e9));
        if (!tiers.length) return null;
        return (
          <div className="qd2-dist-tiers">
            {tiers.map((t, i) => {
              // Total off at this tier = per-case discount × cases-to-unlock
              // (QD amount is per-case; this is the buyer-facing "total off").
              const totalOff = tierTotal(t);
              const diff = isDiffTier(t);
              const win = t.is_time_sensitive && t.from_date && t.to_date
                ? `${t.from_date.slice(5)}–${t.to_date.slice(5)}` : null;
              return (
                <span key={i} className={`qd2-tier-chip${t.is_time_sensitive ? ' is-ts' : ''}${diff ? ' is-diff' : ''}`}
                  title={`Buy ${t.buy_label ?? `${t.raw_qty} ${t.unit ?? ''}`} → ${money(totalOff)} off total (${money(t.rebate_per_case)}/cs)${t.price_after != null ? ` · net ${money(t.price_after)}/cs` : ''}${t.is_time_sensitive ? ` · time-limited${win ? ` (valid ${win})` : ''}` : ' · valid all month'}${diff ? ' · differs from the other distributor' : ''}`}>
                  {t.buy_label ?? `${t.raw_qty}${(t.unit ?? '').toLowerCase().startsWith('b') ? 'btl' : 'cs'}`}
                  {' → '}<strong>{money(totalOff)}</strong>
                  {win && <span className="qd2-tier-win"> · {win}</span>}
                </span>
              );
            })}
          </div>
        );
      })()}
      <NextMonthChip current={d.landed_at_n} next={d.next_net_case} edition={d.edition} />
      {/* Two price layers: List, then the price AFTER the quantity discount
          (= what you pay). Shows the running price plus the amount it took off. */}
      {d.frontline != null && (() => {
        const net = d.landed_at_n;
        const off = net != null ? d.frontline! - net : null;
        const pb = (v?: number | null) => (v != null && pack ? `${money(v / pack)}/${unitNoun}` : null);
        const bdHint =
          `List (sticker) price ${money(d.frontline)}/case (${pb(d.frontline)})` +
          (off != null && off > 0.005 ? `. After the ${money(off)}/case quantity discount: ${money(net)}/case (${pb(net)})` : '') +
          (net != null ? ` (what you pay buying ${cases} case${cases !== 1 ? 's' : ''}).` : '.');
        return (
          <div className="qd2-dist-breakdown" title={bdHint}>
            <Tag size={11} />
            <span>List {money(d.frontline)}{pb(d.frontline) && <span className="qd2-bd-btl">{pb(d.frontline)}</span>}</span>
            {net != null && off != null && off > 0.005 && (
              <span className="qd2-bd-step" title="Price after the distributor's quantity (case) discount. This is what you pay.">
                <span className="qd2-bd-arrow">→</span> after QD <strong>{money(net)}</strong>
                {pb(net) && <span className="qd2-bd-btl">{pb(net)}</span>}
                <span className="qd2-bd-d">(-{money(off)})</span>
              </span>
            )}
            {(off == null || off <= 0.005) && net != null && (
              <span className="qd2-bd-step"><span className="qd2-bd-arrow">→</span> pay <strong>{money(net)}</strong>
                {pb(net) && <span className="qd2-bd-btl">{pb(net)}</span>}</span>
            )}
            <Info text={bdHint} />
          </div>
        );
      })()}

      {/* the clarity sticker: buy these cases at the discounted price, saving this much. */}
      {d.unlock_cases != null && d.unlock_investment != null && (
        <div className="qd2-unlock"
          title={`To claim ${distributorName(w)}'s first quantity discount you buy ${d.unlock_cases} case${d.unlock_cases !== 1 ? 's' : ''} at the discounted price, paying ${money(d.unlock_investment)}. That is ${money(d.unlock_savings)} less than the list price for those cases.`}>
          <Zap size={12} />
          <span>Unlock the QD: buy <strong>{d.unlock_cases} cs</strong>, pay <strong>{money(d.unlock_investment)}</strong></span>
          <span className="qd2-unlock-back">save {money(d.unlock_savings)}</span>
        </div>
      )}

      <div className="qd2-metrics">
        <Metric icon={<TrendingDown size={13} />} label="Just 1 case"
          value={money(d.landed_at_1)}
          hint="What you'd pay per case if you only bought a single case (the small-buyer price)." />
        <Metric icon={<Zap size={13} />} label="QD starts at"
          value={d.min_cases ? `${d.min_cases} cs` : 'no QD'}
          hint="The fewest cases you must buy before any quantity discount kicks in. Lower means less money down to start saving." />
        <Metric icon={<Trophy size={13} />} label="Best QD / case"
          value={d.deepest_discount
            ? `${money(d.deepest_discount)}/cs${d.deepest_at_cases && d.deepest_at_cases > 1 ? ` at ${d.deepest_at_cases}cs` : ''}`
            : '-'}
          hint={d.deepest_at_cases && d.deepest_at_cases > 1
            ? `The largest quantity discount on this product is ${money(d.deepest_discount)} off each case, but only once you buy ${d.deepest_at_cases} cases. At a smaller order you get less per case.`
            : `The largest quantity discount on this product: ${money(d.deepest_discount)} off each case.`} />
        <Metric icon={<CalendarClock size={13} />} label="QD runs"
          value={`${d.active_days ?? 0} days`}
          hint={`How many days this month this distributor has a quantity discount live on this product. More days = easier to time your buy.`} />
        {expiring && (
          <Metric icon={<Clock size={13} />} label="Ends in"
            value={`${d.expires_in_days} day${d.expires_in_days === 1 ? '' : 's'}`}
            tone="warn"
            hint="This quantity discount is a limited-time deal that ends soon. Buy before it expires or the price goes back up." />
        )}
        {d.has_upcoming && !expiring && (
          <Metric icon={<CalendarClock size={13} />} label="Bigger deal soon"
            value="starts later"
            hint="A deeper quantity discount on this product starts later this month. It may be worth waiting." />
        )}
      </div>
    </div>
  );
}

function QDDetail({ row, slugs, accent, cases }: { row: CompareQDRow; slugs: string[]; accent: Record<string, string>; cases: number }) {
  void cases;
  return (
    <div className="qd2-detail">
      <div className="qd2-detail-charts">
        <QDCurve row={row} slugs={slugs} accent={accent} />
        <div className="qd2-breakeven">
          <div className="qd2-sub-title">Who has the lowest buy price per case at each amount you might buy</div>
          <div className="qd2-be-rows">
            {row.breakeven.filter(b => b.winner).map((b, i) => (
              <span key={i} className="qd2-be">
                {b.from}{b.to ? `-${b.to}` : '+'} cs:{' '}
                <strong style={{ color: b.winner !== 'tie' ? accent[b.winner!] : 'var(--text-muted)' }}>
                  {b.winner === 'tie' ? 'tie' : distributorName(b.winner!)}
                </strong>
              </span>
            ))}
          </div>
        </div>
      </div>
      <div className="qd2-ladders" style={{ gridTemplateColumns: `repeat(${slugs.length}, 1fr)` }}>
        {slugs.map(w => {
          const d = row.dists[w];
          return (
            <div key={w} className="qd2-ladder">
              <div className="qd2-ladder-head" style={{ color: accent[w] }}>{distributorName(w)}: every QD tier</div>
              <table className="qd2-tier-table">
                <thead><tr><th>Buy</th><th>$ off / case</th><th>Price / case</th><th>When</th></tr></thead>
                <tbody>
                  {d.qd_tiers.length === 0 && <tr><td colSpan={4} className="qd2-none">no QD tiers</td></tr>}
                  {d.qd_tiers.map((t, i) => (
                    <tr key={i}>
                      <td>{t.buy_label ?? `${t.cases_to_unlock ?? t.raw_qty} cs`}</td>
                      <td className="text-green">{t.rebate_per_case != null ? `-${money(t.rebate_per_case)}` : '-'}</td>
                      <td><strong>{money(t.price_after)}</strong></td>
                      <td>{t.is_time_sensitive && t.window_status !== 'expired'
                        ? <span className="qd2-tier-when">{t.from_date?.slice(5)}→{t.to_date?.slice(5)}</span>
                        : <span className="text-muted">all month</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Compact side-by-side table: one row per product, each distributor's buy
 *  price per case at the chosen volume (winner highlighted), the gap, the total
 *  saving, and what actually DIFFERS about the QD. */
function QDTable({ rows, selected, accent, cases, expanded, setExpanded, goToProduct }: {
  rows: CompareQDRow[]; selected: string[]; accent: Record<string, string>; cases: number;
  expanded: string | null; setExpanded: (k: string | null) => void;
  goToProduct: (name: string, w?: string) => void;
  editions?: Record<string, string>;
}) {
  const ncols = selected.length + 5;
  return (
    <div className="table-container">
      <table className="dense-table qd2-table">
        <thead>
          <tr>
            <th className="qd2-th-prod">Product</th>
            {selected.map(w => (
              <th key={w} className="qd2-th-dist" style={{ borderBottomColor: accent[w] }}>
                <span style={{ color: accent[w] }}>{distributorName(w)}</span>
                <span className="qd2-th-sub">$/cs at {cases}cs · QD unlock</span>
              </th>
            ))}
            <th className="qd2-th-num">Gap/cs</th>
            <th className="qd2-th-num">Save @{cases}cs</th>
            <th>What differs</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => {
            const win = r.winner_at_n;
            const landeds = selected.map(w => r.dists[w]?.landed_at_n)
              .filter((v): v is number => v != null).sort((a, b) => a - b);
            const gapPerCase = landeds.length >= 2 ? +(landeds[1] - landeds[0]).toFixed(2) : 0;
            const lessTotal = +(gapPerCase * cases).toFixed(2);
            const isOpen = expanded === r.match_key;
            const diffs: React.ReactNode[] = [];
            if (r.flips) diffs.push(<span key="f" className="qd2-tchip qd2-tchip-flip" title="Which distributor is cheapest changes with how many cases you buy."><Zap size={10} /> winner flips</span>);
            if (r.timing_differs) diffs.push(<span key="t" className="qd2-tchip" title="One runs the discount all month, the other only on certain dates."><CalendarClock size={10} /> timing</span>);
            if (r.quantity_differs) diffs.push(<span key="q" className="qd2-tchip" title="Distributors differ on how many cases unlock the discount."><Layers size={10} /> unlock qty</span>);
            if (!r.proof_match) diffs.push(<span key="p" className="qd2-tchip qd2-tchip-warn" title="The distributors list different proof/ABV for this barcode. Check it's the same item."><AlertTriangle size={10} /> proof differs</span>);
            const actW = win && win !== 'tie' ? win : selected[0];
            return (
              <Fragment key={r.match_key}>
                <tr className={`qd2-trow${isOpen ? ' is-open' : ''}`} onClick={() => setExpanded(isOpen ? null : r.match_key)}>
                  <td className="qd2-td-prod">
                    <span className="qd2-td-caret">{isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
                    <span className="qd2-td-prodbody">
                      <button className="qd2-td-name" onClick={e => { e.stopPropagation(); goToProduct(r.dists[actW]?.product_name ?? r.product_name, actW); }}>{r.product_name}</button>
                      <span className="qd2-td-sub">{r.unit_qty} × {r.unit_volume}{wineVintage(r.product_type, r.vintage) ? ` · ${wineVintage(r.product_type, r.vintage)}` : ''}</span>
                    </span>
                  </td>
                  {selected.map(w => {
                    const d = r.dists[w];
                    return (
                      <td key={w} className="qd2-td-price">
                        <span className={win === w ? 'hl-best' : 'qd2-td-pricev'}>{money(d?.landed_at_n)}</span>
                        <span className="qd2-td-pricesub">{d?.min_cases ? `from ${d.min_cases} cs` : 'no QD'}</span>
                      </td>
                    );
                  })}
                  <td className="qd2-td-num">{gapPerCase > 0 ? money(gapPerCase) : <span className="text-muted">tie</span>}</td>
                  <td className="qd2-td-num">{lessTotal > 0 ? money(lessTotal) : <span className="text-muted">-</span>}</td>
                  <td className="qd2-td-diff">{diffs.length ? diffs : <span className="text-muted">price only</span>}</td>
                  <td className="qd2-td-act" onClick={e => e.stopPropagation()}>
                    <RowActions productName={r.dists[actW]?.product_name ?? r.product_name}
                      wholesaler={actW} upc={r.dists[actW]?.upc ?? undefined}
                      unitVolume={r.unit_volume ?? undefined} unitQty={r.unit_qty ?? undefined} />
                  </td>
                </tr>
                {isOpen && (
                  <tr className="qd2-trow-detail">
                    <td colSpan={ncols}>
                      <QDDetail row={r} slugs={selected} accent={accent} cases={cases} />
                      <div className="qd2-plain" title="A plain-language recommendation based on all the numbers above.">
                        <Sparkles size={12} /> {r.verdict.text}
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function CompareQD() {
  const [params, setSearchParams] = useSearchParams();
  const [selected, setSelected] = useState<string[]>(params.get('d')?.split(',').filter(Boolean) ?? DEFAULT);
  // Comparison volume — fixed at 5 cases; overridable via ?cases= for power users.
  const [cases] = useState(parseInt(params.get('cases') ?? '5', 10) || 5);
  const [q, setQ] = useState(params.get('q') ?? '');
  const [ptype, setPtype] = useState(params.get('type') ?? '');
  const [size, setSize] = useState(params.get('size') ?? '');
  const [brand, setBrand] = useState(params.get('brand') ?? '');
  // "QD Difference" is the headline filter and ON by default: only show products
  // where the discount itself differs between distributors (timing, cases-to-
  // unlock, or the per-case discount), not just the price. (URL: qddiff=0 = off.)
  const [qdDiff, setQdDiff] = useState(params.get('qddiff') !== '0');
  const [view, setView] = useState<'cards' | 'table'>(params.get('view') === 'table' ? 'table' : 'cards');
  const [minDiff, setMinDiff] = useState(params.get('min_diff') != null ? Math.max(0, parseFloat(params.get('min_diff')!) || 0) : 0);
  const [tsOnly, setTsOnly] = useState(params.get('ts') === '1');
  const [expiringOnly, setExpiringOnly] = useState(params.get('exp') === '1');
  const [timingDiff, setTimingDiff] = useState(params.get('timing') === '1');
  const [showAnomalies, setShowAnomalies] = useState(params.get('anom') === '1');
  const [sort, setSort] = useState(params.get('sort') ?? 'spread');
  const [monthMode, setMonthMode] = useState(params.get('month') === 'next' ? 'next' : 'cur');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [shown, setShown] = useState(40);
  const [railOpen, setRailOpen] = useState(true);
  const navigate = useNavigate();
  const goToProduct = (name: string, wholesaler?: string) =>
    navigate(`/products?q=${encodeURIComponent(name)}${wholesaler ? `&wholesaler=${wholesaler}` : ''}`);

  useEffect(() => {
    const next = new URLSearchParams();
    if (selected.length) next.set('d', selected.join(','));
    if (cases !== 5) next.set('cases', String(cases));
    if (q) next.set('q', q);
    if (ptype) next.set('type', ptype);
    if (size) next.set('size', size);
    if (brand) next.set('brand', brand);
    if (!qdDiff) next.set('qddiff', '0');
    if (view === 'table') next.set('view', 'table');
    if (minDiff > 0) next.set('min_diff', String(minDiff));
    if (tsOnly) next.set('ts', '1');
    if (expiringOnly) next.set('exp', '1');
    if (timingDiff) next.set('timing', '1');
    if (showAnomalies) next.set('anom', '1');
    if (sort !== 'spread') next.set('sort', sort);
    if (monthMode === 'next') next.set('month', 'next');
    if (next.toString() !== params.toString()) setSearchParams(next, { replace: true });
  }, [selected, cases, q, ptype, size, brand, qdDiff, view, minDiff, tsOnly, expiringOnly, timingDiff, showAnomalies, sort, monthMode]);

  const { data: options } = useQuery({ queryKey: ['compare-options'], queryFn: compare.options });
  const ready = selected.length >= 2 && selected.length <= 3;
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['compare-qds', selected, cases, q, ptype, brand, qdDiff, minDiff, tsOnly, expiringOnly, timingDiff, showAnomalies, sort, monthMode],
    queryFn: () => compare.qds({
      wholesalers: selected.join(','), cases, q: q || undefined,
      product_type: ptype || undefined, brand: brand || undefined,
      qd_diff_only: qdDiff || undefined, min_diff: minDiff,
      time_sensitive_only: tsOnly || undefined,
      expiring_only: expiringOnly || undefined,
      timing_diff_only: timingDiff || undefined,
      include_anomalies: showAnomalies || undefined, sort,
      month_mode: monthMode,
    }),
    enabled: ready,
  });

  const accent = useMemo(() => {
    const m: Record<string, string> = {};
    selected.forEach((w, i) => { m[w] = ACCENTS[i % ACCENTS.length]; });
    return m;
  }, [selected]);
  const toggle = (w: string) => {
    setExpanded(null); setShown(40);
    setSelected(s => s.includes(w) ? s.filter(x => x !== w) : s.length >= 3 ? s : [...s, w]);
  };
  const types = useMemo(() => {
    const set = new Set<string>();
    (data?.rows ?? []).forEach(r => { if (r.product_type) set.add(r.product_type); });
    return [...set].sort();
  }, [data]);
  const sizes = useMemo(() => {
    const set = new Set<string>();
    (data?.rows ?? []).forEach(r => { if (r.unit_volume) set.add(r.unit_volume); });
    return [...set].sort();
  }, [data]);

  const rows = useMemo(
    () => (data?.rows ?? []).filter(r => !size || (r.unit_volume ?? '') === size),
    [data, size]);
  const sum = data?.summary;

  return (
    <div className="page qd2-page">
      <div className="qd2-top">
        <h2><Percent size={20} style={{ verticalAlign: '-3px', marginRight: 8 }} />Compare QD</h2>
        <p className="qd2-lede">
          A quantity discount (QD) is buy-more-save-more: cash off the price you pay
          TODAY. The same bottle can discount very differently at each distributor.
          See who actually costs less, when the discount starts, how big it gets,
          and how long it lasts.
        </p>
      </div>

      <div className={`qd2-layout${railOpen ? '' : ' rail-closed'}`}>
        {/* ---- collapsible left filter rail ---- */}
        {railOpen ? (
          <aside className="qd2-rail">
            <div className="qd2-rail-head">
              <span><SlidersHorizontal size={15} /> Filters</span>
              <button className="qd2-rail-x" onClick={() => setRailOpen(false)} title="Hide filters"><X size={15} /></button>
            </div>

            <div className="qd2-rail-sect">
              <div className="qd2-rail-label">Sort by</div>
              <select value={sort} onChange={e => setSort(e.target.value)} className="qd2-select">
                <option value="spread">Biggest price gap</option>
                <option value="left_on_table">Biggest total saving</option>
                <option value="min_cases">Easiest to unlock (fewest cases)</option>
                <option value="least_investment">Least cash to unlock</option>
                <option value="best1">Best 1-case deal</option>
                <option value="deepest">Biggest discount</option>
                <option value="active_days">Most days available</option>
                <option value="product">Product name</option>
              </select>
            </div>

            <div className="qd2-rail-sect">
              <div className="qd2-rail-label">Month</div>
              <div className="qd2-monthtoggle">
                <button className={`qd2-monthbtn${monthMode === 'cur' ? ' on' : ''}`}
                  onClick={() => { setMonthMode('cur'); setShown(40); }}>This month</button>
                <button className={`qd2-monthbtn${monthMode === 'next' ? ' on' : ''}`}
                  disabled={!data?.next_available && monthMode !== 'next'}
                  title={data?.next_available === false ? 'Next month’s prices are not loaded yet.' : 'Compare QDs at next month’s edition.'}
                  onClick={() => { setMonthMode('next'); setShown(40); }}>Next month</button>
              </div>
              {monthMode === 'next' && (
                <div className="qd2-rail-help">Comparing NEXT month’s QDs where that edition is loaded (else this month).</div>
              )}
            </div>

            <div className="qd2-rail-sect">
              <div className="qd2-rail-label">Distributors to compare (2-3)</div>
              <div className="qd2-chips">
                {(options ?? []).map(o => (
                  <button key={o.wholesaler}
                    className={`qd2-chip${selected.includes(o.wholesaler) ? ' on' : ''}`}
                    style={selected.includes(o.wholesaler) ? { borderColor: accent[o.wholesaler], color: accent[o.wholesaler] } : undefined}
                    onClick={() => toggle(o.wholesaler)}
                    disabled={!selected.includes(o.wholesaler) && selected.length >= 3}>
                    {distributorName(o.wholesaler)}
                  </button>
                ))}
              </div>
            </div>

            <div className="qd2-rail-sect">
              <div className="qd2-rail-label">Search</div>
              <ProductSearchBox value={q} placeholder="Product or brand…"
                onChange={v => { setQ(v); setShown(40); }}
                onSelect={p => { setQ(p.product_name); setShown(40); }} />
            </div>

            <div className="qd2-rail-sect">
              <div className="qd2-rail-label">Category</div>
              <select value={ptype} onChange={e => setPtype(e.target.value)} className="qd2-select">
                <option value="">All categories</option>
                {types.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>

            <div className="qd2-rail-sect">
              <div className="qd2-rail-label">Size</div>
              <select value={size} onChange={e => { setSize(e.target.value); setShown(40); }} className="qd2-select">
                <option value="">All sizes</option>
                {sizes.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>

            <div className="qd2-rail-sect">
              <div className="qd2-rail-label">Brand</div>
              <input className="qd2-input" placeholder="e.g. Tito's" value={brand}
                onChange={e => { setBrand(e.target.value); setShown(40); }} />
            </div>

            <div className="qd2-rail-sect">
              <div className="qd2-rail-label">Minimum price gap</div>
              <div className="qd2-mindiff">
                <span className="qd2-mindiff-cur">$</span>
                <input className="qd2-mindiff-in" type="number" min={0} step={0.5} value={minDiff}
                  onChange={e => { setMinDiff(Math.max(0, parseFloat(e.target.value) || 0)); setShown(40); }} />
                <span className="qd2-mindiff-unit">/ case</span>
              </div>
              <div className="qd2-rail-help">
                Only show products where the lowest-price distributor beats the rest by at
                least this much per case at {cases} case{cases !== 1 ? 's' : ''}. Set to $0 to show every match.
              </div>
            </div>

            <div className="qd2-rail-sect">
              <div className="qd2-rail-label">QD Difference</div>
              <label className="qd2-toggle" title="On by default. Shows only products where the quantity discount itself differs between distributors: timing, the cases needed to unlock it, or the per-case discount. Turn off to see every product they all carry a QD on, including the ones where only the price differs.">
                <input type="checkbox" checked={qdDiff} onChange={e => { setQdDiff(e.target.checked); setShown(40); }} /> Only show QD differences
              </label>
              <div className="qd2-rail-help">On shows only where the QD differs (not just the price). Off shows every shared-QD product.</div>
            </div>

            <div className="qd2-rail-sect">
              <div className="qd2-rail-label">Show only</div>
              <label className="qd2-toggle" title="Only products where a distributor's QD is a limited-time deal.">
                <input type="checkbox" checked={tsOnly} onChange={e => setTsOnly(e.target.checked)} /> Time-limited QDs
              </label>
              <label className="qd2-toggle" title="Only products where a QD ends this month (buy-now urgency).">
                <input type="checkbox" checked={expiringOnly} onChange={e => setExpiringOnly(e.target.checked)} /> Ending soon
              </label>
            </div>

            <div className="qd2-rail-sect">
              <div className="qd2-rail-label">Compare beyond price</div>
              <label className="qd2-toggle" title="Only products where the distributors differ on QD timing: one runs all month, the other is a dated/limited deal.">
                <input type="checkbox" checked={timingDiff} onChange={e => setTimingDiff(e.target.checked)} /> QD timing differs
              </label>
              <label className="qd2-toggle" title="Show rows flagged as likely data issues: the same barcode priced very differently at each distributor, usually a pack-size mismatch.">
                <input type="checkbox" checked={showAnomalies} onChange={e => setShowAnomalies(e.target.checked)} /> Show possible data issues
              </label>
            </div>

          </aside>
        ) : (
          <button className="qd2-rail-open" onClick={() => setRailOpen(true)} title="Show filters">
            <SlidersHorizontal size={15} /><span>Filters</span>
          </button>
        )}

        {/* ---- main ---- */}
        <div className="qd2-main">
          {!ready && (
            <div className="cmp-empty">
              Pick two or three distributors in the filters to compare how their quantity
              discounts play out on the products they all carry.
            </div>
          )}
          {ready && isLoading && <DataLoading label="Comparing quantity discounts…" />}
          {ready && isError && <ErrorState message={String((error as Error)?.message ?? '') || undefined} retry={() => refetch()} />}

          {ready && data && (
            <>
              <div className="qd2-cards">
                <div className="qd2-scard">
                  <div className="qd2-scard-n">{data.total_common.toLocaleString()}</div>
                  <div className="qd2-scard-l">products all of them offer a QD on</div>
                </div>
                {selected.map(w => (
                  <div className="qd2-scard" key={w} style={{ borderTop: `3px solid ${accent[w]}` }}>
                    <div className="qd2-scard-n">{sum?.wins_at_n[w] ?? 0}</div>
                    <div className="qd2-scard-l">{distributorName(w)} has the lowest price/case at {cases} cs</div>
                  </div>
                ))}
                <div className="qd2-scard">
                  <div className="qd2-scard-n"><Zap size={15} style={{ verticalAlign: '-2px' }} /> {sum?.flips ?? 0}</div>
                  <div className="qd2-scard-l">change winner as you buy more</div>
                </div>
              </div>

              {!!sum?.insights?.length && (
                <div className="qd2-insights">
                  {sum.insights.map((t, i) => <div key={i} className="qd2-insight">💡 {t}</div>)}
                </div>
              )}

              <div className="qd2-listbar">
                <div className="qd2-count">
                  {rows.length.toLocaleString()} products
                  {!showAnomalies && (sum?.anomalies_hidden ?? 0) > 0 && (
                    <button className="qd2-count-note" onClick={() => setShowAnomalies(true)}
                      title="These are rows where the same barcode is priced very differently at each distributor (usually a pack-size mismatch). Click to show them.">
                      · {sum!.anomalies_hidden} hidden as likely data issues (show)
                    </button>
                  )}
                </div>
                <div className="qd2-viewtoggle" role="group" aria-label="Layout">
                  <button type="button" className={view === 'cards' ? 'on' : ''} onClick={() => setView('cards')}>Card view</button>
                  <button type="button" className={view === 'table' ? 'on' : ''} onClick={() => setView('table')}>Table view</button>
                </div>
              </div>

              {view === 'table' && rows.length > 0 && (
                <QDTable rows={rows.slice(0, shown)} selected={selected} accent={accent}
                  cases={cases} expanded={expanded} setExpanded={setExpanded}
                  goToProduct={goToProduct} editions={data.editions} />
              )}

              {view === 'cards' && <div className="qd2-list">
                {rows.slice(0, shown).map(r => {
                  const isOpen = expanded === r.match_key;
                  const win = r.winner_at_n;
                  const winName = win && win !== 'tie' ? distributorName(win) : null;
                  const landeds = selected
                    .map(w => r.dists[w]?.landed_at_n)
                    .filter((v): v is number => v != null)
                    .sort((a, b) => a - b);
                  const gapPerCase = landeds.length >= 2 ? +(landeds[1] - landeds[0]).toFixed(2) : 0;
                  const lessTotal = +(gapPerCase * cases).toFixed(2);
                  const runnerName = winName
                    ? distributorName(selected.find(w => r.dists[w]?.landed_at_n === landeds[1]) ?? '')
                    : '';
                  return (
                    <div key={r.match_key} className={`qd2-product${isOpen ? ' is-open' : ''}`}>
                      <div className="qd2-product-head" onClick={() => setExpanded(isOpen ? null : r.match_key)}>
                        <div className="qd2-product-id">
                          {isOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                          <div>
                            <button className="qd2-product-name" onClick={e => {
                              e.stopPropagation();
                              const w = win && win !== 'tie' ? win : selected[0];
                              goToProduct(r.dists[w]?.product_name ?? r.product_name, w);
                            }}>{r.product_name}</button>
                            <div className="qd2-product-sub">
                              {r.unit_qty} × {r.unit_volume}
                              {wineVintage(r.product_type, r.vintage) && (
                                <span className="qd2-vintage" title="Vintage. Wine is matched by vintage as well, so both distributors are the same year.">
                                  {wineVintage(r.product_type, r.vintage)}
                                </span>
                              )}
                              {!r.proof_match && (
                                <span className="qd2-warn" title="The distributors list different proof/ABV for this barcode. Double-check it's the same item before comparing.">
                                  <AlertTriangle size={11} /> proof differs
                                </span>
                              )}
                              {r.flips && (
                                <span className="qd2-flip" title="Which distributor has the lowest price changes depending on how many cases you buy.">
                                  <Zap size={11} /> winner changes with volume
                                </span>
                              )}
                              {r.timing_differs && (
                                <span className="qd2-flag-time" title="The distributors differ on timing: one runs the discount all month, the other only on certain dates. Check the dates before you buy.">
                                  <CalendarClock size={11} /> timing differs
                                </span>
                              )}
                              {r.quantity_differs && (
                                <span className="qd2-flag-qty" title="The distributors differ on how many cases you must buy to unlock the discount.">
                                  <Layers size={11} /> unlock qty differs
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="qd2-verdict-banner"
                          title={winName && gapPerCase > 0
                            ? `${winName} has the lowest price per case at ${cases} cases, ${money(gapPerCase)}/case below the next-cheapest (${runnerName}). Over ${cases} case${cases !== 1 ? 's' : ''} that is ${money(lessTotal)} less to spend (${money((landeds[1]) * cases)} at ${runnerName} vs ${money(landeds[0] * cases)} here).`
                            : undefined}>
                          {winName ? (
                            <>
                              <Trophy size={14} style={{ color: accent[win!] }} />
                              <span><strong style={{ color: accent[win!] }}>{winName}</strong> has the lowest price at {cases} cases
                                {gapPerCase > 0 ? <>: {money(gapPerCase)}/case lower price</> : null}
                                {lessTotal > 0 ? <span className="qd2-stake"> · {money(lessTotal)} less to spend in total</span> : null}
                              </span>
                            </>
                          ) : <span className="text-muted">Same cost at {cases} cases</span>}
                        </div>
                        <div onClick={e => e.stopPropagation()}>
                          <RowActions
                            productName={r.dists[win && win !== 'tie' ? win : selected[0]]?.product_name ?? r.product_name}
                            wholesaler={win && win !== 'tie' ? win : selected[0]}
                            upc={r.dists[win && win !== 'tie' ? win : selected[0]]?.upc ?? undefined}
                            unitVolume={r.unit_volume ?? undefined} unitQty={r.unit_qty ?? undefined} />
                        </div>
                      </div>

                      {r.data_anomaly && (
                        <div className="qd2-anomaly" title={r.anomaly_reason}>
                          <AlertTriangle size={14} /> Likely data issue: {r.anomaly_reason}
                        </div>
                      )}

                      <div className="qd2-dists" style={{ gridTemplateColumns: `repeat(${selected.length}, 1fr)` }}>
                        {selected.map(w => (
                          <DistPanel key={w} w={w} d={r.dists[w]} row={r} cases={cases}
                            accent={accent[w]} isWinner={win === w} />
                        ))}
                      </div>

                      <div className="qd2-plain" title="A plain-language recommendation based on all the numbers above.">
                        <Sparkles size={12} /> {r.verdict.text}
                      </div>

                      {isOpen && <QDDetail row={r} slugs={selected} accent={accent} cases={cases} />}
                    </div>
                  );
                })}
              </div>}

              {rows.length === 0 && (
                <div className="cmp-none">
                  {data.total_common === 0
                    ? <>These distributors share no product that all of them offer a QD on. Try Allied / Fedway / Opici, or just two of them.</>
                    : qdDiff
                      ? <>No products where the QD <strong>differs</strong> between these distributors at {cases} case{cases !== 1 ? 's' : ''}. Turn off <strong>Only show QD differences</strong> in the filters to see every product they all carry a QD on.</>
                      : <>No products match your filters. Try turning some off in the left panel.</>}
                </div>
              )}
              {rows.length > shown && (
                <button className="btn cmp-more" onClick={() => setShown(s => s + 40)}>
                  Show more ({(rows.length - shown).toLocaleString()} remaining)
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
