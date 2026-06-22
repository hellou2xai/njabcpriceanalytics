import { useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { CalendarClock, ArrowRight, ArrowDownRight, ArrowUpRight, PlusCircle, MinusCircle, AlertTriangle, ChevronLeft, ChevronRight, Package, Repeat } from 'lucide-react';
import { compare } from '../lib/api';
import type { EditionRow } from '../lib/api';
import { distributorName, DISTRIBUTOR_NAMES, perUnitAbbr } from '../lib/distributors';
import ProductSearchBox from '../components/ProductSearchBox';
import FilterSidebar, { type FilterSection } from '../components/FilterSidebar';
import RowActions from '../components/RowActions';
import ProductThumb from '../components/ProductThumb';
import MonthEffectiveSparkline from '../components/MonthEffectiveSparkline';
import { buildSparkProps } from '../lib/promotionsSparkline';
import type { Price3moBlock, CatalogTier } from '../lib/api';
import { ErrorState } from '../components/DataState';
import DataLoading from '../components/DataLoading';
import './ComparePrices.css';
import './EditionCompare.css';

const money = (v?: number | null) => (v == null ? '–' : `$${Number(v).toFixed(2)}`);
const signed = (v?: number | null) => (v == null ? '–' : `${v > 0 ? '+' : ''}$${Math.abs(v).toFixed(2)}`);
const pct = (v?: number | null) => (v == null ? '' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`);

const LAYER_LABEL: Record<string, string> = {
  frontline: 'list', discount: 'discount', rip_gained: 'RIP added',
  rip_lost: 'RIP removed', rip_modified: 'RIP changed',
};

const CHANGES = [
  { v: '', label: 'All changes' },
  { v: 'increase', label: 'Net cost ↑' },
  { v: 'decrease', label: 'Net cost ↓' },
  { v: 'added', label: 'New items' },
  { v: 'removed', label: 'Removed' },
  { v: 'rip', label: 'RIP changed' },
  { v: 'qd', label: 'QD changed' },
];

const PAGE_SIZES = [50, 100, 200, 500];

// Directional sort options, framed for a buyer doing a month-over-month review.
// Each maps to the backend's (sort key, order). "Cost increase" = net cost rose
// most (act before reordering); "Cost drop" = fell most (buy / margin).
const SORT_OPTIONS = [
  { value: 'inc_dollar', label: 'Cost increase ($) — biggest first' },
  { value: 'drop_dollar', label: 'Cost drop ($) — biggest first' },
  { value: 'inc_pct', label: 'Cost increase (%) — biggest first' },
  { value: 'drop_pct', label: 'Cost drop (%) — biggest first' },
  { value: 'name', label: 'Product name (A–Z)' },
];
const SORT_MAP: Record<string, { sort: string; order: string }> = {
  inc_dollar: { sort: 'net_delta', order: 'desc' },
  drop_dollar: { sort: 'net_delta', order: 'asc' },
  inc_pct: { sort: 'net_delta_pct', order: 'desc' },
  drop_pct: { sort: 'net_delta_pct', order: 'asc' },
  name: { sort: 'product', order: 'asc' },
};

function DeltaPill({ r }: { r: EditionRow }) {
  if (r.status === 'added') return <span className="ec-pill ec-added"><PlusCircle size={12} /> New</span>;
  if (r.status === 'removed') return <span className="ec-pill ec-removed"><MinusCircle size={12} /> Removed</span>;
  if (!r.comparable) return <span className="ec-pill ec-warn"><AlertTriangle size={12} /> Not comparable</span>;
  const d = r.net_delta_case;
  if (d == null || Math.abs(d) < 0.005) return <span className="ec-pill ec-flat">No change</span>;
  const up = d > 0;
  return (
    <span className={`ec-pill ${up ? 'ec-up' : 'ec-down'}`}>
      {up ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}
      {signed(d)}/cs {pct(r.net_delta_pct)}
    </span>
  );
}

// The four-line cost breakdown (net cost, frontline, invoice-after-QD, RIP
// rebate) shared by the table's hover popover AND the card view, so the two can
// never drift. Each line shows older → newer; a changed line renders red on
// yellow (the .ec-bd-changed convention).
type BdLine = { label: string; a?: number | null; b?: number | null; d?: number | null; p?: number | null; aBtl?: number | null; bBtl?: number | null };
function bdRows(r: EditionRow): BdLine[] {
  const pack = Number(r.unit_qty) || 0;
  const btl = (v?: number | null) => (v != null && pack > 1 ? v / pack : null);
  // Three rows, each older -> newer: the price after the 1-case QD (front line),
  // after the best QD, and after RIP (the net cost). Bottle cost on every line.
  return [
    { label: 'Frontline Case Price', a: r.frontline_a, b: r.frontline_b, aBtl: btl(r.frontline_a), bBtl: btl(r.frontline_b) },
    { label: 'Price after best QD', a: r.invoice_a, b: r.invoice_b, aBtl: btl(r.invoice_a), bBtl: btl(r.invoice_b) },
    { label: 'Price after best RIP', a: r.net_a_case, b: r.net_b_case, d: r.net_delta_case, p: r.net_delta_pct, aBtl: r.net_a_btl, bBtl: r.net_b_btl },
  ];
}
function BreakdownBody({ r }: { r: EditionRow }) {
  const abbr = perUnitAbbr(r.unit_volume, r.unit_type);
  return (
    <tbody>
      {bdRows(r).map(l => {
        const changed = l.a != null && l.b != null && Math.abs(l.a - l.b) > 0.005;
        const hasBtl = l.aBtl != null || l.bBtl != null;
        return (
          <tr key={l.label} className={changed ? 'ec-bd-changed' : ''}>
            <td className="ec-bd-lab">{l.label}</td>
            <td className="ec-bd-val">{money(l.a)} → {money(l.b)}
              {l.d != null && Math.abs(l.d) > 0.005 && (
                <span className="ec-bd-d"> ({l.d > 0 ? '+' : ''}${Math.abs(l.d).toFixed(2)}{l.p != null ? `, ${pct(l.p)}` : ''})</span>
              )}
              {hasBtl && (
                <div className="ec-bd-btl">{money(l.aBtl)} → {money(l.bBtl)}/{abbr}</div>
              )}
            </td>
          </tr>
        );
      })}
    </tbody>
  );
}

// Card breakdown: three human-labelled rows, each on ONE line — Frontline Case
// Price, Price after best QD, Price after best RIP — showing older -> newer for
// case AND bottle, plus the best-QD / best-RIP buy-in detail (qualified cases,
// rebate total). Tier detail comes from the newer edition's ladder (price_3mo).
function CardBreakdown({ r, blocks, older, newer }: { r: EditionRow; blocks?: Price3moBlock[] | null; older?: string; newer?: string }) {
  const pack = Number(r.unit_qty) || 0;
  const abbr = perUnitAbbr(r.unit_volume, r.unit_type);
  const btl = (v?: number | null) => (v != null && pack > 1 ? v / pack : null);
  const blkA = blocks?.find(b => b.edition === older) ?? null;
  const blkB = blocks?.find(b => b.edition === newer) ?? null;
  const deepest = (src: 'discount' | 'rip'): CatalogTier | null => {
    const ts = (blkB?.tiers ?? []).filter(t => t.source === src && t.price_after != null
      && (src === 'rip' || !t.is_time_sensitive));
    return ts.length ? ts.reduce((x, y) => (y.price_after! < x.price_after! ? y : x)) : null;
  };
  const qdT = deepest('discount');
  const ripT = deepest('rip');
  const qty = (t: CatalogTier) => t.qualified_cases ?? t.qty;
  // Frontline AFTER the 1-case QD where one exists (disc1_price = frontline -
  // best 1cs discount; equals frontline when there's no 1cs discount). Falls
  // back to the raw frontline if the per-edition block is missing.
  const flA = blkA?.disc1_price ?? r.frontline_a ?? null;
  const flB = blkB?.disc1_price ?? r.frontline_b ?? null;
  // older -> newer; collapse to a single figure when nothing changed (a human
  // reads "$198.00", not "$198.00 -> $198.00").
  const span = (a?: number | null, b?: number | null, suffix = '') => {
    if (a == null && b == null) return null;
    const changed = a != null && b != null && Math.abs(a - b) > 0.005;
    return changed ? `${money(a)} → ${money(b)}${suffix}` : `${money(b ?? a)}${suffix}`;
  };
  const rows = [
    { lab: 'Frontline Case Price', a: flA, b: flB, aB: btl(flA), bB: btl(flB), det: null as string | null },
    { lab: 'Price after best QD', a: r.invoice_a, b: r.invoice_b, aB: btl(r.invoice_a), bB: btl(r.invoice_b),
      det: qdT ? `best @ ${qty(qdT)} cs` : null },
    { lab: 'Price after best RIP', a: r.net_a_case, b: r.net_b_case, aB: r.net_a_btl, bB: r.net_b_btl, rip: true,
      det: ripT ? `rebate ${money(ripT.amount)} @ ${qty(ripT)} cs` : null },
  ];
  return (
    <div className="ec-bd3">
      {rows.map(row => {
        if (row.a == null && row.b == null) return null;
        const changed = row.a != null && row.b != null && Math.abs(row.a - row.b) > 0.005;
        const cs = span(row.a, row.b);
        const bt = span(row.aB, row.bB, `/${abbr}`);
        return (
          <div key={row.lab} className={`ec-bd3-row${changed ? ' ec-bd3-changed' : ''}${row.rip ? ' ec-bd3-rip' : ''}`}>
            <span className="ec-bd3-lab">{row.lab}</span>
            <div className="ec-bd3-data">
              <span className="ec-bd3-cs">{cs}</span>
              {bt && <span className="ec-bd3-btl">{bt}</span>}
              {row.det && <span className="ec-bd3-det">{row.det}</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Card-view row: every datum the table row carries (product + size, net price
// for BOTH editions per case AND per unit, the change pill, what-moved layers,
// the full cost breakdown, and row actions). Changed values keep the red-on-
// yellow highlight. Same data as the table — no loss.
function EditionCard({ r, older, newer, wholesaler, onOpen, price3mo }: {
  r: EditionRow; older?: string; newer?: string; wholesaler: string;
  onOpen: (name: string) => void; price3mo?: Price3moBlock[] | null;
}) {
  const netChanged = r.status === 'both' && r.net_delta_case != null && Math.abs(r.net_delta_case) >= 0.005;
  const unitAbbr = perUnitAbbr(r.unit_volume, r.unit_type);
  const cls = r.status === 'added' ? 'ec-card--added'
    : r.status === 'removed' ? 'ec-card--removed'
    : netChanged ? (r.net_delta_case! > 0 ? 'ec-card--up' : 'ec-card--down')
    : 'ec-card--flat';
  const hasSpark = !!(price3mo && price3mo.length);
  return (
    <div className={`ec-card ${cls}`}>
      <div className="ec-card-head">
        <ProductThumb src={r.image_url ?? undefined} alt={r.product_name} size={48} expandable />
        <div className="ec-card-id">
          <span className="ec-card-name" onClick={() => onOpen(r.product_name)} title={r.product_name}>{r.product_name}</span>
          <span className="ec-card-sub">{r.unit_qty} × {r.unit_volume}</span>
        </div>
        <DeltaPill r={r} />
      </div>

      <div className="ec-card-prices">
        <div className="ec-card-pcol">
          <span className="ec-card-mlab">{older}</span>
          <span className="ec-card-pcase">{r.status === 'added' ? '—' : money(r.net_a_case)}</span>
          {r.status !== 'added' && <span className="ec-card-pbtl">{money(r.net_a_btl)}/{unitAbbr}</span>}
        </div>
        <ArrowRight size={16} className="ec-card-arrow" />
        <div className="ec-card-pcol">
          <span className="ec-card-mlab">{newer}</span>
          <span className={`ec-card-pcase${netChanged ? ' ec-changed-val' : ''}`}>{r.status === 'removed' ? '—' : money(r.net_b_case)}</span>
          {r.status !== 'removed' && <span className="ec-card-pbtl">{money(r.net_b_btl)}/{unitAbbr}</span>}
        </div>
      </div>

      {r.layers.length > 0 && (
        <div className="ec-card-layers ec-layers">
          {r.layers.map(l => (
            <span key={l} className={`ec-layer ${l.startsWith('rip') ? 'ec-layer-rip' : ''}`}>{LAYER_LABEL[l] ?? l}</span>
          ))}
        </div>
      )}

      {r.status === 'both' && (
        <CardBreakdown r={r} blocks={price3mo} older={older} newer={newer} />
      )}

      {hasSpark && (
        <div className="ec-card-spark" onClick={e => e.stopPropagation()}>
          <MonthEffectiveSparkline {...buildSparkProps({ unit_qty: r.unit_qty, unit_volume: r.unit_volume, price_3mo: price3mo })} />
        </div>
      )}

      {r.status !== 'removed' && (
        <div className="ec-card-actions">
          <RowActions productName={r.product_name} wholesaler={wholesaler}
            upc={r.upc ?? undefined} unitVolume={r.unit_volume ?? undefined} unitQty={r.unit_qty ?? undefined} />
        </div>
      )}
    </div>
  );
}

export default function EditionCompare() {
  const [params, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const [wholesaler, setWholesaler] = useState(params.get('w') ?? 'fedway');
  const [older, setOlder] = useState(params.get('a') ?? '');
  const [newer, setNewer] = useState(params.get('b') ?? '');
  const [q, setQ] = useState(params.get('q') ?? '');
  const [change, setChange] = useState(params.get('change') ?? '');
  // Buyer-meaningful, DIRECTIONAL sort for month-over-month: what got more
  // expensive (act before reordering / re-price) vs what got cheaper (buy /
  // margin), in $ and %. Default = biggest cost increase (the watch-out).
  const [sort, setSort] = useState(params.get('sort') ?? 'inc_dollar');
  // Client-side facets (the result set is fully returned, so these filter the
  // grid without another round-trip — same rail + behaviour as every list page).
  const [productType, setProductType] = useState('');
  const [sizes, setSizes] = useState<string[]>([]);
  const [layersSel, setLayersSel] = useState<string[]>([]);
  const [minPrice, setMinPrice] = useState('');
  const [maxPrice, setMaxPrice] = useState('');
  const [minChange, setMinChange] = useState('1');   // min ABS net-cost change $ (default $1: hide rounding noise)
  const [onlyChanged, setOnlyChanged] = useState(false);
  const [page, setPage] = useState(0);
  const [limit, setLimit] = useState(500);
  // Card view (default) vs table view. The card shows every column the table
  // does plus the inline breakdown; the table is the dense original. Persisted.
  const [view, setView] = useState<'cards' | 'table'>(
    () => (localStorage.getItem('ec-view') as 'cards' | 'table') || 'cards');
  useEffect(() => { localStorage.setItem('ec-view', view); }, [view]);
  // Hovered row for the styled "what changed" breakdown popover (fixed-position
  // so the table's overflow never clips it; changed lines render red on yellow).
  const [bd, setBd] = useState<{ r: EditionRow; left: number; top: number; above: boolean } | null>(null);

  const goToProduct = (name: string) =>
    navigate(`/products?q=${encodeURIComponent(name)}&wholesaler=${wholesaler}`);

  const { data: opts } = useQuery({
    queryKey: ['edition-options', wholesaler],
    queryFn: () => compare.editionOptions(wholesaler),
  });

  // default to latest two once options load (only if not set)
  useEffect(() => {
    if (opts && !newer) setNewer(opts.default_newer ?? '');
    if (opts && !older) setOlder(opts.default_older ?? '');
  }, [opts]);

  useEffect(() => {
    const next = new URLSearchParams();
    if (wholesaler !== 'fedway') next.set('w', wholesaler);
    if (older) next.set('a', older);
    if (newer) next.set('b', newer);
    if (q) next.set('q', q);
    if (change) next.set('change', change);
    if (sort !== 'inc_dollar') next.set('sort', sort);
    if (next.toString() !== params.toString()) setSearchParams(next, { replace: true });
  }, [wholesaler, older, newer, q, change, sort]);

  const sm = SORT_MAP[sort] ?? SORT_MAP.inc_dollar;
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['edition-compare', wholesaler, older, newer, q, change, sort],
    queryFn: () => compare.editions({
      wholesaler, older: older || undefined, newer: newer || undefined,
      match: q || undefined, change: change || undefined,
      sort: sm.sort, order: sm.order,
      // Pull the FULL comparison (endpoint caps at 50k); the page paginates
      // client-side. Without this the API defaulted to 3000, so the count was
      // wrong (it claimed all products compared but returned only 3000).
      limit: 50000,
    }),
    enabled: !!wholesaler && !!opts && !opts.single_edition,
  });

  const editions = opts?.editions ?? [];
  const rows = useMemo(() => data?.rows ?? [], [data]);
  const sum = data?.summary;

  // Facet options derived from the returned rows.
  const catOptions = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) { const c = r.product_type; if (c) m.set(c, (m.get(c) ?? 0) + 1); }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value, label: value, count }));
  }, [rows]);
  const sizeOptions = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) { const v = r.unit_volume; if (v) m.set(v, (m.get(v) ?? 0) + 1); }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([value, count]) => ({ value, label: value, count }));
  }, [rows]);
  const layerOptions = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) for (const l of (r.layers ?? [])) m.set(l, (m.get(l) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value, label: LAYER_LABEL[value] ?? value, count }));
  }, [rows]);

  // Apply the client-side facets to the (already server-filtered + sorted) rows.
  const filtered = useMemo(() => {
    let rs = rows;
    if (productType) rs = rs.filter(r => (r.product_type ?? '') === productType);
    if (sizes.length) rs = rs.filter(r => r.unit_volume != null && sizes.includes(r.unit_volume));
    if (layersSel.length) rs = rs.filter(r => (r.layers ?? []).some(l => layersSel.includes(l)));
    const lo = minPrice ? parseFloat(minPrice) : null;
    const hi = maxPrice ? parseFloat(maxPrice) : null;
    if (lo != null || hi != null) rs = rs.filter(r => {
      const p = r.net_b_case ?? r.net_a_case;
      if (p == null) return false;
      if (lo != null && p < lo) return false;
      if (hi != null && p > hi) return false;
      return true;
    });
    if (onlyChanged) rs = rs.filter(r => r.status !== 'both' || (r.net_delta_case != null && Math.abs(r.net_delta_case) >= 0.005));
    // Min net-cost change: drop tiny moves (added/removed items have no delta,
    // so they always pass — this only thresholds the changed rows).
    if (minChange) {
      const mc = parseFloat(minChange);
      rs = rs.filter(r => r.status !== 'both' || (r.net_delta_case != null && Math.abs(r.net_delta_case) >= mc));
    }
    return rs;
  }, [rows, productType, sizes, layersSel, minPrice, maxPrice, minChange, onlyChanged]);

  // Reset to the first page whenever the filtered set or page size changes.
  useEffect(() => { setPage(0); },
    [wholesaler, older, newer, q, change, sort, productType, sizes, layersSel, minPrice, maxPrice, minChange, onlyChanged, limit]);

  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const safePage = Math.min(page, totalPages - 1);
  const shown = filtered.slice(safePage * limit, (safePage + 1) * limit);
  const rangeFrom = total ? safePage * limit + 1 : 0;
  const rangeTo = Math.min((safePage + 1) * limit, total);

  // Sparklines (price_3mo + tier popover) are loaded ONLY for the visible card
  // page — attaching them to the full ~15k-row comparison would be far too
  // heavy. One batch call per page; a page change refetches, scrolling does not.
  const shownUpcs = useMemo(
    () => (view === 'cards' ? (shown.map(r => r.upc).filter(Boolean) as string[]) : []),
    [view, shown]);
  const { data: sparkMap } = useQuery({
    queryKey: ['ec-sparklines', wholesaler, shownUpcs],
    queryFn: () => compare.editionSparklines(wholesaler, shownUpcs),
    enabled: view === 'cards' && shownUpcs.length > 0,
    staleTime: 5 * 60_000,
  });

  const resetFilters = () => {
    setQ(''); setChange(''); setProductType(''); setSizes([]); setLayersSel([]);
    setMinPrice(''); setMaxPrice(''); setMinChange('1'); setOnlyChanged(false); setSort('inc_dollar');
  };

  const sections: FilterSection[] = [
    // Sort pinned to the TOP of the rail (it's the first decision a buyer makes
    // on a month-over-month review), with directional, buyer-meaningful options.
    { type: 'select', key: 'sort', title: 'Sort by', highlight: true, value: sort, onChange: setSort,
      options: SORT_OPTIONS },
    { type: 'custom', key: 'q', title: 'Search', render: () => (
      <ProductSearchBox value={q} placeholder="Product or brand…"
        onChange={v => setQ(v)} onSelect={p => setQ(p.product_name)} />
    ) },
    { type: 'pills', key: 'change', title: 'Change', value: change, onChange: setChange,
      options: CHANGES.map(c => ({ value: c.v, label: c.label })) },
    { type: 'select', key: 'cat', title: 'Category', placeholder: 'All categories',
      value: productType, onChange: setProductType, options: catOptions },
    { type: 'multi-pills', key: 'size', title: 'Size', values: sizes, onChange: setSizes, options: sizeOptions },
    { type: 'multi-pills', key: 'layers', title: 'What moved', values: layersSel, onChange: setLayersSel, options: layerOptions },
    { type: 'pills', key: 'min_change', title: 'Min change / case', value: minChange, onChange: setMinChange,
      options: [
        { value: '', label: 'Any' }, { value: '1', label: '$1+' }, { value: '5', label: '$5+' },
        { value: '10', label: '$10+' }, { value: '25', label: '$25+' }, { value: '50', label: '$50+' },
      ] },
    { type: 'range', key: 'price', title: 'Net price / case', min: minPrice, max: maxPrice,
      onMinChange: setMinPrice, onMaxChange: setMaxPrice, minPlaceholder: 'Min $', maxPlaceholder: 'Max $' },
    { type: 'toggle', key: 'changed', title: 'Only changed', value: onlyChanged, onChange: setOnlyChanged, label: 'Hide unchanged rows' },
  ];

  const Pager = ({ where }: { where: 'top' | 'bottom' }) => (
    <div className={`ec-pager ec-pager-${where}`}>
      {where === 'top' && (
        <label className="ec-pagesize">Rows per page
          <select value={limit} onChange={e => setLimit(parseInt(e.target.value, 10))}>
            {PAGE_SIZES.map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
      )}
      <span className="ec-pageinfo">
        {total ? `${rangeFrom.toLocaleString()}–${rangeTo.toLocaleString()} of ${total.toLocaleString()}` : '0 rows'}
      </span>
      <div className="ec-pagebtns">
        <button type="button" className="btn btn-sm btn-secondary" disabled={safePage === 0}
          onClick={() => setPage(p => Math.max(0, p - 1))} title="Previous page">
          <ChevronLeft size={14} /> Prev
        </button>
        <span className="ec-pagenum">Page {safePage + 1} of {totalPages}</span>
        <button type="button" className="btn btn-sm btn-secondary" disabled={safePage >= totalPages - 1}
          onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} title="Next page">
          Next <ChevronRight size={14} />
        </button>
      </div>
    </div>
  );

  return (
    <div className="page">
      <div className="cmp-head">
        <h2><CalendarClock size={20} style={{ verticalAlign: '-3px', marginRight: 8 }} />Edition Comparison</h2>
      </div>

      {/* overview: distributor + edition selectors and the month-over-month
          scoreboard, presented as one cohesive panel */}
      <div className="ec-overview">
      <div className="ec-selectors">
        <select className="ec-dist" value={wholesaler} onChange={e => { setWholesaler(e.target.value); setOlder(''); setNewer(''); }}>
          {Object.keys(DISTRIBUTOR_NAMES).map(w => <option key={w} value={w}>{distributorName(w)}</option>)}
        </select>
        <div className="ec-editions">
          <label>Older
            <select value={older} onChange={e => setOlder(e.target.value)}>
              {editions.map(ed => <option key={ed} value={ed}>{ed}</option>)}
            </select>
          </label>
          <ArrowRight size={16} className="ec-arrow" />
          <label>Newer
            <select value={newer} onChange={e => setNewer(e.target.value)}>
              {editions.map(ed => <option key={ed} value={ed}>{ed}</option>)}
            </select>
          </label>
        </div>
      </div>

      {opts?.single_edition && (
        <div className="cmp-empty ec-empty">
          {distributorName(wholesaler)} has only one edition on record ({editions[0]}).
          Nothing to compare yet. Come back after the next month's price file loads.
        </div>
      )}

      {!opts?.single_edition && isLoading && <DataLoading label="Comparing editions…" />}
      {!opts?.single_edition && isError && <ErrorState retry={() => refetch()} />}

      {data && !data.single_edition && (
        <>
          {/* month-over-month scoreboard */}
          <div className="ec-stats">
            <div className="ec-stat">
              <span className="ec-stat-ico ec-ico-neutral"><Package size={15} /></span>
              <span className="ec-stat-body"><span className="ec-stat-n">{(data.total ?? 0).toLocaleString()}</span><span className="ec-stat-l">products compared</span></span>
            </div>
            <div className="ec-stat">
              <span className="ec-stat-ico ec-ico-down"><ArrowDownRight size={15} /></span>
              <span className="ec-stat-body"><span className="ec-stat-n ec-down-c">{sum?.fell ?? 0}</span><span className="ec-stat-l">net cost fell</span></span>
            </div>
            <div className="ec-stat">
              <span className="ec-stat-ico ec-ico-up"><ArrowUpRight size={15} /></span>
              <span className="ec-stat-body"><span className="ec-stat-n ec-up-c">{sum?.rose ?? 0}</span><span className="ec-stat-l">net cost rose</span></span>
            </div>
            <div className="ec-stat">
              <span className="ec-stat-ico ec-ico-neutral"><PlusCircle size={15} /></span>
              <span className="ec-stat-body"><span className="ec-stat-n">{sum?.added ?? 0}</span><span className="ec-stat-l">new items</span></span>
            </div>
            <div className="ec-stat">
              <span className="ec-stat-ico ec-ico-neutral"><MinusCircle size={15} /></span>
              <span className="ec-stat-body"><span className="ec-stat-n">{sum?.removed ?? 0}</span><span className="ec-stat-l">removed</span></span>
            </div>
            <div className="ec-stat">
              <span className="ec-stat-ico ec-ico-neutral"><Repeat size={15} /></span>
              <span className="ec-stat-body"><span className="ec-stat-n">{sum?.rip_changed ?? 0}</span><span className="ec-stat-l">RIP changed</span></span>
            </div>
          </div>

          <div className="ec-context">
            Comparing <strong>{distributorName(wholesaler)}</strong> {data.older} <ArrowRight size={12} style={{ verticalAlign: '-1px' }} /> {data.newer}.
            Every change is in <strong>effective net cost</strong> (after all discounts + RIP), not list price.
          </div>
        </>
      )}
      </div>{/* /ec-overview */}

      {data && !data.single_edition && (
          <FilterSidebar storageKey="edition-compare-filters" sections={sections} onReset={resetFilters}>
            <div className="ec-results">
              <div className="ec-viewbar">
                <div className="ec-viewtoggle" role="group" aria-label="Layout">
                  <button type="button" className={view === 'cards' ? 'on' : ''} onClick={() => setView('cards')}>Card view</button>
                  <button type="button" className={view === 'table' ? 'on' : ''} onClick={() => setView('table')}>Table view</button>
                </div>
              </div>
              <Pager where="top" />

              {view === 'cards' ? (
                <div className="ec-cards">
                  {shown.map(r => (
                    <EditionCard key={r.ident} r={r} older={data.older ?? undefined} newer={data.newer ?? undefined}
                      wholesaler={wholesaler} onOpen={goToProduct}
                      price3mo={r.upc ? sparkMap?.[r.upc] : undefined} />
                  ))}
                  {total === 0 && <div className="cmp-none ec-cards-none">No products match these filters.</div>}
                </div>
              ) : (
              /* grid */
              <div className="table-container">
                <table className="dense-table ec-table">
                  <thead>
                    <tr>
                      <th>Product</th>
                      <th>Net {data.older}</th>
                      <th>Net {data.newer}</th>
                      <th>Change</th>
                      <th>What moved</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map(r => {
                      const netChanged = r.status === 'both' && r.net_delta_case != null && Math.abs(r.net_delta_case) >= 0.005;
                      const onEnter = (e: ReactMouseEvent) => {
                        if (r.status !== 'both') return;
                        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                        const above = rect.bottom + 190 > window.innerHeight;
                        setBd({ r, left: Math.min(rect.left, window.innerWidth - 320),
                          top: above ? rect.top : rect.bottom, above });
                      };
                      return (
                      <tr key={r.ident} className={`${r.status === 'both' && (!r.net_delta_case || Math.abs(r.net_delta_case) < 0.005) ? 'ec-nochange' : ''}`}>
                        <td className="ec-prod">
                          <span className="ec-prodname" onClick={() => goToProduct(r.product_name)}>{r.product_name}</span>
                          <span className="cmp-size">{r.unit_qty} × {r.unit_volume}</span>
                        </td>
                        <td className="ec-num">{r.status === 'added' ? '—' : money(r.net_a_case)}<span className="cmp-sub">{r.status === 'added' ? '' : `${money(r.net_a_btl)}/${perUnitAbbr(r.unit_volume, r.unit_type)}`}</span></td>
                        {/* Changed value highlighted: red font on yellow when net cost moved. */}
                        <td className={`ec-num${netChanged ? ' ec-changed-val' : ''}`}>{r.status === 'removed' ? '—' : money(r.net_b_case)}<span className="cmp-sub">{r.status === 'removed' ? '' : `${money(r.net_b_btl)}/${perUnitAbbr(r.unit_volume, r.unit_type)}`}</span></td>
                        <td className="ec-change-cell" onMouseEnter={onEnter} onMouseLeave={() => setBd(null)}><DeltaPill r={r} /></td>
                        <td className="ec-layers" onMouseEnter={onEnter} onMouseLeave={() => setBd(null)}>
                          {r.layers.map(l => (
                            <span key={l} className={`ec-layer ${l.startsWith('rip') ? 'ec-layer-rip' : ''}`}>{LAYER_LABEL[l] ?? l}</span>
                          ))}
                        </td>
                        <td className="cmp-actions">
                          {r.status !== 'removed' && (
                            <RowActions productName={r.product_name} wholesaler={wholesaler}
                              upc={r.upc ?? undefined} unitVolume={r.unit_volume ?? undefined} unitQty={r.unit_qty ?? undefined} />
                          )}
                        </td>
                      </tr>
                      );
                    })}
                    {total === 0 && (
                      <tr><td colSpan={6} className="cmp-none">No products match these filters.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
              )}

              {total > 0 && <Pager where="bottom" />}
            </div>
          </FilterSidebar>
      )}

      {/* Styled "what changed" breakdown — fixed so the table overflow never
          clips it. Each component line that moved renders red on yellow. */}
      {bd && data && (
        <div className="ec-breakdown" role="tooltip"
          style={{ position: 'fixed', left: bd.left, top: bd.top,
            transform: bd.above ? 'translateY(-100%)' : 'none' }}>
          <div className="ec-bd-head">{data.older} → {data.newer}</div>
          <table className="ec-bd-table"><BreakdownBody r={bd.r} /></table>
        </div>
      )}
    </div>
  );
}
