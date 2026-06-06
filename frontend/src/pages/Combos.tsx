import { useState, useMemo, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { deals, cart, type Combo } from '../lib/api';
import SortableTable from '../components/SortableTable';
import RowLimitSelect from '../components/RowLimitSelect';
import FilterSidebar, { type FilterSection } from '../components/FilterSidebar';
import { distributorName, ALL_DISTRIBUTORS, abgSku, skuLabel } from '../lib/distributors';
import { X, ShoppingCart, Check } from 'lucide-react';
import { QtyStepper } from '../components/CatalogTable';
import AddToListButton from '../components/AddToListButton';

const $ = (v: number | null | undefined, d = 2) =>
  v == null ? '—' : `$${Number(v).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })}`;

const fmtDate = (d?: string | null): string | null => {
  if (!d) return null;
  const [y, m, day] = d.split(/[ T]/)[0].split('-').map(Number);
  if (!y || !m || !day) return d;
  return new Date(y, m - 1, day).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};

// Regular value implied by the combo price + stated savings, and the % off.
function breakdown(c: Combo) {
  const combo = Number(c.combo_pack_price) || 0;
  const savings = Number(c.total_savings) || 0;
  const regularValue = combo + savings;
  const pctOff = regularValue > 0 ? (savings / regularValue) * 100 : 0;
  // Real bundle discounts rarely exceed ~85%; beyond that (or a negative/zero
  // savings) the distributor's source figures are almost certainly off.
  const reliable = savings > 0 && combo > 0 && pctOff < 85;
  return { combo, savings, regularValue, pctOff, reliable };
}

// Worth-it verdict from the server-computed economics (combo vs one-case price).
const VERDICT_LABEL: Record<string, string> = {
  worth_it: '✅ Worth it', marginal: '≈ Marginal',
  buy_separately: '⚠️ Buy separately', unknown: 'ℹ️ Unverified',
};

// The economics block: ADVERTISED savings (distributor's claim) vs EFFECTIVE
// savings (vs the realistic one-case price), the three summed baselines, and a
// per-component combo / list / one-case table. Same numbers as the AI assistant.
function EconomicsBlock({ c }: { c: Combo }) {
  const e = c.economics;
  if (!e) return null;
  const adv = e.advertised_savings;
  const eff = e.save_vs_separate;
  const optimistic = adv != null && eff != null ? adv - eff : null;
  return (
    <div className="combo-detail-summary" style={{ marginTop: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 6 }}>
        <span className={`combo-pct-badge${e.verdict === 'buy_separately' ? ' combo-pct-badge-warn' : ''}`}>
          {VERDICT_LABEL[e.verdict ?? 'unknown']}
        </span>
        <span style={{ fontSize: 13 }}>
          <strong>Advertised save {$(adv)}</strong>
          {eff != null && <> → <span className="text-green font-bold">effective {$(eff)}</span> vs one-case</>}
          {optimistic != null && optimistic > 1 &&
            <span className="text-muted"> · advertised is {$(optimistic)} optimistic</span>}
        </span>
      </div>
      {e.verdict === 'unknown' ? (
        <p className="text-muted" style={{ fontSize: 12.5, margin: 0 }}>
          Can't verify the effective saving — {e.unverified_reason ?? 'couldn’t price every component cleanly'}
          {e.components_total ? ` (${e.components_priced ?? 0}/${e.components_total} priced)` : ''}. The advertised
          number above is the distributor's.
        </p>
      ) : (
        <table className="combo-detail-pricing" style={{ marginTop: 4 }}>
          <tbody>
            <tr><td>Combo bundle price</td><td className="right">{$(e.combo_cost)}</td></tr>
            <tr><td>Individual (list) price</td><td className="right">{$(e.frontline_total)}</td></tr>
            <tr><td>One-case price (list − 1-case discount)</td><td className="right">{$(e.separate_best_total)}</td></tr>
            <tr className="combo-detail-total">
              <td>Effective saving vs one-case</td>
              <td className="right text-green">{$(eff)}{e.pct_vs_separate != null ? ` (${e.pct_vs_separate.toFixed(0)}%)` : ''}</td>
            </tr>
          </tbody>
        </table>
      )}
      <p className="text-muted" style={{ fontSize: 11.5, margin: '6px 0 0' }}>
        Effective uses the <strong>one-case</strong> price (what you'd really pay buying a case or two), not the
        bulk-RIP max that needs 20–30 cases.
      </p>
    </div>
  );
}

function recVariant(rec?: string): 'now' | 'wait' | 'urgent' | 'neutral' {
  if (!rec) return 'neutral';
  if (rec.includes('ends') || rec.includes('rises')) return 'urgent';
  if (rec.includes('Better deal now')) return 'now';
  if (rec.includes('next month') || rec.includes('drops')) return 'wait';
  return 'neutral';
}

function SavingsCell({ c }: { c: Combo }) {
  const b = breakdown(c);
  return <span className="text-green font-bold">{$(b.savings)}</span>;
}

/** Inline bundle contents: one line per component, expandable straight in the
 *  row (no modal detour). Each line: product link, qty per pack, regular vs
 *  combo price each, save each. */
function ComboItemsExpander({ c }: { c: Combo }) {
  const [open, setOpen] = useState(false);
  const comps = c.components ?? [];
  if (comps.length === 0) return null;
  return (
    <div className="combo-items-expander" onClick={e => e.stopPropagation()}>
      <button type="button" className="combo-items-toggle"
              onClick={() => setOpen(o => !o)}>
        {open ? '▾ Hide' : '▸ Show'} {comps.length} item{comps.length === 1 ? '' : 's'}
      </button>
      {open && (
        <div className="combo-items-lines">
          {comps.map((m, i) => {
            const save = m.frontline_price_each != null && m.combo_price_each != null
              ? m.frontline_price_each - m.combo_price_each : null;
            const url = m.product_name
              ? `/product?w=${encodeURIComponent(c.wholesaler)}&n=${encodeURIComponent(m.product_name)}${m.upc ? `&u=${encodeURIComponent(m.upc)}` : ''}`
              : null;
            return (
              <div key={`${m.upc ?? m.product_name}-${i}`} className="combo-item-line">
                {url
                  ? <a href={url} className="combo-item-name">{m.product_name}</a>
                  : <span className="combo-item-name">{m.product_name ?? 'Unknown item'}</span>}
                {m.qty_per_pack && <span className="text-muted"> · {m.qty_per_pack}/pack</span>}
                {m.frontline_price_each != null && (
                  <span className="text-muted"> · reg {$(m.frontline_price_each)}</span>
                )}
                {m.combo_price_each != null && (
                  <span> → <strong>{$(m.combo_price_each)}</strong> in combo</span>
                )}
                {save != null && save > 0.005 && (
                  <span className="text-green"> (save {$(save)} each)</span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ComboCartAdder({ combo }: { combo: Combo }) {
  const qc = useQueryClient();
  const [flash, setFlash] = useState<string | null>(null);
  const addMut = useMutation({
    mutationFn: () => cart.fromCombo(combo.wholesaler, combo.combo_code),
    onSuccess: (res) => {
      setFlash(`Added ${res.added} item${res.added === 1 ? '' : 's'} to your cart`);
      qc.invalidateQueries({ queryKey: ['cart'] });
      setTimeout(() => setFlash(null), 3500);
    },
  });
  if (flash) return <span className="add-order-flash">{flash}</span>;
  return (
    <button className="btn" disabled={addMut.isPending} onClick={() => addMut.mutate()}>
      <ShoppingCart size={15} /> {addMut.isPending ? 'Adding...' : 'Add bundle to Cart'}
    </button>
  );
}

// Per-row order controls in the combos table: choose how many bundles, then add
// the whole bundle to the cart, or add it to a list instead.
function ComboCartCell({ combo }: { combo: Combo }) {
  const qc = useQueryClient();
  const [qty, setQty] = useState(1);
  const [flash, setFlash] = useState(false);
  const add = useMutation({
    mutationFn: () => cart.fromCombo(combo.wholesaler, combo.combo_code, qty),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['cart'] });
      setFlash(true);
      setTimeout(() => setFlash(false), 1300);
    },
  });
  const label = combo.comments
    ? combo.comments.replace(/^\s*contains:\s*/i, '')
    : (combo.product_name ?? `Combo ${combo.combo_code}`);
  return (
    <div className="catalog-order-inline" onClick={e => e.stopPropagation()}
      style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <QtyStepper label="Qty" value={qty} onChange={v => setQty(Math.max(1, v))} />
      <button type="button" className={`btn btn-sm add-to-cart-btn${flash ? ' is-added' : ''}`}
        disabled={add.isPending} onClick={() => add.mutate()}>
        {flash ? <><Check size={13} /> Added</> : <><ShoppingCart size={13} /> Add to cart</>}
      </button>
      <AddToListButton productName={label} wholesaler={combo.wholesaler} comboCode={combo.combo_code} />
    </div>
  );
}

function ComboDetailModal({ c, onClose }: { c: Combo; onClose: () => void }) {
  const b = breakdown(c);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const contents = c.comments ? c.comments.replace(/^\s*contains:\s*/i, '') : null;
  const items = c.item_count ?? c.components?.length ?? 0;
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal combo-detail-modal" onClick={e => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="Close"><X size={18} /></button>

        <h3 style={{ margin: 0 }}>📦 Bundle breakdown</h3>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: '4px 0 0' }}>
          {distributorName(c.wholesaler)} · Combo #{c.combo_code} · {items} {items === 1 ? 'product' : 'products'}
        </p>
        {contents && <p className="combo-detail-contents">{contents}</p>}

        {/* Worth-it economics (advertised vs effective, vs one-case price). */}
        <EconomicsBlock c={c} />

        {b.reliable ? (
          <>
            {/* Plain-language summary */}
            <div className="combo-detail-summary">
              <p>
                Buy these {items} {items === 1 ? 'product' : 'products'} on their own and you'd pay about{' '}
                <strong>{$(b.regularValue)}</strong>.
              </p>
              <p>
                As one bundle you pay <strong>{$(b.combo)}</strong> —{' '}
                <span className="text-green font-bold">you save {$(b.savings)} ({b.pctOff.toFixed(0)}% off)</span>.
              </p>
            </div>

            {/* Visual savings bar */}
            <div className="combo-detail-bar" title={`${b.pctOff.toFixed(0)}% off`}>
              <div className="combo-detail-bar-fill" style={{ width: `${Math.min(100, Math.max(0, b.pctOff))}%` }} />
              <span className="combo-detail-bar-label">{b.pctOff.toFixed(0)}% off</span>
            </div>
          </>
        ) : (
          <div className="combo-detail-warning">
            ⚠ <strong>Heads up — these figures look inconsistent.</strong> The distributor's data implies a{' '}
            {b.pctOff.toFixed(0)}% discount ({$(b.combo)} vs a listed {$(b.regularValue)}), which is unusually high.
            The per-item prices below are shown as-is from the source — please verify before ordering.
          </div>
        )}

        {/* Items */}
        {c.components && c.components.length > 0 && (
          <>
            <h4>What's in the bundle</h4>
            <div style={{ overflowX: 'auto' }}>
              <table className="combo-detail-table">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th>Qty in pack</th>
                    <th className="right">Regular each</th>
                    <th className="right">Combo each</th>
                    <th className="right">You save each</th>
                  </tr>
                </thead>
                <tbody>
                  {c.components.map((comp, i) => {
                    const reg = comp.frontline_price_each;
                    const cmb = comp.combo_price_each;
                    const save = reg != null && cmb != null ? reg - cmb : null;
                    const pct = save != null && reg ? (save / reg) * 100 : null;
                    // The vintage we priced (a UPC can span years — we use the
                    // latest), matched from the server economics by UPC.
                    const vintage = c.economics?.components?.find(
                      e => e.upc && comp.upc && e.upc === String(comp.upc).replace(/^0+/, ''))?.vintage;
                    return (
                      <tr key={i}>
                        <td>
                          <div style={{ fontWeight: 600 }}>
                            {comp.product_name}{vintage ? <span className="text-muted"> · '{String(vintage).slice(-2)}</span> : ''}
                          </div>
                          {comp.upc && <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{comp.upc}{abgSku(c.wholesaler, comp.abg_sku) ? ` · ${skuLabel(c.wholesaler)} ${comp.abg_sku}` : ''}</div>}
                        </td>
                        <td>{comp.qty_per_pack ?? '—'}</td>
                        <td className="right">{$(reg)}</td>
                        <td className="right text-green">{$(cmb)}</td>
                        <td className="right">
                          {save != null
                            ? <span className="text-green font-bold">{$(save)}{pct != null ? ` (${pct.toFixed(0)}%)` : ''}</span>
                            : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}

        {/* Bottom line */}
        <h4>The bottom line</h4>
        <table className="combo-detail-pricing">
          <tbody>
            <tr><td>Regular value (buying separately)</td><td className="right">{$(b.regularValue)}</td></tr>
            <tr><td>Combo bundle price (what you pay)</td><td className="right">− {$(b.combo)}</td></tr>
            <tr className="combo-detail-total">
              <td>You save</td>
              <td className="right text-green">{$(b.savings)} ({b.pctOff.toFixed(0)}% off)</td>
            </tr>
          </tbody>
        </table>

        {c.valid_through && (
          <div className="combo-detail-dates">
            <strong>Deal dates:</strong>{' '}
            {c.valid_from ? `${fmtDate(c.valid_from)} through ` : 'through '}
            <strong>{fmtDate(c.valid_through)}</strong>.
          </div>
        )}

        {c.recommendation && (
          <div className="combo-detail-outlook" data-rec={recVariant(c.recommendation)}>
            <strong>Next month:</strong> {c.recommendation}.
            {c.availability === 'continues' && c.next_total_savings != null
              ? ` Next-month savings ${$(c.next_total_savings)} vs ${$(b.savings)} now`
              + (c.next_combo_pack_price != null ? ` (pack ${$(c.next_combo_pack_price)} vs ${$(b.combo)}).` : '.')
              : c.availability === 'ending' ? ' This bundle is not offered next month.'
              : c.availability === 'new' ? ' This bundle starts next month.' : ''}
          </div>
        )}

        <p className="combo-detail-note">
          <strong>How it's figured:</strong> Savings = Regular value − Combo price. "Each" prices are per the
          distributor's listed unit (bottle or case, as shown under <em>Qty in pack</em>). The bundle price is fixed —
          you buy the whole pack together.
        </p>

        <div className="combo-detail-actions">
          <ComboCartAdder combo={c} />
        </div>
      </div>
    </div>
  );
}

export default function Combos() {
  const [searchParams] = useSearchParams();
  const [wholesaler, setWholesaler] = useState('');
  const [q, setQ] = useState(searchParams.get('code') ?? '');
  const [minSavings, setMinSavings] = useState('');
  const [validity, setValidity] = useState('');
  const [limit, setLimit] = useState(100);
  const [detailCombo, setDetailCombo] = useState<Combo | null>(null);

  const { data } = useQuery({
    queryKey: ['combos', wholesaler, q],
    // Fetch all combos; the row-limit below pages them client-side.
    queryFn: () => deals.combos({ wholesaler: wholesaler || undefined, q: q || undefined, limit: 100000 }),
  });

  const items = useMemo(() => {
    let result = data ?? [];
    if (minSavings) {
      const min = parseFloat(minSavings);
      result = result.filter(i => i.total_savings >= min);
    }
    if (validity === 'this') result = result.filter(i => i.availability === 'continues' || i.availability === 'ending');
    else if (validity === 'next') result = result.filter(i => i.availability === 'continues' || i.availability === 'new');
    else if (validity === 'both') result = result.filter(i => i.availability === 'continues');
    return result;
  }, [data, minSavings, validity]);

  const stats = useMemo(() => {
    if (!items.length) return null;
    const savings = items.map(i => Number(i.total_savings) || 0);
    const avg = savings.reduce((s, v) => s + v, 0) / savings.length;
    const max = Math.max(...savings);
    const avgPct = items.reduce((s, i) => s + breakdown(i).pctOff, 0) / items.length;
    return { avg, max, avgPct, count: items.length };
  }, [items]);

  const sections: FilterSection[] = [
    { type: 'text', key: 'q', title: 'Search', placeholder: 'Combo description', value: q, onChange: setQ },
    { type: 'pills', key: 'wholesaler', title: 'Distributor', options: ALL_DISTRIBUTORS, value: wholesaler, onChange: setWholesaler },
    {
      type: 'pills', key: 'min_savings', title: 'Min Savings',
      options: [
        { value: '', label: 'Any' }, { value: '5', label: '$5+' }, { value: '10', label: '$10+' },
        { value: '25', label: '$25+' }, { value: '50', label: '$50+' }, { value: '100', label: '$100+' },
      ],
      value: minSavings, onChange: setMinSavings,
    },
    {
      type: 'pills', key: 'validity', title: 'Validity',
      options: [
        { value: '', label: 'Any' },
        { value: 'this', label: 'Valid this month' },
        { value: 'next', label: 'Valid next month' },
        { value: 'both', label: 'Valid both months' },
      ],
      value: validity, onChange: setValidity,
    },
  ];

  const resetFilters = () => { setQ(''); setWholesaler(''); setMinSavings(''); setValidity(''); };

  return (
    <FilterSidebar storageKey="combos" sections={sections} onReset={resetFilters}>
      <div className="page">
        <div className="orders-header"><h2>Bundle / Combo Deals</h2></div>
        <p className="text-muted" style={{ marginTop: 0, marginBottom: 12 }}>
          Multi-product bundles sold as a pack. Click any row to see the full bundle breakdown and how the savings are calculated.
        </p>

        <div className="rip-filter-bar">
          <RowLimitSelect value={limit} onChange={setLimit} />
          <span className="search-count">{items.length} combos</span>
        </div>

        {stats && (
          <div className="rip-summary-cards">
            <div className="rip-summary-card">
              <div className="rip-summary-value">{stats.count.toLocaleString()}</div>
              <div className="rip-summary-label">Combos</div>
            </div>
            <div className="rip-summary-card">
              <div className="rip-summary-value text-green">{$(stats.avg)}</div>
              <div className="rip-summary-label">Avg Savings</div>
            </div>
            <div className="rip-summary-card">
              <div className="rip-summary-value text-green">{$(stats.max)}</div>
              <div className="rip-summary-label">Max Savings</div>
            </div>
            <div className="rip-summary-card">
              <div className="rip-summary-value">{stats.avgPct.toFixed(0)}%</div>
              <div className="rip-summary-label">Avg Discount</div>
            </div>
          </div>
        )}

        <SortableTable
          columns={[
            { key: 'product_name', label: 'Combo', sortable: true,
              exportValue: r => r.comments ?? r.product_name,
              render: r => {
                const contents = r.comments ? r.comments.replace(/^\s*contains:\s*/i, '') : null;
                return (
                  <div className="combo-product-cell">
                    <div className="combo-product-name" title={r.comments ?? r.product_name}>
                      📦 {contents ?? r.product_name}
                    </div>
                    <div className="combo-contains combo-contains-muted">
                      Combo #{r.combo_code}{r.item_count ? ` · ${r.item_count} item${r.item_count !== 1 ? 's' : ''}` : ''}
                    </div>
                    <ComboItemsExpander c={r} />
                    <ComboCartCell combo={r} />
                  </div>
                );
              } },
            { key: 'wholesaler', label: 'Distributor', sortable: true,
              exportValue: r => distributorName(r.wholesaler),
              render: r => <span className="cell-distributor-badge">{distributorName(r.wholesaler)}</span> },
            { key: 'item_count', label: 'Items', align: 'right', sortable: true,
              render: r => r.item_count ?? (r.components?.length ?? '—') },
            { key: 'combo_pack_price', label: 'Combo Price', align: 'right', sortable: true,
              render: r => $(r.combo_pack_price) },
            { key: '_regular_value', label: 'Regular Value', align: 'right', sortable: true,
              exportValue: r => breakdown(r).regularValue.toFixed(2),
              render: r => <span className="text-muted">{$(breakdown(r).regularValue)}</span> },
            { key: '_pct_off', label: '% Off', align: 'right', sortable: true,
              exportValue: r => breakdown(r).pctOff.toFixed(1),
              render: r => {
                const bd = breakdown(r);
                return (
                  <span className={`combo-pct-badge ${bd.reliable ? '' : 'combo-pct-badge-warn'}`}
                    title={bd.reliable ? undefined : 'Source figures look inconsistent — verify'}>
                    {bd.pctOff.toFixed(0)}%{bd.reliable ? '' : ' ⚠'}
                  </span>
                );
              } },
            { key: 'total_savings', label: 'Advertised Save', align: 'right', sortable: true,
              exportValue: r => r.total_savings,
              render: r => <SavingsCell c={r} /> },
            { key: '_eff_save', label: 'Effective Save', align: 'right', sortable: true,
              exportValue: r => r.economics?.save_vs_separate ?? '',
              render: r => {
                const e = r.economics;
                if (!e || e.verdict === 'unknown' || e.save_vs_separate == null)
                  return <span className="text-muted" title="Couldn't price every component cleanly">—</span>;
                return (
                  <span className="text-green font-bold"
                    title={`vs the one-case price${e.pct_vs_separate != null ? ` · ${e.pct_vs_separate.toFixed(0)}%` : ''}`}>
                    {$(e.save_vs_separate)}
                  </span>
                );
              } },
            { key: '_verdict', label: 'Verdict', sortable: true,
              exportValue: r => r.economics?.verdict ?? '',
              render: r => {
                const v = r.economics?.verdict ?? 'unknown';
                return <span className={`combo-pct-badge${v === 'buy_separately' ? ' combo-pct-badge-warn' : ''}`}>
                  {VERDICT_LABEL[v]}</span>;
              } },
            { key: 'next_total_savings', label: 'Next Mo. Save', align: 'right', sortable: true,
              exportValue: r => r.availability === 'ending' ? 'ends' : (r.next_total_savings ?? ''),
              render: r => r.availability === 'ending'
                ? <span className="text-muted">Ends</span>
                : <span className="text-green">{$(r.next_total_savings)}</span> },
            { key: 'valid_through', label: 'Valid Through', sortable: true,
              exportValue: r => (validity === 'next' ? (r.next_valid_through ?? r.valid_through) : r.valid_through) ?? '',
              render: r => {
                // Under the "next month" filter, show the next-month validity so
                // continuing combos read their June dates, not May.
                const vt = validity === 'next' ? (r.next_valid_through ?? r.valid_through) : r.valid_through;
                const vf = validity === 'next' ? (r.next_valid_from ?? r.valid_from) : r.valid_from;
                return vt
                  ? <span style={{ fontSize: 12.5 }} title={vf ? `${fmtDate(vf)} to ${fmtDate(vt)}` : undefined}>{fmtDate(vt)}</span>
                  : <span className="text-muted">—</span>;
              } },
            { key: 'recommendation', label: 'Outlook', sortable: true,
              render: r => <span className="combo-rec" data-rec={recVariant(r.recommendation)}>{r.recommendation ?? '—'}</span> },
          ]}
          data={items.map(i => ({
            ...i, _pct_off: breakdown(i).pctOff, _regular_value: breakdown(i).regularValue,
            _eff_save: i.economics?.save_vs_separate ?? -Infinity, _verdict: i.economics?.verdict ?? 'unknown',
          }))}
          pageSize={limit}
          exportName="combos"
          onRowClick={r => setDetailCombo(r)}
          cardView
        />
        {detailCombo && <ComboDetailModal c={detailCombo} onClose={() => setDetailCombo(null)} />}
      </div>
    </FilterSidebar>
  );
}
