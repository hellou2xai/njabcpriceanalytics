import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { CalendarClock, ArrowRight, ArrowDownRight, ArrowUpRight, PlusCircle, MinusCircle, AlertTriangle } from 'lucide-react';
import { compare } from '../lib/api';
import type { EditionRow } from '../lib/api';
import { distributorName, DISTRIBUTOR_NAMES } from '../lib/distributors';
import ProductSearchBox from '../components/ProductSearchBox';
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
  const [shown, setShown] = useState(100);

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

  const { data, isLoading } = useQuery({
    queryKey: ['edition-compare', wholesaler, older, newer, q, change, sort],
    queryFn: () => compare.editions({
      wholesaler, older: older || undefined, newer: newer || undefined,
      match: q || undefined, change: change || undefined, sort,
    }),
    enabled: !!wholesaler && !!opts && !opts.single_edition,
  });

  const editions = opts?.editions ?? [];
  const rows = data?.rows ?? [];
  const sum = data?.summary;

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

      {!opts?.single_edition && isLoading && <p>Comparing editions…</p>}

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

          {/* filters */}
          <div className="cmp-filters">
            <ProductSearchBox value={q} placeholder="Search product or brand…"
              onChange={v => { setQ(v); setShown(100); }}
              onSelect={p => { setQ(p.product_name); setShown(100); }} />
            <select value={change} onChange={e => { setChange(e.target.value); setShown(100); }}>
              {CHANGES.map(c => <option key={c.v} value={c.v}>{c.label}</option>)}
            </select>
            <select value={sort} onChange={e => setSort(e.target.value)}>
              <option value="net_delta">Biggest $ change</option>
              <option value="net_delta_pct">Biggest % change</option>
              <option value="product">Product name</option>
            </select>
            <span className="cmp-count">{rows.length.toLocaleString()} rows</span>
          </div>

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
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, shown).map(r => (
                  <tr key={r.ident} className={`${r.status === 'both' && (!r.net_delta_case || Math.abs(r.net_delta_case) < 0.005) ? 'ec-nochange' : ''}`}>
                    <td className="ec-prod">
                      <span className="ec-prodname" onClick={() => goToProduct(r.product_name)}>{r.product_name}</span>
                      <span className="cmp-size">{r.unit_qty} × {r.unit_volume}</span>
                    </td>
                    <td className="ec-num">{r.status === 'added' ? '—' : money(r.net_a_case)}<span className="cmp-sub">{r.status === 'added' ? '' : `${money(r.net_a_btl)}/btl`}</span></td>
                    <td className="ec-num">{r.status === 'removed' ? '—' : money(r.net_b_case)}<span className="cmp-sub">{r.status === 'removed' ? '' : `${money(r.net_b_btl)}/btl`}</span></td>
                    <td><DeltaPill r={r} /></td>
                    <td className="ec-layers">
                      {r.layers.map(l => (
                        <span key={l} className={`ec-layer ${l.startsWith('rip') ? 'ec-layer-rip' : ''}`}>{LAYER_LABEL[l] ?? l}</span>
                      ))}
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr><td colSpan={5} className="cmp-none">No products match this change filter.</td></tr>
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
