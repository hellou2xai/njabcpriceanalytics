import { Fragment, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { ChevronDown, ChevronRight, Zap, Layers, Sparkles, AlertTriangle } from 'lucide-react';
import { compare } from '../lib/api';
import type { CompareRipRow } from '../lib/api';
import { distributorName } from '../lib/distributors';
import ProductSearchBox from '../components/ProductSearchBox';
import RowActions from '../components/RowActions';
import './ComparePrices.css';
import './CompareRips.css';

const money = (v?: number | null) => (v == null ? '–' : `$${Number(v).toFixed(2)}`);
const ACCENTS = ['#2563eb', '#d97706', '#7c3aed'];
const DEFAULT = ['allied', 'fedway', 'opici'];

/** Step chart: landed $/case vs cases, one stepped line per distributor. */
function RipCurve({ row, slugs, accent }: { row: CompareRipRow; slugs: string[]; accent: Record<string, string> }) {
  const pts = row.curve;
  const vals = pts.flatMap(p => slugs.map(w => p.landed[w])).filter((v): v is number => typeof v === 'number');
  if (pts.length < 2 || !vals.length) return null;
  const W = 460, H = 150, padX = 44, padY = 14;
  const maxC = pts[pts.length - 1].cases;
  const min = Math.min(...vals), max = Math.max(...vals);
  const span = Math.max(0.0001, max - min);
  const x = (c: number) => padX + (Math.min(c, maxC) / maxC) * (W - padX - 12);
  const y = (v: number) => padY + (1 - (v - min) / span) * (H - padY * 2);
  return (
    <div className="rip-curve">
      <div className="rip-curve-title">Landed $/case as you buy more</div>
      <svg width={W} height={H + 18}>
        <text x={2} y={y(max) + 4} className="cmp-trend-tick">{money(max)}</text>
        <text x={2} y={y(min) + 4} className="cmp-trend-tick">{money(min)}</text>
        {pts.map(p => (
          <text key={p.cases} x={x(p.cases)} y={H + 13} textAnchor="middle" className="cmp-trend-tick">{p.cases}</text>
        ))}
        <text x={W / 2} y={H + 17} textAnchor="middle" className="cmp-trend-axis">cases</text>
        {slugs.map(w => {
          const seq = pts.map(p => ({ c: p.cases, v: p.landed[w] })).filter((q): q is { c: number; v: number } => typeof q.v === 'number');
          if (seq.length < 2) return null;
          // stepped path (price holds until the next tier unlocks)
          let d = `M${x(seq[0].c).toFixed(1)},${y(seq[0].v).toFixed(1)}`;
          for (let i = 1; i < seq.length; i++) {
            d += ` H${x(seq[i].c).toFixed(1)} V${y(seq[i].v).toFixed(1)}`;
          }
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

function RipDetail({ row, slugs, accent }: { row: CompareRipRow; slugs: string[]; accent: Record<string, string> }) {
  return (
    <div className="rip-detail">
      <div className="rip-detail-left">
        <RipCurve row={row} slugs={slugs} accent={accent} />
        <div className="rip-breakeven">
          <span className="rip-be-title">Break-even</span>
          {row.breakeven.filter(b => b.winner).map((b, i) => (
            <span key={i} className="rip-be-range">
              {b.from}{b.to ? `–${b.to}` : '+'} cs →{' '}
              <strong style={{ color: b.winner !== 'tie' ? accent[b.winner!] : 'var(--text-muted)' }}>
                {b.winner === 'tie' ? 'tie' : distributorName(b.winner!)}
              </strong>
            </span>
          ))}
        </div>
      </div>
      <div className="rip-ladders" style={{ gridTemplateColumns: `repeat(${slugs.length}, 1fr)` }}>
        {slugs.map(w => {
          const d = row.dists[w];
          return (
            <div key={w} className="rip-ladder" style={{ borderTop: `2px solid ${accent[w]}` }}>
              <div className="rip-ladder-head">{distributorName(w)}</div>
              <div className="rip-metrics">
                <span title="Cases needed to unlock any rebate">Unlocks @ <strong>{d.min_cases ?? '–'} cs</strong></span>
                <span title="Best rebate if you buy just 1 case">Best @1: <strong>{money(d.rip_at_1)}/cs</strong></span>
                {d.case_mix != null && d.case_mix > 1 && (
                  <span className="rip-combo" title="Qualifying quantity can be mixed across these many products">
                    mix {d.case_mix}
                  </span>
                )}
                {d.is_combination && <span className="rip-combo">combo RIP</span>}
              </div>
              {d.rip_code && <div className="rip-code">code {d.rip_code}</div>}
              <table className="rip-tier-table">
                <thead><tr><th>Buy</th><th title="Total off the list price per case">off list/cs</th><th>$/cs</th><th>$/btl</th></tr></thead>
                <tbody>
                  {d.rip_tiers.length === 0 && <tr><td colSpan={4} className="rip-none">no RIP tiers</td></tr>}
                  {d.rip_tiers.map((t, i) => (
                    <tr key={i}>
                      <td>{t.buy_label ?? `${t.cases_to_unlock ?? t.raw_qty} cs`}{t.code && t.code !== d.rip_code ? <span className="rip-tcode" title="RIP program code — rows sharing a code are tiers of the same deal"> {t.code}</span> : null}</td>
                      <td className="text-green">{d.frontline != null && t.price_after != null && d.frontline - t.price_after > 0.005 ? `−${money(d.frontline - t.price_after)}` : '–'}</td>
                      <td><strong>{money(t.price_after)}</strong></td>
                      <td>{t.price_after != null && row.unit_qty ? money(t.price_after / parseFloat(row.unit_qty)) : '–'}</td>
                      {t.is_time_sensitive && t.window_status !== 'expired' && (
                        <td className="rip-window">{t.from_date?.slice(5)}→{t.to_date?.slice(5)}</td>
                      )}
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
  const [selected, setSelected] = useState<string[]>(
    params.get('d')?.split(',').filter(Boolean) ?? DEFAULT);
  const [cases, setCases] = useState(parseInt(params.get('cases') ?? '5', 10) || 5);
  const [q, setQ] = useState(params.get('q') ?? '');
  const [ptype, setPtype] = useState(params.get('type') ?? '');
  const [onlyDiff, setOnlyDiff] = useState(params.get('diff') !== '0');
  const [sort, setSort] = useState(params.get('sort') ?? 'spread');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [shown, setShown] = useState(100);
  const navigate = useNavigate();
  const goToProduct = (name: string, wholesaler?: string) =>
    navigate(`/products?q=${encodeURIComponent(name)}${wholesaler ? `&wholesaler=${wholesaler}` : ''}`);

  useEffect(() => {
    const next = new URLSearchParams();
    if (selected.length) next.set('d', selected.join(','));
    if (cases !== 5) next.set('cases', String(cases));
    if (q) next.set('q', q);
    if (ptype) next.set('type', ptype);
    if (!onlyDiff) next.set('diff', '0');
    if (sort !== 'spread') next.set('sort', sort);
    if (next.toString() !== params.toString()) setSearchParams(next, { replace: true });
  }, [selected, cases, q, ptype, onlyDiff, sort]);

  const { data: options } = useQuery({ queryKey: ['compare-options'], queryFn: compare.options });
  const ready = selected.length >= 2 && selected.length <= 3;
  const { data, isLoading, error } = useQuery({
    queryKey: ['compare-rips', selected, cases, q, ptype, onlyDiff, sort],
    queryFn: () => compare.rips({
      wholesalers: selected.join(','), cases, q: q || undefined,
      product_type: ptype || undefined, only_differences: onlyDiff || undefined, sort,
    }),
    enabled: ready,
  });

  const accent = useMemo(() => {
    const m: Record<string, string> = {};
    selected.forEach((w, i) => { m[w] = ACCENTS[i % ACCENTS.length]; });
    return m;
  }, [selected]);
  const toggle = (w: string) => {
    setExpanded(null); setShown(100);
    setSelected(s => s.includes(w) ? s.filter(x => x !== w) : s.length >= 3 ? s : [...s, w]);
  };
  const types = useMemo(() => {
    const set = new Set<string>();
    (data?.rows ?? []).forEach(r => { if (r.product_type) set.add(r.product_type); });
    return [...set].sort();
  }, [data]);

  const rows = data?.rows ?? [];
  const sum = data?.summary;
  const nCols = selected.length + 5;

  return (
    <div className="page">
      <div className="cmp-head">
        <h2><Layers size={20} style={{ verticalAlign: '-3px', marginRight: 8 }} />Compare RIPs</h2>
      </div>

      <div className="cmp-picker">
        <span className="cmp-picker-label">RIP outcome across 2–3 distributors:</span>
        {(options ?? []).map(o => (
          <button key={o.wholesaler}
            className={`cmp-chip${selected.includes(o.wholesaler) ? ' on' : ''}`}
            style={selected.includes(o.wholesaler) ? { borderColor: accent[o.wholesaler], color: accent[o.wholesaler] } : undefined}
            onClick={() => toggle(o.wholesaler)}
            disabled={!selected.includes(o.wholesaler) && selected.length >= 3}>
            {distributorName(o.wholesaler)}
          </button>
        ))}
        {selected.length > 0 && <button className="cmp-clear" onClick={() => { setSelected([]); setExpanded(null); }}>Clear</button>}
      </div>

      {!ready && (
        <div className="cmp-empty">
          Pick two or three distributors to compare how their RIP rebates actually play
          out — a RIP isn't one price, it's a rebate that grows with volume, and the same
          product can RIP completely differently across distributors. Only products all of
          them carry a RIP on (and only valid barcodes) are compared.
        </div>
      )}

      {ready && (
        <div className="rip-volume">
          <label>Buying&nbsp;<strong>{cases}</strong>&nbsp;case{cases !== 1 ? 's' : ''}</label>
          <input type="range" min={1} max={50} value={cases} onChange={e => { setCases(parseInt(e.target.value, 10)); setShown(100); }} />
          <span className="rip-volume-hint">drag to see who wins at your volume</span>
        </div>
      )}

      {ready && isLoading && <p>Comparing RIP ladders…</p>}
      {ready && !!error && <p className="text-red">Failed: {String((error as Error).message)}</p>}

      {ready && data && (
        <>
          <div className="cmp-cards">
            <div className="cmp-card">
              <div className="cmp-card-n">{data.total_common.toLocaleString()}</div>
              <div className="cmp-card-l">products RIP'd by all</div>
            </div>
            {selected.map(w => (
              <div className="cmp-card" key={w} style={{ borderTop: `3px solid ${accent[w]}` }}>
                <div className="cmp-card-n">{sum?.wins_at_n[w] ?? 0}</div>
                <div className="cmp-card-l">{distributorName(w)} best @{cases}</div>
              </div>
            ))}
            <div className="cmp-card">
              <div className="cmp-card-n">{sum?.ties ?? 0}</div>
              <div className="cmp-card-l">ties @{cases}</div>
            </div>
            <div className="cmp-card">
              <div className="cmp-card-n"><Zap size={15} style={{ verticalAlign: '-2px' }} /> {sum?.flips ?? 0}</div>
              <div className="cmp-card-l">flip with volume</div>
            </div>
          </div>

          {!!sum?.insights?.length && (
            <div className="cmp-insights">
              {sum.insights.map((t, i) => <div key={i} className="cmp-insight">💡 {t}</div>)}
            </div>
          )}

          <div className="cmp-filters">
            <ProductSearchBox value={q} placeholder="Search product or brand…"
              onChange={v => { setQ(v); setShown(100); }}
              onSelect={p => { setQ(p.product_name); setShown(100); }} />
            <select value={ptype} onChange={e => setPtype(e.target.value)}>
              <option value="">All categories</option>
              {types.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            <label className="cmp-check" title="Only products where the cheaper distributor differs at your volume (or flips)">
              <input type="checkbox" checked={onlyDiff} onChange={e => setOnlyDiff(e.target.checked)} />
              Only differences
            </label>
            <select value={sort} onChange={e => setSort(e.target.value)}>
              <option value="spread">Biggest $/cs gap</option>
              <option value="min_cases">Fewest cases to unlock</option>
              <option value="best1">Best 1-case rebate</option>
              <option value="product">Product name</option>
            </select>
            <span className="cmp-count">{rows.length.toLocaleString()} rows</span>
          </div>

          <div className="table-container">
            <table className="dense-table cmp-table rip-table">
              <thead>
                <tr>
                  <th>Product</th>
                  {selected.map(w => (
                    <th key={w} style={{ color: accent[w] }}>
                      {distributorName(w)}<span className="cmp-ed">landed @{cases}</span>
                    </th>
                  ))}
                  <th>Gap</th>
                  <th>Best @{cases}</th>
                  <th>AI verdict</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, shown).map(r => {
                  const isOpen = expanded === r.match_key;
                  const win = r.winner_at_n;
                  return (
                    <Fragment key={r.match_key}>
                      <tr className="clickable" onClick={() => setExpanded(isOpen ? null : r.match_key)}>
                        <td className="cmp-prod">
                          {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                          <span className="cmp-prod-name" onClick={e => {
                            e.stopPropagation();
                            const w = win && win !== 'tie' ? win : selected[0];
                            goToProduct(r.dists[w]?.product_name ?? r.product_name, w);
                          }}>{r.product_name}</span>
                          <span className="cmp-size">{r.unit_qty} × {r.unit_volume}</span>
                          {!r.proof_match && (
                            <span className="rip-proofwarn" title="Distributors list different proof/ABV for this barcode — verify it's the same item">
                              <AlertTriangle size={11} /> proof?
                            </span>
                          )}
                          {r.flips && <span className="cmp-flip"><Zap size={11} /> flips</span>}
                        </td>
                        {selected.map(w => {
                          const d = r.dists[w];
                          const isW = win === w;
                          return (
                            <td key={w} className={`cmp-price${isW ? ' cmp-win' : ''}${win === 'tie' ? ' cmp-tie' : ''}`}>
                              {money(d?.landed_at_n)}
                              <span className="cmp-sub">
                                {d?.min_cases ? `RIP@${d.min_cases}cs` : 'no RIP@vol'}
                              </span>
                            </td>
                          );
                        })}
                        <td className="cmp-spread">{r.spread_at_n ? money(r.spread_at_n) : '–'}</td>
                        <td>{win && win !== 'tie'
                          ? <span className="cmp-winner" style={{ color: accent[win] }}>{distributorName(win)}</span>
                          : <span className="cmp-tie-label">Tie</span>}
                        </td>
                        <td className="rip-verdict-cell">
                          <span className="rip-verdict-badge"><Sparkles size={11} /></span>
                          {r.verdict.text}
                        </td>
                        <td className="cmp-actions">
                          <RowActions
                            productName={r.dists[win && win !== 'tie' ? win : selected[0]]?.product_name ?? r.product_name}
                            wholesaler={win && win !== 'tie' ? win : selected[0]}
                            upc={r.dists[win && win !== 'tie' ? win : selected[0]]?.upc ?? undefined}
                            unitVolume={r.unit_volume ?? undefined}
                            unitQty={r.unit_qty ?? undefined}
                          />
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="cmp-expand-row">
                          <td colSpan={nCols}><RipDetail row={r} slugs={selected} accent={accent} /></td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
                {rows.length === 0 && (
                  <tr><td colSpan={nCols} className="cmp-none">
                    {data.total_common === 0
                      ? <>These distributors share no product that all of them put a RIP on. Try the Allied / Fedway / Opici trio, or just two of them.</>
                      : onlyDiff
                        ? <>All {data.total_common.toLocaleString()} shared-RIP products land at the same price at {cases} cases — untick “Only differences” to see them.</>
                        : <>No shared-RIP products match the filters.</>}
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
          {rows.length > shown && (
            <button className="btn cmp-more" onClick={() => setShown(s => s + 200)}>
              Show more ({(rows.length - shown).toLocaleString()} remaining)
            </button>
          )}
        </>
      )}
    </div>
  );
}
