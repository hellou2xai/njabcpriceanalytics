import { Fragment, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { ChevronDown, ChevronRight, Zap, Scale } from 'lucide-react';
import { compare, catalog } from '../lib/api';
import type { CatalogTier, CompareLadder } from '../lib/api';
import { distributorName } from '../lib/distributors';
import AddToCartButton from '../components/AddToCartButton';
import FavoriteButton from '../components/FavoriteButton';
import CloseoutFlagButton from '../components/CloseoutFlagButton';
import './ComparePrices.css';

const money = (v?: number | null) => (v == null ? '–' : `$${Number(v).toFixed(2)}`);

/** Distributor accent colors (cycled by pick order). */
const ACCENTS = ['#2563eb', '#d97706', '#7c3aed'];

function WinnerCell({
  value, isWinner, isTie, sub,
}: { value?: number | null; isWinner: boolean; isTie: boolean; sub?: string | null }) {
  return (
    <td className={`cmp-price${isWinner ? ' cmp-win' : ''}${isTie ? ' cmp-tie' : ''}`}>
      {money(value)}
      {sub && <span className="cmp-sub">{sub}</span>}
    </td>
  );
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtMonth = (ed: string) => {
  const m = /^(\d{4})-(\d{1,2})/.exec(ed);
  return m ? `${MONTHS[parseInt(m[2], 10) - 1]} ${m[1].slice(2)}` : ed;
};

interface HistPoint {
  edition: string;
  frontline_case_price?: number | null;
  best_case_price?: number | null;
  effective_case_price?: number | null;
}

/** Per-distributor sparkline: up to 3 lines across editions — List,
 *  After QD (best_case_price) and After RIP (effective). Lines collapse
 *  onto each other when layers are equal; hover any point for the month's
 *  full three-price readout. */
function TriSparkline({ wholesaler, ladder }: { wholesaler: string; ladder: CompareLadder }) {
  const { data } = useQuery({
    queryKey: ['price-history', wholesaler, ladder.product_name, ladder.upc,
               ladder.unit_volume, ladder.unit_qty, ladder.vintage],
    queryFn: () => catalog.priceHistory(wholesaler, ladder.product_name!, {
      upc: ladder.upc ?? undefined,
      unit_volume: ladder.unit_volume ?? undefined,
      unit_qty: ladder.unit_qty ?? undefined,
      vintage: ladder.vintage ?? undefined,
    }),
    enabled: !!ladder.product_name,
    staleTime: 5 * 60_000,
  });

  const points: HistPoint[] = (data?.history ?? []) as HistPoint[];
  if (points.length === 1) {
    // first month on record (e.g. newly onboarded distributor) — no trend yet
    return <span className="cmp-tri-flat">{fmtMonth(points[0].edition)} only — no history yet</span>;
  }
  if (points.length < 2) return null;

  const LAYERS: { key: keyof HistPoint; label: string; color: string; dash?: string }[] = [
    { key: 'frontline_case_price', label: 'List', color: 'var(--text-muted)', dash: '4 3' },
    { key: 'best_case_price', label: 'After QD', color: '#2563eb' },
    { key: 'effective_case_price', label: 'After RIP', color: '#16a34a' },
  ];
  const vals = points.flatMap(p => LAYERS.map(l => p[l.key]))
    .filter((v): v is number => typeof v === 'number');
  if (!vals.length) return null;

  const W = 230, H = 56, padX = 6, padY = 6;
  const min = Math.min(...vals), max = Math.max(...vals);
  const span = Math.max(0.0001, max - min);
  const x = (i: number) => padX + (i / (points.length - 1)) * (W - padX * 2);
  const y = (v: number) => padY + (1 - (v - min) / span) * (H - padY * 2);
  const money = (v?: number | null) => (typeof v === 'number' ? `$${v.toFixed(2)}` : '–');
  const tip = (p: HistPoint) =>
    `${fmtMonth(p.edition)} · List ${money(p.frontline_case_price)}`
    + ` · After QD ${money(p.best_case_price)} · After RIP ${money(p.effective_case_price)}`;

  // which layers actually exist (a no-RIP product collapses to 2 lines)
  const present = LAYERS.filter(l =>
    points.some(p => typeof p[l.key] === 'number'));

  return (
    <span className="cmp-tri">
      <svg width={W} height={H}>
        {present.map(l => {
          const pts = points
            .map((p, i) => ({ i, v: p[l.key] }))
            .filter((q): q is { i: number; v: number } => typeof q.v === 'number');
          if (pts.length < 2) return null;
          const d = pts.map((q, j) =>
            `${j === 0 ? 'M' : 'L'}${x(q.i).toFixed(1)},${y(q.v).toFixed(1)}`).join(' ');
          return <path key={l.label} d={d} fill="none" stroke={l.color}
                       strokeWidth={1.6} strokeDasharray={l.dash} />;
        })}
        {points.map((p, i) => {
          const v = p.effective_case_price ?? p.best_case_price ?? p.frontline_case_price;
          if (typeof v !== 'number') return null;
          return (
            <circle key={p.edition} cx={x(i)} cy={y(v)} r={5}
                    fill="transparent" stroke="none" pointerEvents="all">
              <title>{tip(p)}</title>
            </circle>
          );
        })}
      </svg>
      <span className="cmp-tri-leg">
        <span style={{ color: 'var(--text-muted)' }}>┄ List</span>
        <span style={{ color: '#2563eb' }}>— QD</span>
        <span style={{ color: '#16a34a' }}>— RIP</span>
      </span>
    </span>
  );
}

function LadderPanel({ slugs, params }: { slugs: string[]; params: Record<string, unknown> }) {
  const { data, isLoading } = useQuery({
    queryKey: ['compare-tiers', params],
    queryFn: () => compare.tiers(params),
  });
  if (isLoading) return <div className="cmp-ladder-loading">Loading deal ladders…</div>;
  if (!data) return null;
  return (
    <div className="cmp-ladders" style={{ gridTemplateColumns: `repeat(${slugs.length}, 1fr)` }}>
      {slugs.map(w => {
        const lad = data.ladders[w];
        return (
          <div key={w} className="cmp-ladder">
            <div className="cmp-ladder-head">
              <span>{distributorName(w)}</span>
              {lad && <TriSparkline wholesaler={w} ladder={lad} />}
            </div>
            {!lad ? <div className="cmp-ladder-none">Not found</div> : (
              <>
                <div className="cmp-ladder-line cmp-ladder-front">
                  Frontline → <strong>{money(lad.frontline)}</strong>/cs
                </div>
                {(lad.tiers ?? []).length === 0 && (
                  <div className="cmp-ladder-none">No QD or RIP tiers</div>
                )}
                {(lad.tiers ?? []).map((t: CatalogTier, i: number) => (
                  <div key={i} className="cmp-ladder-line">
                    <span className={`prod-deal-badge ${t.source === 'rip' ? 'prod-deal-rip' : 'prod-deal-qd'}`}>
                      {t.source === 'rip' ? 'RIP' : 'QD'}
                    </span>
                    {' '}Buy {t.qty} {t.unit} → <strong>{money(t.price_after)}</strong>/cs
                    {t.save_per_case != null && (
                      <span className="cmp-ladder-off"> (−{money(t.save_per_case)})</span>
                    )}
                    {t.is_time_sensitive && t.window_status !== 'expired' && (
                      <span className="cmp-ladder-window">
                        {t.from_date?.slice(5)}→{t.to_date?.slice(5)}
                      </span>
                    )}
                  </div>
                ))}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function ComparePrices() {
  const [params, setSearchParams] = useSearchParams();
  const [selected, setSelected] = useState<string[]>(
    params.get('d')?.split(',').filter(Boolean) ?? []);
  const [q, setQ] = useState(params.get('q') ?? '');
  const [ptype, setPtype] = useState(params.get('type') ?? '');
  // default ON: open straight to the rows where distributors actually differ
  const [onlyDiff, setOnlyDiff] = useState(params.get('diff') !== '0');
  const [minSpread, setMinSpread] = useState(params.get('min') ?? '');
  const [sortKey, setSortKey] = useState(params.get('s') ?? 'product');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>(params.get('dir') === 'desc' ? 'desc' : 'asc');
  const [expanded, setExpanded] = useState<string | null>(null);
  const PAGE_SIZES = [50, 100, 250, 500, 1000];
  const [pageSize, setPageSize] = useState(() => {
    const v = parseInt(params.get('pp') ?? '100', 10);
    return PAGE_SIZES.includes(v) ? v : 100;
  });
  const [shown, setShown] = useState(pageSize);
  const navigate = useNavigate();
  const goToProduct = (name: string, wholesaler?: string) =>
    navigate(`/products?q=${encodeURIComponent(name)}${wholesaler ? `&wholesaler=${wholesaler}` : ''}`);

  // URL sync (shareable / survives Back)
  useEffect(() => {
    const next = new URLSearchParams();
    if (selected.length) next.set('d', selected.join(','));
    if (q) next.set('q', q);
    if (ptype) next.set('type', ptype);
    if (!onlyDiff) next.set('diff', '0');
    if (minSpread) next.set('min', minSpread);
    if (sortKey !== 'product') next.set('s', sortKey);
    if (sortDir !== 'asc') next.set('dir', sortDir);
    if (pageSize !== 100) next.set('pp', String(pageSize));
    if (next.toString() !== params.toString()) setSearchParams(next, { replace: true });
  }, [selected, q, ptype, onlyDiff, minSpread, sortKey, sortDir, pageSize]);

  // page-size change resets the visible window
  useEffect(() => { setShown(pageSize); }, [pageSize]);

  const { data: options } = useQuery({
    queryKey: ['compare-options'],
    queryFn: compare.options,
  });

  const ready = selected.length >= 2 && selected.length <= 3;
  const { data, isLoading, error } = useQuery({
    queryKey: ['compare-products', selected, q, ptype, onlyDiff, minSpread],
    queryFn: () => compare.products({
      wholesalers: selected.join(','),
      q: q || undefined,
      product_type: ptype || undefined,
      only_differences: onlyDiff || undefined,
      min_spread: minSpread ? parseFloat(minSpread) : undefined,
    }),
    enabled: ready,
  });

  const toggle = (w: string) => {
    setExpanded(null);
    setShown(pageSize);
    setSelected(s => s.includes(w) ? s.filter(x => x !== w)
      : s.length >= 3 ? s : [...s, w]);
  };

  const accent = useMemo(() => {
    const m: Record<string, string> = {};
    selected.forEach((w, i) => { m[w] = ACCENTS[i % ACCENTS.length]; });
    return m;
  }, [selected]);

  const types = useMemo(() => {
    const set = new Set<string>();
    (data?.rows ?? []).forEach(r => { if (r.product_type) set.add(r.product_type); });
    return [...set].sort();
  }, [data]);

  const winnerName = (w: string | null) =>
    w == null ? '–' : w === 'tie' ? 'Tie' : distributorName(w);

  // ---- client-side sorting: every column is sortable ----
  const clickSort = (key: string, numericDefault: 'asc' | 'desc' = 'asc') => {
    setShown(pageSize);
    if (sortKey === key) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'product' || key === 'winner' ? 'asc' : numericDefault);
    }
  };

  const arrow = (key: string) =>
    sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';

  const rows = useMemo(() => {
    const base = [...(data?.rows ?? [])];
    const dir = sortDir === 'asc' ? 1 : -1;
    const missing = sortDir === 'asc' ? Infinity : -Infinity;
    const val = (r: (typeof base)[number]): string | number => {
      if (sortKey === 'product') return (r.product_name || '').toLowerCase();
      if (sortKey === 'winner') return r.winner_effective === 'tie' ? 'zzz-tie'
        : (r.winner_effective ? distributorName(r.winner_effective).toLowerCase() : 'zzzz');
      if (sortKey === 'spread') return r.spread ?? missing;
      if (sortKey === 'spread_pct') return r.spread_pct ?? missing;
      const [w, field] = sortKey.split('::');
      const p = r.prices[w] as Record<string, unknown> | undefined;
      const v = p?.[field];
      return typeof v === 'number' ? v : missing;
    };
    base.sort((a, b) => {
      const va = val(a), vb = val(b);
      if (typeof va === 'string' || typeof vb === 'string') {
        return String(va) < String(vb) ? -dir : String(va) > String(vb) ? dir : 0;
      }
      return (va as number) < (vb as number) ? -dir : (va as number) > (vb as number) ? dir : 0;
    });
    return base;
  }, [data, sortKey, sortDir]);

  const sum = data?.summary;
  const nCols = selected.length * 3 + 4;

  return (
    <div className="page">
      {/* wrapper keeps this h2 out of the global `.page > h2` sticky rule,
          whose negative margins clipped the picker row below it */}
      <div className="cmp-head">
        <h2><Scale size={20} style={{ verticalAlign: '-3px', marginRight: 8 }} />Compare Prices</h2>
      </div>

      {/* ---- distributor picker ---- */}
      <div className="cmp-picker">
        <span className="cmp-picker-label">Pick 2–3 distributors:</span>
        {(options ?? []).map(o => (
          <button
            key={o.wholesaler}
            className={`cmp-chip${selected.includes(o.wholesaler) ? ' on' : ''}`}
            style={selected.includes(o.wholesaler)
              ? { borderColor: accent[o.wholesaler], color: accent[o.wholesaler] } : undefined}
            onClick={() => toggle(o.wholesaler)}
            disabled={!selected.includes(o.wholesaler) && selected.length >= 3}
            title={!selected.includes(o.wholesaler) && selected.length >= 3
              ? 'Maximum 3 — deselect one first'
              : `${o.products.toLocaleString()} products · edition ${o.edition ?? '–'}`}
          >
            {distributorName(o.wholesaler)}
            <span className="cmp-chip-n">{o.products.toLocaleString()}</span>
          </button>
        ))}
        {selected.length > 0 && (
          <button className="cmp-clear" onClick={() => { setSelected([]); setExpanded(null); }}>
            Clear
          </button>
        )}
      </div>

      {!ready && (
        <div className="cmp-empty">
          Select two or three distributors above to compare every product they have
          in common — list price, price after quantity discounts (QD), and the
          effective price after RIP rebates. Only common products are shown, so
          every row is a real head-to-head.
        </div>
      )}

      {ready && isLoading && <p>Comparing catalogues…</p>}
      {ready && !!error && <p className="text-red">Failed to compare: {String((error as Error).message)}</p>}

      {ready && data && (
        <>
          {/* ---- summary scoreboard ---- */}
          <div className="cmp-cards">
            <div className="cmp-card">
              <div className="cmp-card-n">{data.total_common.toLocaleString()}</div>
              <div className="cmp-card-l">products in common</div>
            </div>
            {selected.map(w => (
              <div className="cmp-card" key={w} style={{ borderTop: `3px solid ${accent[w]}` }}>
                <div className="cmp-card-n">{sum?.wins_effective[w] ?? 0}</div>
                <div className="cmp-card-l">{distributorName(w)} cheapest</div>
              </div>
            ))}
            <div className="cmp-card">
              <div className="cmp-card-n">{sum?.ties ?? 0}</div>
              <div className="cmp-card-l">ties</div>
            </div>
            <div className="cmp-card">
              <div className="cmp-card-n"><Zap size={16} style={{ verticalAlign: '-2px' }} /> {sum?.deal_flips ?? 0}</div>
              <div className="cmp-card-l">winner flips after deals</div>
            </div>
            <div className="cmp-card cmp-card-save">
              <div className="cmp-card-n">{money(sum?.total_spread)}</div>
              <div className="cmp-card-l">on the table / case-each</div>
            </div>
          </div>

          {/* ---- smart insights ---- */}
          {!!sum?.insights?.length && (
            <div className="cmp-insights">
              {sum.insights.map((t, i) => <div key={i} className="cmp-insight">💡 {t}</div>)}
            </div>
          )}

          {/* ---- filters ---- */}
          <div className="cmp-filters">
            <input
              placeholder="Search product or brand…"
              value={q}
              onChange={e => { setQ(e.target.value); setShown(pageSize); }}
            />
            <select value={ptype} onChange={e => setPtype(e.target.value)}>
              <option value="">All categories</option>
              {types.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            <label className="cmp-check" title="Untick to include products priced identically at every selected distributor">
              <input type="checkbox" checked={onlyDiff} onChange={e => setOnlyDiff(e.target.checked)} />
              Only differences
            </label>
            <input
              className="cmp-min"
              type="number"
              min={0}
              placeholder="Min $ spread"
              value={minSpread}
              onChange={e => setMinSpread(e.target.value)}
            />
            <span className="cmp-hint">Click any column header to sort</span>
            <label className="cmp-pp">
              Rows/page
              <select value={pageSize} onChange={e => setPageSize(parseInt(e.target.value, 10))}>
                {PAGE_SIZES.map(n => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            <span className="cmp-count">{rows.length.toLocaleString()} rows</span>
          </div>

          {/* ---- comparison grid ---- */}
          <div className="table-container">
            <table className="dense-table cmp-table">
              <thead>
                <tr>
                  <th rowSpan={2} className="cmp-sortable" onClick={() => clickSort('product')}>
                    Product{arrow('product')}
                  </th>
                  {selected.map(w => (
                    <th key={w} colSpan={3} className="cmp-group-head"
                        style={{ borderBottom: `2px solid ${accent[w]}` }}>
                      {distributorName(w)}
                      <span className="cmp-ed">{data.editions[w]}</span>
                    </th>
                  ))}
                  <th rowSpan={2} className="cmp-sortable" onClick={() => clickSort('spread', 'desc')}>
                    Spread{arrow('spread')}
                  </th>
                  <th rowSpan={2} className="cmp-sortable" onClick={() => clickSort('winner')}>
                    Winner{arrow('winner')}
                  </th>
                  <th rowSpan={2}></th>
                </tr>
                <tr>
                  {selected.map(w => (
                    <Fragment key={w}>
                      <th className="cmp-layer cmp-sortable" onClick={() => clickSort(`${w}::frontline`)}>
                        List{arrow(`${w}::frontline`)}
                      </th>
                      <th className="cmp-layer cmp-sortable" onClick={() => clickSort(`${w}::after_qd`)}>
                        After QD{arrow(`${w}::after_qd`)}
                      </th>
                      <th className="cmp-layer cmp-sortable" onClick={() => clickSort(`${w}::effective`)}
                          title="Effective price: after quantity discounts + best full-month RIP rebate">
                        After RIP{arrow(`${w}::effective`)}
                      </th>
                    </Fragment>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, shown).map(r => {
                  const isOpen = expanded === r.match_key;
                  const winner = r.winner_effective;
                  return (
                    <Fragment key={r.match_key}>
                      <tr className="clickable" onClick={() => setExpanded(isOpen ? null : r.match_key)}>
                        <td className="cmp-prod">
                          {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                          <span
                            className="cmp-prod-name"
                            onClick={e => {
                              e.stopPropagation();
                              const w = winner && winner !== 'tie' ? winner : selected[0];
                              goToProduct(r.prices[w]?.product_name ?? r.product_name, w);
                            }}
                          >
                            {r.product_name}
                          </span>
                          <span className="cmp-size">
                            {r.unit_qty} × {r.unit_volume}{r.vintage ? ` · ${r.vintage}` : ''}
                          </span>
                          {r.deal_flip && (
                            <span
                              className="cmp-flip"
                              title={`${winnerName(r.winner_frontline)} is cheaper at list, but ${winnerName(r.winner_effective)} wins after QD/RIP deals`}
                            >
                              <Zap size={11} /> flips
                            </span>
                          )}
                        </td>
                        {selected.map(w => {
                          const p = r.prices[w];
                          return (
                            <Fragment key={w}>
                              <WinnerCell value={p?.frontline}
                                isWinner={r.winner_frontline === w} isTie={r.winner_frontline === 'tie'} />
                              <WinnerCell value={p?.after_qd}
                                isWinner={r.winner_after_qd === w} isTie={r.winner_after_qd === 'tie'} />
                              <WinnerCell value={p?.effective}
                                isWinner={winner === w} isTie={winner === 'tie'}
                                sub={p?.btl_effective != null ? `${money(p.btl_effective)}/btl` : null} />
                            </Fragment>
                          );
                        })}
                        <td className="cmp-spread">
                          {money(r.spread)}
                          {r.spread_pct != null && <span className="cmp-sub">{r.spread_pct}%</span>}
                        </td>
                        <td>
                          {winner && winner !== 'tie' ? (
                            <span className="cmp-winner" style={{ color: accent[winner] }}>
                              {distributorName(winner)}
                            </span>
                          ) : <span className="cmp-tie-label">Tie</span>}
                        </td>
                        <td onClick={e => e.stopPropagation()} className="cmp-actions">
                          {winner && winner !== 'tie' && (
                            <AddToCartButton
                              productName={r.prices[winner]?.product_name ?? r.product_name}
                              wholesaler={winner}
                              upc={r.prices[winner]?.upc ?? undefined}
                              unitVolume={r.unit_volume ?? undefined}
                              qtyCases={1}
                            />
                          )}
                          <FavoriteButton
                            productName={r.product_name}
                            wholesaler={winner && winner !== 'tie' ? winner : selected[0]}
                            upc={r.upc ?? undefined}
                            unitVolume={r.unit_volume ?? undefined}
                          />
                          <CloseoutFlagButton
                            productName={r.product_name}
                            wholesaler={winner && winner !== 'tie' ? winner : selected[0]}
                            upc={r.upc ?? undefined}
                            unitVolume={r.unit_volume ?? undefined}
                            unitQty={r.unit_qty ?? undefined}
                          />
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="cmp-expand-row">
                          <td colSpan={nCols}>
                            <LadderPanel
                              slugs={selected}
                              params={{
                                wholesalers: selected.join(','),
                                upc_norm: r.upc_norm,
                                size_key: r.size_key || undefined,
                              }}
                            />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
                {rows.length === 0 && (
                  <tr><td colSpan={nCols} className="cmp-none">
                    {data.total_common === 0 ? (
                      <>
                        These {selected.length} distributors have <strong>no products in common</strong> —
                        they likely serve different categories (beer houses overlap with beer houses,
                        wine/spirits houses with each other). Deselect one and try again.
                      </>
                    ) : onlyDiff ? (
                      <>All {data.total_common.toLocaleString()} common products matching the filters
                        are priced identically — untick “Only differences” to see them.</>
                    ) : (
                      <>No common products match the filters.</>
                    )}
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
          {rows.length > shown && (
            <button className="btn cmp-more" onClick={() => setShown(s => s + pageSize)}>
              Show {Math.min(pageSize, rows.length - shown).toLocaleString()} more
              ({(rows.length - shown).toLocaleString()} remaining)
            </button>
          )}
        </>
      )}
    </div>
  );
}
