import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { CalendarClock, ArrowRight, ArrowDownRight, ArrowUpRight, PlusCircle, MinusCircle, AlertTriangle, ChevronLeft, ChevronRight } from 'lucide-react';
import { compare } from '../lib/api';
import type { EditionRow } from '../lib/api';
import { distributorName, DISTRIBUTOR_NAMES, perUnitAbbr } from '../lib/distributors';
import ProductSearchBox from '../components/ProductSearchBox';
import FilterSidebar, { type FilterSection } from '../components/FilterSidebar';
import RowActions from '../components/RowActions';
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
];

const PAGE_SIZES = [50, 100, 200, 500];

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

export default function EditionCompare() {
  const [params, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const [wholesaler, setWholesaler] = useState(params.get('w') ?? 'fedway');
  const [older, setOlder] = useState(params.get('a') ?? '');
  const [newer, setNewer] = useState(params.get('b') ?? '');
  const [q, setQ] = useState(params.get('q') ?? '');
  const [change, setChange] = useState(params.get('change') ?? '');
  const [sort, setSort] = useState(params.get('sort') ?? 'net_delta');
  // Client-side facets (the result set is fully returned, so these filter the
  // grid without another round-trip — same rail + behaviour as every list page).
  const [productType, setProductType] = useState('');
  const [sizes, setSizes] = useState<string[]>([]);
  const [layersSel, setLayersSel] = useState<string[]>([]);
  const [minPrice, setMinPrice] = useState('');
  const [maxPrice, setMaxPrice] = useState('');
  const [onlyChanged, setOnlyChanged] = useState(false);
  const [page, setPage] = useState(0);
  const [limit, setLimit] = useState(100);

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
    if (sort !== 'net_delta') next.set('sort', sort);
    if (next.toString() !== params.toString()) setSearchParams(next, { replace: true });
  }, [wholesaler, older, newer, q, change, sort]);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['edition-compare', wholesaler, older, newer, q, change, sort],
    queryFn: () => compare.editions({
      wholesaler, older: older || undefined, newer: newer || undefined,
      match: q || undefined, change: change || undefined, sort,
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
    return rs;
  }, [rows, productType, sizes, layersSel, minPrice, maxPrice, onlyChanged]);

  // Reset to the first page whenever the filtered set or page size changes.
  useEffect(() => { setPage(0); },
    [wholesaler, older, newer, q, change, sort, productType, sizes, layersSel, minPrice, maxPrice, onlyChanged, limit]);

  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const safePage = Math.min(page, totalPages - 1);
  const shown = filtered.slice(safePage * limit, (safePage + 1) * limit);
  const rangeFrom = total ? safePage * limit + 1 : 0;
  const rangeTo = Math.min((safePage + 1) * limit, total);

  const resetFilters = () => {
    setQ(''); setChange(''); setProductType(''); setSizes([]); setLayersSel([]);
    setMinPrice(''); setMaxPrice(''); setOnlyChanged(false); setSort('net_delta');
  };

  const sections: FilterSection[] = [
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
    { type: 'range', key: 'price', title: 'Net price / case', min: minPrice, max: maxPrice,
      onMinChange: setMinPrice, onMaxChange: setMaxPrice, minPlaceholder: 'Min $', maxPlaceholder: 'Max $' },
    { type: 'select', key: 'sort', title: 'Sort by', value: sort, onChange: setSort, options: [
      { value: 'net_delta', label: 'Biggest $ change' },
      { value: 'net_delta_pct', label: 'Biggest % change' },
      { value: 'product', label: 'Product name' },
    ] },
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

      {/* selectors */}
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
        <div className="cmp-empty">
          {distributorName(wholesaler)} has only one edition on record ({editions[0]}) —
          nothing to compare yet. Come back after the next month's price file loads.
        </div>
      )}

      {!opts?.single_edition && isLoading && <DataLoading label="Comparing editions…" />}
      {!opts?.single_edition && isError && <ErrorState retry={() => refetch()} />}

      {data && !data.single_edition && (
        <>
          {/* summary */}
          <div className="cmp-cards">
            <div className="cmp-card"><div className="cmp-card-n">{(data.total ?? 0).toLocaleString()}</div><div className="cmp-card-l">products compared</div></div>
            <div className="cmp-card"><div className="cmp-card-n ec-down-c">{sum?.fell ?? 0}</div><div className="cmp-card-l">net cost fell</div></div>
            <div className="cmp-card"><div className="cmp-card-n ec-up-c">{sum?.rose ?? 0}</div><div className="cmp-card-l">net cost rose</div></div>
            <div className="cmp-card"><div className="cmp-card-n">{sum?.added ?? 0}</div><div className="cmp-card-l">new items</div></div>
            <div className="cmp-card"><div className="cmp-card-n">{sum?.removed ?? 0}</div><div className="cmp-card-l">removed</div></div>
            <div className="cmp-card"><div className="cmp-card-n">{sum?.rip_changed ?? 0}</div><div className="cmp-card-l">RIP changed</div></div>
          </div>

          <div className="ec-context">
            Comparing <strong>{distributorName(wholesaler)}</strong> {data.older} <ArrowRight size={12} style={{ verticalAlign: '-1px' }} /> {data.newer}.
            Every change is in <strong>effective net cost</strong> (after all discounts + RIP), not list price.
          </div>

          <FilterSidebar storageKey="edition-compare-filters" sections={sections} onReset={resetFilters}>
            <div className="ec-results">
              <Pager where="top" />

              {/* grid */}
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
                      // full price breakdown for the "what changed" tooltip
                      const tip = r.status !== 'both' ? '' : [
                        `${data.older} → ${data.newer}`,
                        `Net cost:  ${money(r.net_a_case)} → ${money(r.net_b_case)}` +
                          (r.net_delta_case != null ? `  (${r.net_delta_case > 0 ? '+' : ''}$${r.net_delta_case.toFixed(2)}, ${pct(r.net_delta_pct)})` : ''),
                        `Frontline: ${money(r.frontline_a)} → ${money(r.frontline_b)}`,
                        `Invoice (after discount): ${money(r.invoice_a)} → ${money(r.invoice_b)}`,
                        `RIP rebate: ${money(r.rip_a)} → ${money(r.rip_b)}`,
                      ].join('\n');
                      return (
                      <tr key={r.ident} className={`${r.status === 'both' && (!r.net_delta_case || Math.abs(r.net_delta_case) < 0.005) ? 'ec-nochange' : ''}`}>
                        <td className="ec-prod">
                          <span className="ec-prodname" onClick={() => goToProduct(r.product_name)}>{r.product_name}</span>
                          <span className="cmp-size">{r.unit_qty} × {r.unit_volume}</span>
                        </td>
                        <td className="ec-num">{r.status === 'added' ? '—' : money(r.net_a_case)}<span className="cmp-sub">{r.status === 'added' ? '' : `${money(r.net_a_btl)}/${perUnitAbbr(r.unit_volume, r.unit_type)}`}</span></td>
                        <td className="ec-num">{r.status === 'removed' ? '—' : money(r.net_b_case)}<span className="cmp-sub">{r.status === 'removed' ? '' : `${money(r.net_b_btl)}/${perUnitAbbr(r.unit_volume, r.unit_type)}`}</span></td>
                        <td title={tip}><DeltaPill r={r} /></td>
                        <td className="ec-layers" title={tip}>
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

              {total > 0 && <Pager where="bottom" />}
            </div>
          </FilterSidebar>
        </>
      )}
    </div>
  );
}
