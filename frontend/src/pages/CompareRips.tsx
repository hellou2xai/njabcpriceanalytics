import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams, useNavigate } from 'react-router-dom';
import {
  Layers, Zap, Sparkles, AlertTriangle, Clock, CalendarClock, Combine,
  ShieldAlert, TrendingDown, ChevronDown, ChevronRight, SlidersHorizontal, X, Trophy,
  HelpCircle, Tag,
} from 'lucide-react';
import { compare } from '../lib/api';
import type { CompareRipRow, CompareRipDist } from '../lib/api';
import { distributorName } from '../lib/distributors';
import ProductSearchBox from '../components/ProductSearchBox';
import RowActions from '../components/RowActions';
import './CompareRips.css';

const money = (v?: number | null) => (v == null ? '–' : `$${Number(v).toFixed(2)}`);
const ACCENTS = ['#2563eb', '#d97706', '#7c3aed'];
const DEFAULT = ['allied', 'fedway', 'opici'];

/* ---- a RIP is a rebate. Everything on this page explains that rebate in plain
   terms: what you pay, when the rebate starts, how big it gets, how long it
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
function DistPanel({ w, d, row, cases, accent, isWinner }: {
  w: string; d: CompareRipDist; row: CompareRipRow; cases: number; accent: string; isWinner: boolean;
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
    `Your landed cost per case after the best rebate you qualify for at ${cases} case${cases !== 1 ? 's' : ''}. ` +
    (d.frontline != null ? `List is ${money(d.frontline)}/case` : '') +
    (d.rip_at_n ? `; the rebate takes off ${money(d.rip_at_n)}/case.` : '.') +
    (myTotal != null ? ` That is ${money(myTotal)} total for ${cases} case${cases !== 1 ? 's' : ''}.` : '');

  return (
    <div className={`rip2-dist${isWinner ? ' is-winner' : ''}`} style={{ borderTopColor: accent }}>
      <div className="rip2-dist-head">
        <span className="rip2-dist-name">{distributorName(w)}</span>
        {isWinner && (
          <span className="rip2-best-tag" title={vsText}>
            <Trophy size={11} /> best at {cases} cs <HelpCircle size={10} className="rip2-tip-ico" />
          </span>
        )}
      </div>

      {/* the headline: what a case actually costs you at the volume you chose */}
      <div className="rip2-dist-price" title={priceHint}>
        {money(d.landed_at_n)}<span className="rip2-per">/case</span>
        {btl(d.landed_at_n) && <span className="rip2-dist-btl">{btl(d.landed_at_n)}</span>}
        <Info text={priceHint} />
      </div>
      <div className="rip2-dist-pricenote">
        your cost buying {cases} case{cases !== 1 ? 's' : ''}
        {myTotal != null && <span className="rip2-dist-total"> · {money(myTotal)} total</span>}
      </div>
      {/* the whole story: list price, the rebate applied, the net above */}
      {d.frontline != null && (
        <div className="rip2-dist-breakdown" title={`List (frontline) case price before any rebate: ${money(d.frontline)}. ${d.rip_at_n ? `Best rebate you qualify for at ${cases} cases: ${money(d.rip_at_n)}/case.` : 'No rebate applies at this volume.'}`}>
          <Tag size={11} /> List {money(d.frontline)}
          {d.rip_at_n ? <> <span className="rip2-bd-minus">−</span> <span className="text-green">{money(d.rip_at_n)} rebate</span></> : null}
        </div>
      )}

      <div className="rip2-metrics">
        <Metric icon={<TrendingDown size={13} />} label="Just 1 case"
          value={money(d.landed_at_1)}
          hint="What you'd pay per case if you only bought a single case (the small-buyer price)." />
        <Metric icon={<Zap size={13} />} label="Rebate starts at"
          value={d.min_cases ? `${d.min_cases} cs` : 'no rebate'}
          hint="The fewest cases you must buy before any rebate kicks in. Lower means less money down to start saving." />
        <Metric icon={<Trophy size={13} />} label="Biggest rebate"
          value={d.deepest_rebate ? `${money(d.deepest_rebate)}/cs` : '–'}
          hint={d.deepest_at_cases ? `The largest rebate on offer: ${money(d.deepest_rebate)} off each case, once you reach ${d.deepest_at_cases} cases.` : 'The largest rebate on offer per case.'} />
        <Metric icon={<CalendarClock size={13} />} label="Rebate runs"
          value={`${d.active_days ?? 0} days`}
          hint={`How many days this month this distributor has a rebate live on this product. More days = easier to time your buy.`} />
        {expiring && (
          <Metric icon={<Clock size={13} />} label="Ends in"
            value={`${d.expires_in_days} day${d.expires_in_days === 1 ? '' : 's'}`}
            tone="warn"
            hint="This rebate is a limited-time deal that ends soon. Buy before it expires or the price goes back up." />
        )}
        {d.has_upcoming && !expiring && (
          <Metric icon={<CalendarClock size={13} />} label="Bigger deal soon"
            value="starts later"
            hint="A deeper rebate on this product starts later this month. It may be worth waiting." />
        )}
        {d.is_combination && (
          <Metric icon={<Combine size={13} />} label="Mix to qualify"
            value={d.case_mix && d.case_mix > 1 ? `${d.case_mix} products` : 'combo'}
            tone="good"
            hint={d.case_mix && d.case_mix > 1
              ? `You can mix across ${d.case_mix} different products under this rebate code to reach the case count — far easier than buying that many of one item.`
              : 'This rebate lets you mix several products to qualify.'} />
        )}
        {d.pre_approval && (
          <Metric icon={<ShieldAlert size={13} />} label="Pre-approval"
            value="needed" tone="warn"
            hint={`This rebate trips an NJ ABC limit (${d.compliance_flags.join('; ')}), so it needs pre-approval before you can use it.`} />
        )}
      </div>

      {d.rip_gaps.length > 0 && (
        <div className="rip2-gap" title="Days this month with NO rebate at all — avoid buying then.">
          <AlertTriangle size={11} /> No rebate {d.rip_gaps.map(g => `${g.from.slice(5)}–${g.to.slice(5)}`).join(', ')}
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
          <div className="rip2-sub-title">Who's cheapest at each amount you might buy</div>
          <div className="rip2-be-rows">
            {row.breakeven.filter(b => b.winner).map((b, i) => (
              <span key={i} className="rip2-be">
                {b.from}{b.to ? `–${b.to}` : '+'} cs:{' '}
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
              <div className="rip2-ladder-head" style={{ color: accent[w] }}>{distributorName(w)} — every rebate tier</div>
              {d.rip_code && <div className="rip2-code">rebate code {d.rip_code}</div>}
              <table className="rip2-tier-table">
                <thead><tr><th>Buy</th><th>$ off / case</th><th>Price / case</th><th>When</th></tr></thead>
                <tbody>
                  {d.rip_tiers.length === 0 && <tr><td colSpan={4} className="rip2-none">no rebate tiers</td></tr>}
                  {d.rip_tiers.map((t, i) => (
                    <tr key={i}>
                      <td>{t.buy_label ?? `${t.cases_to_unlock ?? t.raw_qty} cs`}</td>
                      <td className="text-green">{t.rebate_per_case != null ? `−${money(t.rebate_per_case)}` : '–'}</td>
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
  const [onlyDiff, setOnlyDiff] = useState(params.get('diff') !== '0');
  const [minDiff, setMinDiff] = useState(params.get('min_diff') != null ? Math.max(0, parseFloat(params.get('min_diff')!) || 0) : 1);
  const [tsOnly, setTsOnly] = useState(params.get('ts') === '1');
  const [comboOnly, setComboOnly] = useState(params.get('combo') === '1');
  const [expiringOnly, setExpiringOnly] = useState(params.get('exp') === '1');
  const [sort, setSort] = useState(params.get('sort') ?? 'spread');
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
    if (brand) next.set('brand', brand);
    if (!onlyDiff) next.set('diff', '0');
    if (minDiff !== 1) next.set('min_diff', String(minDiff));
    if (tsOnly) next.set('ts', '1');
    if (comboOnly) next.set('combo', '1');
    if (expiringOnly) next.set('exp', '1');
    if (sort !== 'spread') next.set('sort', sort);
    if (next.toString() !== params.toString()) setSearchParams(next, { replace: true });
  }, [selected, cases, q, ptype, brand, onlyDiff, minDiff, tsOnly, comboOnly, expiringOnly, sort]);

  const { data: options } = useQuery({ queryKey: ['compare-options'], queryFn: compare.options });
  const ready = selected.length >= 2 && selected.length <= 3;
  const { data, isLoading, error } = useQuery({
    queryKey: ['compare-rips', selected, cases, q, ptype, brand, onlyDiff, minDiff, tsOnly, comboOnly, expiringOnly, sort],
    queryFn: () => compare.rips({
      wholesalers: selected.join(','), cases, q: q || undefined,
      product_type: ptype || undefined, brand: brand || undefined,
      only_differences: onlyDiff || undefined, min_diff: minDiff,
      time_sensitive_only: tsOnly || undefined,
      combo_only: comboOnly || undefined, expiring_only: expiringOnly || undefined, sort,
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
        <h2><Layers size={20} style={{ verticalAlign: '-3px', marginRight: 8 }} />Compare Rebates (RIPs)</h2>
        <p className="rip2-lede">
          A RIP is a rebate that gets bigger the more you buy. The same bottle can rebate
          very differently at each distributor. Pick how many cases you plan to buy and
          see who actually costs less, when the rebate starts, how big it gets, and how
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
              <div className="rip2-rail-label">Distributors to compare (2–3)</div>
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
                Only show products where the cheapest distributor beats the rest by at
                least this much per case at {cases} case{cases !== 1 ? 's' : ''}. Set to $0 to show every match.
              </div>
            </div>

            <div className="rip2-rail-sect">
              <div className="rip2-rail-label">Show only</div>
              <label className="rip2-toggle" title="Hide products where every distributor lands at the same price at your volume.">
                <input type="checkbox" checked={onlyDiff} onChange={e => setOnlyDiff(e.target.checked)} /> Real differences
              </label>
              <label className="rip2-toggle" title="Only products where a distributor's rebate is a limited-time deal.">
                <input type="checkbox" checked={tsOnly} onChange={e => setTsOnly(e.target.checked)} /> Time-limited rebates
              </label>
              <label className="rip2-toggle" title="Only products where a rebate ends this month (buy-now urgency).">
                <input type="checkbox" checked={expiringOnly} onChange={e => setExpiringOnly(e.target.checked)} /> Ending soon
              </label>
              <label className="rip2-toggle" title="Only rebates you can qualify for by mixing several products.">
                <input type="checkbox" checked={comboOnly} onChange={e => setComboOnly(e.target.checked)} /> Mix-to-qualify
              </label>
            </div>

            <div className="rip2-rail-sect">
              <div className="rip2-rail-label">Sort by</div>
              <select value={sort} onChange={e => setSort(e.target.value)} className="rip2-select">
                <option value="spread">Biggest price gap</option>
                <option value="left_on_table">Most money at stake</option>
                <option value="min_cases">Easiest to unlock</option>
                <option value="best1">Best 1-case deal</option>
                <option value="deepest">Biggest rebate</option>
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
              Pick two or three distributors in the filters to compare how their rebates
              play out on the products they all carry.
            </div>
          )}
          {ready && isLoading && <p>Comparing rebates…</p>}
          {ready && !!error && <p className="text-red">Failed: {String((error as Error).message)}</p>}

          {ready && data && (
            <>
              {/* plain-language scoreboard */}
              <div className="rip2-cards">
                <div className="rip2-scard">
                  <div className="rip2-scard-n">{data.total_common.toLocaleString()}</div>
                  <div className="rip2-scard-l">products all of them rebate</div>
                </div>
                {selected.map(w => (
                  <div className="rip2-scard" key={w} style={{ borderTop: `3px solid ${accent[w]}` }}>
                    <div className="rip2-scard-n">{sum?.wins_at_n[w] ?? 0}</div>
                    <div className="rip2-scard-l">{distributorName(w)} is cheapest at {cases} cs</div>
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

              <div className="rip2-count">{rows.length.toLocaleString()} products</div>

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
                              {!r.proof_match && (
                                <span className="rip2-warn" title="The distributors list different proof/ABV for this barcode — double-check it's the same item before comparing.">
                                  <AlertTriangle size={11} /> proof differs
                                </span>
                              )}
                              {r.flips && (
                                <span className="rip2-flip" title="Which distributor is cheapest changes depending on how many cases you buy.">
                                  <Zap size={11} /> winner changes with volume
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="rip2-verdict-banner">
                          {winName ? (
                            <>
                              <Trophy size={14} style={{ color: accent[win!] }} />
                              <span><strong style={{ color: accent[win!] }}>{winName}</strong> is cheapest at {cases} cases
                                {r.spread_at_n ? <> — {money(r.spread_at_n)}/case less</> : null}
                                {r.left_on_table ? <span className="rip2-stake"> · {money(r.left_on_table)} at stake</span> : null}
                              </span>
                            </>
                          ) : <span className="text-muted">Tie at {cases} cases</span>}
                        </div>
                        <div onClick={e => e.stopPropagation()}>
                          <RowActions
                            productName={r.dists[win && win !== 'tie' ? win : selected[0]]?.product_name ?? r.product_name}
                            wholesaler={win && win !== 'tie' ? win : selected[0]}
                            upc={r.dists[win && win !== 'tie' ? win : selected[0]]?.upc ?? undefined}
                            unitVolume={r.unit_volume ?? undefined} unitQty={r.unit_qty ?? undefined} />
                        </div>
                      </div>

                      <div className="rip2-dists" style={{ gridTemplateColumns: `repeat(${selected.length}, 1fr)` }}>
                        {selected.map(w => (
                          <DistPanel key={w} w={w} d={r.dists[w]} row={r} cases={cases}
                            accent={accent[w]} isWinner={win === w} />
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
                      ? <>These distributors share no product that all of them rebate. Try Allied / Fedway / Opici, or just two of them.</>
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
    </div>
  );
}
