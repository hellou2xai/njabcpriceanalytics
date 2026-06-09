import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams, useNavigate, Link } from 'react-router-dom';
import {
  Layers, Zap, Sparkles, AlertTriangle, Clock, CalendarClock, Combine,
  ShieldAlert, TrendingDown, ChevronDown, ChevronRight, SlidersHorizontal, X, Trophy,
  HelpCircle, Tag, ExternalLink, Scale,
} from 'lucide-react';
import { compare } from '../lib/api';
import type { CompareRipRow, CompareRipDist } from '../lib/api';
import { distributorName } from '../lib/distributors';
import ProductSearchBox from '../components/ProductSearchBox';
import RowActions from '../components/RowActions';
import RipMembersModal from '../components/RipMembersModal';
import './CompareRips.css';

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

/* ---- a RIP is a buy-more-save-more discount. Everything here explains the RIP in plain
   terms: what you pay, when the RIP starts, how big it gets, how long it
   lasts, and who wins at the volume you actually plan to buy. ---- */

/** Stepped landed-$/case curve, one line per distributor. */
function RipCurve({ row, slugs, accent }: { row: CompareRipRow; slugs: string[]; accent: Record<string, string> }) {
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
    <div className="rip2-curve">
      <div className="rip2-sub-title">How your price per case drops as you buy more</div>
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

/** One plain-language metric line with an icon and a hover explanation. */
/** A small, discoverable info cue. Keeps the native title (which escapes the
   card's clipping) and adds a visible "?" so users know detail is on hover. */
function Info({ text }: { text: string }) {
  return (
    <span className="rip2-tip" title={text} tabIndex={0}>
      <HelpCircle size={11} className="rip2-tip-ico" />
    </span>
  );
}

function Metric({ icon, label, value, hint, tone }: {
  icon: React.ReactNode; label: string; value: React.ReactNode; hint: string; tone?: 'good' | 'warn';
}) {
  return (
    <div className={`rip2-metric${tone ? ` rip2-metric--${tone}` : ''}`} title={hint}>
      <span className="rip2-metric-ico">{icon}</span>
      <span className="rip2-metric-label">{label}<Info text={hint} /></span>
      <span className="rip2-metric-val">{value}</span>
    </div>
  );
}

/** Per-distributor panel for one product, in plain language. */
function DistPanel({ w, d, row, cases, accent, isWinner, onRipClick }: {
  w: string; d: CompareRipDist; row: CompareRipRow; cases: number; accent: string; isWinner: boolean;
  onRipClick: (wholesaler: string, code: string) => void;
}) {
  const pack = row.unit_qty ? parseFloat(row.unit_qty) : null;
  const btl = (v?: number | null) => (v != null && pack ? `${money(v / pack)}/btl` : null);
  const expiring = d.expires_in_days != null;

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
  const priceHint =
    `Your landed cost per case after the best RIP you qualify for at ${cases} case${cases !== 1 ? 's' : ''}. ` +
    (d.frontline != null ? `List is ${money(d.frontline)}/case` : '') +
    (d.rip_at_n ? `; the RIP takes off ${money(d.rip_at_n)}/case.` : '.') +
    (myTotal != null ? ` That is ${money(myTotal)} total for ${cases} case${cases !== 1 ? 's' : ''}.` : '');

  return (
    <div className={`rip2-dist${isWinner ? ' is-winner' : ''}`} style={{ borderTopColor: accent }}>
      <div className="rip2-dist-head">
        <span className="rip2-dist-name">{distributorName(w)}</span>
        {isWinner && (
          <span className="rip2-best-tag" title={vsText}>
            <Trophy size={11} /> lowest price at {cases} cs <HelpCircle size={10} className="rip2-tip-ico" />
          </span>
        )}
      </div>
      {/* each distributor's own size + barcode, so you can see it's like-for-like */}
      <div className="rip2-dist-size"
        title="Products are matched by exact barcode, bottle size and bottles-per-case, so this is a like-for-like comparison.">
        {(d.unit_qty ?? row.unit_qty)} × {(d.unit_volume ?? row.unit_volume)}
        {d.upc && <span className="rip2-dist-upc"> · UPC {d.upc}</span>}
      </div>
      {/* open this distributor's exact product to verify the price and the facts */}
      {d.product_name && (
        <Link className="rip2-dist-link" to={detailUrl(w, d.product_name, d.upc)}
          target="_blank" rel="noopener noreferrer"
          onClick={e => e.stopPropagation()}
          title={`Open ${distributorName(w)}'s "${d.product_name}" to verify the price and details`}>
          {d.product_name} <ExternalLink size={11} />
        </Link>
      )}

      {/* the headline: what a case actually costs you at the volume you chose */}
      <div className="rip2-dist-price" title={priceHint}>
        {money(d.landed_at_n)}<span className="rip2-per">/case</span>
        {btl(d.landed_at_n) && <span className="rip2-dist-btl">{btl(d.landed_at_n)}</span>}
        <Info text={priceHint} />
      </div>
      <div className="rip2-dist-pricenote">
        price per case when buying {cases} case{cases !== 1 ? 's' : ''}
        {myTotal != null && <span className="rip2-dist-total"> · {money(myTotal)} total outlay</span>}
      </div>
      {/* Two price layers: List, then the price AFTER the quantity discount, then
          the price AFTER the RIP (= what you pay). Each step shows the running
          price plus the amount it took off, so it reconciles to the headline. */}
      {d.frontline != null && (() => {
        const net = d.landed_at_n;
        const off = net != null ? d.frontline! - net : null;
        // split the total savings: RIP portion (capped) + the rest is the QD
        const ripPart = off != null && d.rip_at_n != null ? Math.min(d.rip_at_n, off) : 0;
        const qdPart = off != null ? Math.max(0, off - ripPart) : 0;
        const afterQD = qdPart > 0.005 ? d.frontline! - qdPart : null;   // price after QD
        // per-bottle price at each layer (pack = bottles per case)
        const pb = (v?: number | null) => (v != null && pack ? `${money(v / pack)}/btl` : null);
        const bdHint =
          `List (sticker) price ${money(d.frontline)}/case (${pb(d.frontline)})` +
          (qdPart > 0.005 ? `. After the ${money(qdPart)}/case quantity discount: ${money(afterQD)}/case (${pb(afterQD)})` : '') +
          (ripPart > 0.005 ? `. After the ${money(ripPart)}/case RIP on top: ${money(net)}/case (${pb(net)})` : '') +
          (net != null ? ` (what you pay buying ${cases} case${cases !== 1 ? 's' : ''}).` : '.');
        return (
          <div className="rip2-dist-breakdown" title={bdHint}>
            <Tag size={11} />
            <span>List {money(d.frontline)}{pb(d.frontline) && <span className="rip2-bd-btl">{pb(d.frontline)}</span>}</span>
            {afterQD != null && (
              <span className="rip2-bd-step" title="Price after the distributor's quantity (case) discount, before any RIP.">
                <span className="rip2-bd-arrow">→</span> after QD <strong>{money(afterQD)}</strong>
                {pb(afterQD) && <span className="rip2-bd-btl">{pb(afterQD)}</span>}
                <span className="rip2-bd-d">(-{money(qdPart)})</span>
              </span>
            )}
            {ripPart > 0.005 && net != null && (
              <span className="rip2-bd-step" title="Price after the NJ ABC RIP rebate, applied on top of the quantity discount. This is what you pay.">
                <span className="rip2-bd-arrow">→</span> after RIP <strong>{money(net)}</strong>
                {pb(net) && <span className="rip2-bd-btl">{pb(net)}</span>}
                <span className="rip2-bd-d">(-{money(ripPart)})</span>
              </span>
            )}
            {qdPart <= 0.005 && ripPart <= 0.005 && net != null && (
              <span className="rip2-bd-step"><span className="rip2-bd-arrow">→</span> pay <strong>{money(net)}</strong>
                {pb(net) && <span className="rip2-bd-btl">{pb(net)}</span>}</span>
            )}
            <Info text={bdHint} />
          </div>
        );
      })()}

      {/* the clarity sticker: pay this up front (before RIP), get the RIP back,
          land at the net. invest - back = net reconciles to the headline. */}
      {d.unlock_cases != null && d.unlock_investment != null && (() => {
        const net = (d.unlock_investment ?? 0) - (d.unlock_rebate_total ?? 0);
        return (
          <div className="rip2-unlock"
            title={`To claim ${distributorName(w)}'s first RIP you buy ${d.unlock_cases} case${d.unlock_cases !== 1 ? 's' : ''} at the case price (before the RIP), paying ${money(d.unlock_investment)} up front. The RIP then returns ${money(d.unlock_rebate_total)}, so your net cost is ${money(net)}.`}>
            <Zap size={12} />
            <span>Unlock the RIP: buy <strong>{d.unlock_cases} cs</strong>, pay <strong>{money(d.unlock_investment)}</strong></span>
            <span className="rip2-unlock-back">get {money(d.unlock_rebate_total)} back · net {money(net)}</span>
          </div>
        );
      })()}

      <div className="rip2-metrics">
        <Metric icon={<TrendingDown size={13} />} label="Just 1 case"
          value={money(d.landed_at_1)}
          hint="What you'd pay per case if you only bought a single case (the small-buyer price)." />
        <Metric icon={<Zap size={13} />} label="RIP starts at"
          value={d.min_cases ? `${d.min_cases} cs` : 'no RIP'}
          hint="The fewest cases you must buy before any RIP kicks in. Lower means less money down to start saving." />
        <Metric icon={<Trophy size={13} />} label="Best RIP / case"
          value={d.deepest_rebate
            ? `${money(d.deepest_rebate)}/cs${d.deepest_at_cases && d.deepest_at_cases > 1 ? ` at ${d.deepest_at_cases}cs` : ''}`
            : '-'}
          hint={d.deepest_at_cases && d.deepest_at_cases > 1
            ? `The largest RIP rebate on this product is ${money(d.deepest_rebate)} off each case, but only once you buy ${d.deepest_at_cases} cases. At a smaller order you get less per case.`
            : `The largest RIP rebate on this product: ${money(d.deepest_rebate)} off each case.`} />
        <Metric icon={<CalendarClock size={13} />} label="RIP runs"
          value={`${d.active_days ?? 0} days`}
          hint={`How many days this month this distributor has a RIP live on this product. More days = easier to time your buy.`} />
        {expiring && (
          <Metric icon={<Clock size={13} />} label="Ends in"
            value={`${d.expires_in_days} day${d.expires_in_days === 1 ? '' : 's'}`}
            tone="warn"
            hint="This RIP is a limited-time deal that ends soon. Buy before it expires or the price goes back up." />
        )}
        {d.has_upcoming && !expiring && (
          <Metric icon={<CalendarClock size={13} />} label="Bigger deal soon"
            value="starts later"
            hint="A deeper RIP on this product starts later this month. It may be worth waiting." />
        )}
        {d.is_combination && (
          <Metric icon={<Combine size={13} />} label="Mix to qualify"
            value={d.case_mix && d.case_mix > 1 ? `${d.case_mix} products` : 'combo'}
            tone="good"
            hint={d.case_mix && d.case_mix > 1
              ? `You can mix across ${d.case_mix} different products under this RIP code to reach the case count, far easier than buying that many of one item. Click the RIP code below to see exactly which products count.`
              : 'This RIP lets you mix several products to qualify. Click the RIP code below to see them.'} />
        )}
        {d.pre_approval && (
          <Metric icon={<ShieldAlert size={13} />} label="Pre-approval"
            value="needed" tone="warn"
            hint={`This RIP trips an NJ ABC limit (${d.compliance_flags.join('; ')}), so it needs pre-approval before you can use it.`} />
        )}
      </div>

      {/* the actual RIP code(s): click to see every product in the RIP */}
      {d.rip_code && d.rip_code.trim() && (
        <div className="rip2-codes">
          <span className="rip2-codes-label">RIP code{d.rip_code.trim().split(/\s+/).length > 1 ? 's' : ''}</span>
          {d.rip_code.trim().split(/\s+/).filter(Boolean).map(rc => (
            <button key={rc} type="button" className="rip-code-badge rip-code-chip"
              title={`Show every product included in RIP ${rc} (the products you can mix to hit the tier)`}
              onClick={() => onRipClick(w, rc)}>
              {rc}
            </button>
          ))}
        </div>
      )}

      {d.rip_gaps.length > 0 && (
        <div className="rip2-gap" title="Days this month with NO RIP at all. Avoid buying then.">
          <AlertTriangle size={11} /> No RIP {d.rip_gaps.map(g => `${g.from.slice(5)} to ${g.to.slice(5)}`).join(', ')}
        </div>
      )}
    </div>
  );
}

function RipDetail({ row, slugs, accent, cases }: { row: CompareRipRow; slugs: string[]; accent: Record<string, string>; cases: number }) {
  return (
    <div className="rip2-detail">
      <div className="rip2-detail-charts">
        <RipCurve row={row} slugs={slugs} accent={accent} />
        <div className="rip2-breakeven">
          <div className="rip2-sub-title">Who has the lowest price per case at each amount you might buy</div>
          <div className="rip2-be-rows">
            {row.breakeven.filter(b => b.winner).map((b, i) => (
              <span key={i} className="rip2-be">
                {b.from}{b.to ? `-${b.to}` : '+'} cs:{' '}
                <strong style={{ color: b.winner !== 'tie' ? accent[b.winner!] : 'var(--text-muted)' }}>
                  {b.winner === 'tie' ? 'tie' : distributorName(b.winner!)}
                </strong>
              </span>
            ))}
          </div>
        </div>
      </div>
      <div className="rip2-ladders" style={{ gridTemplateColumns: `repeat(${slugs.length}, 1fr)` }}>
        {slugs.map(w => {
          const d = row.dists[w];
          return (
            <div key={w} className="rip2-ladder">
              <div className="rip2-ladder-head" style={{ color: accent[w] }}>{distributorName(w)}: every RIP tier</div>
              {d.rip_code && <div className="rip2-code">RIP code {d.rip_code}</div>}
              <table className="rip2-tier-table">
                <thead><tr><th>Buy</th><th>$ off / case</th><th>Price / case</th><th>When</th></tr></thead>
                <tbody>
                  {d.rip_tiers.length === 0 && <tr><td colSpan={4} className="rip2-none">no RIP tiers</td></tr>}
                  {d.rip_tiers.map((t, i) => (
                    <tr key={i}>
                      <td>{t.buy_label ?? `${t.cases_to_unlock ?? t.raw_qty} cs`}</td>
                      <td className="text-green">{t.rebate_per_case != null ? `-${money(t.rebate_per_case)}` : '-'}</td>
                      <td><strong>{money(t.price_after)}</strong></td>
                      <td>{t.is_time_sensitive && t.window_status !== 'expired'
                        ? <span className="rip2-tier-when">{t.from_date?.slice(5)}→{t.to_date?.slice(5)}</span>
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

export default function CompareRips() {
  const [params, setSearchParams] = useSearchParams();
  const [selected, setSelected] = useState<string[]>(params.get('d')?.split(',').filter(Boolean) ?? DEFAULT);
  const [cases, setCases] = useState(parseInt(params.get('cases') ?? '5', 10) || 5);
  const [q, setQ] = useState(params.get('q') ?? '');
  const [ptype, setPtype] = useState(params.get('type') ?? '');
  const [brand, setBrand] = useState(params.get('brand') ?? '');
  // default = show everything; the price-difference filters are opt-in
  const [onlyDiff, setOnlyDiff] = useState(params.get('diff') === '1');
  const [minDiff, setMinDiff] = useState(params.get('min_diff') != null ? Math.max(0, parseFloat(params.get('min_diff')!) || 0) : 0);
  const [tsOnly, setTsOnly] = useState(params.get('ts') === '1');
  const [comboOnly, setComboOnly] = useState(params.get('combo') === '1');
  const [expiringOnly, setExpiringOnly] = useState(params.get('exp') === '1');
  const [timingDiff, setTimingDiff] = useState(params.get('timing') === '1');
  const [qtyDiff, setQtyDiff] = useState(params.get('qty') === '1');
  const [betterTerms, setBetterTerms] = useState(params.get('bt') === '1');
  const [showAnomalies, setShowAnomalies] = useState(params.get('anom') === '1');
  const [sort, setSort] = useState(params.get('sort') ?? 'spread');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [shown, setShown] = useState(40);
  const [railOpen, setRailOpen] = useState(true);
  const [ripModal, setRipModal] = useState<{ wholesaler: string; ripCode: string } | null>(null);
  const openRip = (wholesaler: string, ripCode: string) => setRipModal({ wholesaler, ripCode });
  const navigate = useNavigate();
  const goToProduct = (name: string, wholesaler?: string) =>
    navigate(`/products?q=${encodeURIComponent(name)}${wholesaler ? `&wholesaler=${wholesaler}` : ''}`);

  useEffect(() => {
    const next = new URLSearchParams();
    if (selected.length) next.set('d', selected.join(','));
    if (cases !== 5) next.set('cases', String(cases));
    if (q) next.set('q', q);
    if (ptype) next.set('type', ptype);
    if (brand) next.set('brand', brand);
    if (onlyDiff) next.set('diff', '1');
    if (minDiff > 0) next.set('min_diff', String(minDiff));
    if (tsOnly) next.set('ts', '1');
    if (comboOnly) next.set('combo', '1');
    if (expiringOnly) next.set('exp', '1');
    if (timingDiff) next.set('timing', '1');
    if (qtyDiff) next.set('qty', '1');
    if (betterTerms) next.set('bt', '1');
    if (showAnomalies) next.set('anom', '1');
    if (sort !== 'spread') next.set('sort', sort);
    if (next.toString() !== params.toString()) setSearchParams(next, { replace: true });
  }, [selected, cases, q, ptype, brand, onlyDiff, minDiff, tsOnly, comboOnly, expiringOnly, timingDiff, qtyDiff, betterTerms, showAnomalies, sort]);

  const { data: options } = useQuery({ queryKey: ['compare-options'], queryFn: compare.options });
  const ready = selected.length >= 2 && selected.length <= 3;
  const { data, isLoading, error } = useQuery({
    queryKey: ['compare-rips', selected, cases, q, ptype, brand, onlyDiff, minDiff, tsOnly, comboOnly, expiringOnly, timingDiff, qtyDiff, betterTerms, showAnomalies, sort],
    queryFn: () => compare.rips({
      wholesalers: selected.join(','), cases, q: q || undefined,
      product_type: ptype || undefined, brand: brand || undefined,
      only_differences: onlyDiff || undefined, min_diff: minDiff,
      time_sensitive_only: tsOnly || undefined,
      combo_only: comboOnly || undefined, expiring_only: expiringOnly || undefined,
      timing_diff_only: timingDiff || undefined, qty_diff_only: qtyDiff || undefined,
      better_terms_only: betterTerms || undefined,
      include_anomalies: showAnomalies || undefined, sort,
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

  const rows = data?.rows ?? [];
  const sum = data?.summary;

  return (
    <div className="page rip2-page">
      <div className="rip2-top">
        <h2><Layers size={20} style={{ verticalAlign: '-3px', marginRight: 8 }} />Compare RIPs</h2>
        <p className="rip2-lede">
          A RIP is a buy-more-save-more discount. The same bottle can RIP
          very differently at each distributor. Pick how many cases you plan to buy and
          see who actually costs less, when the RIP starts, how big it gets, and how
          long it lasts.
        </p>
      </div>

      <div className={`rip2-layout${railOpen ? '' : ' rail-closed'}`}>
        {/* ---- collapsible left filter rail ---- */}
        {railOpen ? (
          <aside className="rip2-rail">
            <div className="rip2-rail-head">
              <span><SlidersHorizontal size={15} /> Filters</span>
              <button className="rip2-rail-x" onClick={() => setRailOpen(false)} title="Hide filters"><X size={15} /></button>
            </div>

            <div className="rip2-rail-sect">
              <div className="rip2-rail-label">Distributors to compare (2-3)</div>
              <div className="rip2-chips">
                {(options ?? []).map(o => (
                  <button key={o.wholesaler}
                    className={`rip2-chip${selected.includes(o.wholesaler) ? ' on' : ''}`}
                    style={selected.includes(o.wholesaler) ? { borderColor: accent[o.wholesaler], color: accent[o.wholesaler] } : undefined}
                    onClick={() => toggle(o.wholesaler)}
                    disabled={!selected.includes(o.wholesaler) && selected.length >= 3}>
                    {distributorName(o.wholesaler)}
                  </button>
                ))}
              </div>
            </div>

            <div className="rip2-rail-sect">
              <div className="rip2-rail-label">How many cases will you buy?</div>
              <div className="rip2-vol">
                <input type="range" min={1} max={50} value={cases}
                  onChange={e => { setCases(parseInt(e.target.value, 10)); setShown(40); }} />
                <span className="rip2-vol-n">{cases} case{cases !== 1 ? 's' : ''}</span>
              </div>
              <div className="rip2-rail-help">Everything below is judged at this amount.</div>
            </div>

            <div className="rip2-rail-sect">
              <div className="rip2-rail-label">Search</div>
              <ProductSearchBox value={q} placeholder="Product or brand…"
                onChange={v => { setQ(v); setShown(40); }}
                onSelect={p => { setQ(p.product_name); setShown(40); }} />
            </div>

            <div className="rip2-rail-sect">
              <div className="rip2-rail-label">Category</div>
              <select value={ptype} onChange={e => setPtype(e.target.value)} className="rip2-select">
                <option value="">All categories</option>
                {types.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>

            <div className="rip2-rail-sect">
              <div className="rip2-rail-label">Brand</div>
              <input className="rip2-input" placeholder="e.g. Tito's" value={brand}
                onChange={e => { setBrand(e.target.value); setShown(40); }} />
            </div>

            <div className="rip2-rail-sect">
              <div className="rip2-rail-label">Minimum price gap</div>
              <div className="rip2-mindiff">
                <span className="rip2-mindiff-cur">$</span>
                <input className="rip2-mindiff-in" type="number" min={0} step={0.5} value={minDiff}
                  onChange={e => { setMinDiff(Math.max(0, parseFloat(e.target.value) || 0)); setShown(40); }} />
                <span className="rip2-mindiff-unit">/ case</span>
              </div>
              <div className="rip2-rail-help">
                Only show products where the lowest-price distributor beats the rest by at
                least this much per case at {cases} case{cases !== 1 ? 's' : ''}. Set to $0 to show every match.
              </div>
            </div>

            <div className="rip2-rail-sect">
              <div className="rip2-rail-label">Price difference</div>
              <label className="rip2-toggle" title="Off by default (every shared-RIP product is shown). Turn on to hide products where both distributors land at the same price.">
                <input type="checkbox" checked={onlyDiff} onChange={e => setOnlyDiff(e.target.checked)} /> Only show price differences
              </label>
              <div className="rip2-rail-help">Off shows all products. On hides ties.</div>
            </div>

            <div className="rip2-rail-sect">
              <div className="rip2-rail-label">Show only</div>
              <label className="rip2-toggle" title="Only products where a distributor's RIP is a limited-time deal.">
                <input type="checkbox" checked={tsOnly} onChange={e => setTsOnly(e.target.checked)} /> Time-limited RIPs
              </label>
              <label className="rip2-toggle" title="Only products where a RIP ends this month (buy-now urgency).">
                <input type="checkbox" checked={expiringOnly} onChange={e => setExpiringOnly(e.target.checked)} /> Ending soon
              </label>
              <label className="rip2-toggle" title="Only RIPs you can qualify for by mixing several products.">
                <input type="checkbox" checked={comboOnly} onChange={e => setComboOnly(e.target.checked)} /> Mix-to-qualify
              </label>
            </div>

            <div className="rip2-rail-sect">
              <div className="rip2-rail-label">Compare beyond price</div>
              <label className="rip2-toggle" title="Only products where the distributors differ on RIP timing: one runs all month, the other is a dated/limited deal.">
                <input type="checkbox" checked={timingDiff} onChange={e => setTimingDiff(e.target.checked)} /> RIP timing differs
              </label>
              <label className="rip2-toggle" title="Only products where the distributors differ on how many cases you must buy to unlock the RIP.">
                <input type="checkbox" checked={qtyDiff} onChange={e => setQtyDiff(e.target.checked)} /> Unlock quantity differs
              </label>
              <label className="rip2-toggle" title="Same price either way, but the RIP terms differ: one needs less cash down to unlock, lets you mix more products, or unlocks at fewer cases.">
                <input type="checkbox" checked={betterTerms} onChange={e => setBetterTerms(e.target.checked)} /> Same price, better RIP terms
              </label>
              <label className="rip2-toggle" title="Show rows flagged as likely data issues: the same barcode priced very differently at each distributor, usually a pack-size mismatch.">
                <input type="checkbox" checked={showAnomalies} onChange={e => setShowAnomalies(e.target.checked)} /> Show possible data issues
              </label>
            </div>

            <div className="rip2-rail-sect">
              <div className="rip2-rail-label">Sort by</div>
              <select value={sort} onChange={e => setSort(e.target.value)} className="rip2-select">
                <option value="spread">Biggest price gap</option>
                <option value="left_on_table">Biggest total saving</option>
                <option value="min_cases">Easiest to unlock (fewest cases)</option>
                <option value="least_investment">Least cash to unlock</option>
                <option value="best_mix">Widest product mix</option>
                <option value="best1">Best 1-case deal</option>
                <option value="deepest">Biggest RIP</option>
                <option value="active_days">Most days available</option>
                <option value="product">Product name</option>
              </select>
            </div>
          </aside>
        ) : (
          <button className="rip2-rail-open" onClick={() => setRailOpen(true)} title="Show filters">
            <SlidersHorizontal size={15} /><span>Filters</span>
          </button>
        )}

        {/* ---- main ---- */}
        <div className="rip2-main">
          {!ready && (
            <div className="cmp-empty">
              Pick two or three distributors in the filters to compare how their RIPs
              play out on the products they all carry.
            </div>
          )}
          {ready && isLoading && <p>Comparing RIPs…</p>}
          {ready && !!error && <p className="text-red">Failed: {String((error as Error).message)}</p>}

          {ready && data && (
            <>
              {/* plain-language scoreboard */}
              <div className="rip2-cards">
                <div className="rip2-scard">
                  <div className="rip2-scard-n">{data.total_common.toLocaleString()}</div>
                  <div className="rip2-scard-l">products all of them offer a RIP on</div>
                </div>
                {selected.map(w => (
                  <div className="rip2-scard" key={w} style={{ borderTop: `3px solid ${accent[w]}` }}>
                    <div className="rip2-scard-n">{sum?.wins_at_n[w] ?? 0}</div>
                    <div className="rip2-scard-l">{distributorName(w)} has the lowest price/case at {cases} cs</div>
                  </div>
                ))}
                <div className="rip2-scard">
                  <div className="rip2-scard-n"><Zap size={15} style={{ verticalAlign: '-2px' }} /> {sum?.flips ?? 0}</div>
                  <div className="rip2-scard-l">change winner as you buy more</div>
                </div>
              </div>

              {!!sum?.insights?.length && (
                <div className="rip2-insights">
                  {sum.insights.map((t, i) => <div key={i} className="rip2-insight">💡 {t}</div>)}
                </div>
              )}

              <div className="rip2-count">
                {rows.length.toLocaleString()} products
                {!showAnomalies && (sum?.anomalies_hidden ?? 0) > 0 && (
                  <button className="rip2-count-note" onClick={() => setShowAnomalies(true)}
                    title="These are rows where the same barcode is priced very differently at each distributor (usually a pack-size mismatch). Click to show them.">
                    · {sum!.anomalies_hidden} hidden as likely data issues (show)
                  </button>
                )}
              </div>

              <div className="rip2-list">
                {rows.slice(0, shown).map(r => {
                  const isOpen = expanded === r.match_key;
                  const win = r.winner_at_n;
                  const winName = win && win !== 'tie' ? distributorName(win) : null;
                  return (
                    <div key={r.match_key} className={`rip2-product${isOpen ? ' is-open' : ''}`}>
                      <div className="rip2-product-head" onClick={() => setExpanded(isOpen ? null : r.match_key)}>
                        <div className="rip2-product-id">
                          {isOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                          <div>
                            <button className="rip2-product-name" onClick={e => {
                              e.stopPropagation();
                              const w = win && win !== 'tie' ? win : selected[0];
                              goToProduct(r.dists[w]?.product_name ?? r.product_name, w);
                            }}>{r.product_name}</button>
                            <div className="rip2-product-sub">
                              {r.unit_qty} × {r.unit_volume}
                              {wineVintage(r.product_type, r.vintage) && (
                                <span className="rip2-vintage" title="Vintage. Wine is matched by vintage as well, so both distributors are the same year.">
                                  {wineVintage(r.product_type, r.vintage)}
                                </span>
                              )}
                              {!r.proof_match && (
                                <span className="rip2-warn" title="The distributors list different proof/ABV for this barcode. Double-check it's the same item before comparing.">
                                  <AlertTriangle size={11} /> proof differs
                                </span>
                              )}
                              {r.flips && (
                                <span className="rip2-flip" title="Which distributor has the lowest price changes depending on how many cases you buy.">
                                  <Zap size={11} /> winner changes with volume
                                </span>
                              )}
                              {r.timing_differs && (
                                <span className="rip2-flag-time" title="The distributors differ on timing: one runs the RIP all month, the other only on certain dates. Check the dates before you buy.">
                                  <CalendarClock size={11} /> timing differs
                                </span>
                              )}
                              {r.quantity_differs && (
                                <span className="rip2-flag-qty" title="The distributors differ on how many cases you must buy to unlock the RIP.">
                                  <Layers size={11} /> unlock qty differs
                                </span>
                              )}
                              {r.better_terms_tie && (
                                <span className="rip2-flag-terms" title="The price is about the same at both, but the RIP terms differ: one needs less cash to unlock, a wider product mix, or fewer cases. The verdict below names the better terms.">
                                  <Scale size={11} /> same price, better RIP terms
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="rip2-verdict-banner"
                          title={winName && r.spread_at_n
                            ? `${winName} has the lower price per case at ${cases} cases (${money(r.spread_at_n)}/case cheaper), so buying your ${cases} cases there costs ${money(r.left_on_table)} less in total than the next distributor.`
                            : undefined}>
                          {winName ? (
                            <>
                              <Trophy size={14} style={{ color: accent[win!] }} />
                              <span><strong style={{ color: accent[win!] }}>{winName}</strong> has the lowest price at {cases} cases
                                {r.spread_at_n ? <>: {money(r.spread_at_n)}/case lower price</> : null}
                                {r.left_on_table ? <span className="rip2-stake"> · {money(r.left_on_table)} less to spend in total</span> : null}
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
                        <div className="rip2-anomaly" title={r.anomaly_reason}>
                          <AlertTriangle size={14} /> Likely data issue: {r.anomaly_reason}
                        </div>
                      )}

                      <div className="rip2-dists" style={{ gridTemplateColumns: `repeat(${selected.length}, 1fr)` }}>
                        {selected.map(w => (
                          <DistPanel key={w} w={w} d={r.dists[w]} row={r} cases={cases}
                            accent={accent[w]} isWinner={win === w} onRipClick={openRip} />
                        ))}
                      </div>

                      <div className="rip2-plain" title="A plain-language recommendation based on all the numbers above.">
                        <Sparkles size={12} /> {r.verdict.text}
                      </div>

                      {isOpen && <RipDetail row={r} slugs={selected} accent={accent} cases={cases} />}
                    </div>
                  );
                })}
                {rows.length === 0 && (
                  <div className="cmp-none">
                    {data.total_common === 0
                      ? <>These distributors share no product that all of them offer a RIP on. Try Allied / Fedway / Opici, or just two of them.</>
                      : <>No products match your filters. Try turning some off in the left panel.</>}
                  </div>
                )}
              </div>
              {rows.length > shown && (
                <button className="btn cmp-more" onClick={() => setShown(s => s + 40)}>
                  Show more ({(rows.length - shown).toLocaleString()} remaining)
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {ripModal && (
        <RipMembersModal
          wholesaler={ripModal.wholesaler}
          ripCode={ripModal.ripCode}
          onClose={() => setRipModal(null)}
        />
      )}
    </div>
  );
}
