import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { deals, catalog } from '../lib/api';
import FavoriteButton from '../components/FavoriteButton';
import ProductThumb from '../components/ProductThumb';
import { RowMenuButton } from '../components/ContextMenu';
import RowLimitSelect from '../components/RowLimitSelect';
import FilterSidebar, { type FilterSection } from '../components/FilterSidebar';
import { useProductQuickView } from '../components/ProductQuickView';
import DataLoading from '../components/DataLoading';
import AddToCartButton from '../components/AddToCartButton';
import AddToListButton from '../components/AddToListButton';
import { QtyStepper, loadCart, saveCart, type CartState } from '../components/CatalogTable';
import { distributorName, ALL_DISTRIBUTORS } from '../lib/distributors';

function tierLabel(unit?: string | null): string {
  if (!unit) return '';
  const u = unit.toLowerCase();
  if (u === 'c' || u.startsWith('case')) return 'cs';
  if (u === 'b' || u.startsWith('btl') || u.startsWith('bottle')) return 'btl';
  return unit;
}

function fmtPrice(v: number | null | undefined): string {
  return v == null ? '-' : `$${v.toFixed(2)}`;
}

function fmtSave(v: number | null | undefined): string {
  return v == null ? '-' : `$${v.toFixed(2)}`;
}

function fmtPct(v: number | null | undefined): string {
  return v == null ? '-' : `${v.toFixed(1)}%`;
}

function gpClass(v: number | null | undefined): string {
  if (v == null) return 'text-muted';
  if (v >= 15) return 'text-green';
  if (v >= 8) return 'text-yellow';
  return '';
}

function shortMonth(edition: string | null | undefined): string {
  if (!edition) return '';
  const [, mm] = edition.split('-');
  const names = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const idx = parseInt(mm, 10) - 1;
  return idx >= 0 && idx < 12 ? names[idx] : edition;
}

function betterMonth(curr?: number | null, next?: number | null): { label: string; variant: 'this' | 'next' | 'same' } | null {
  const c = curr ?? 0, n = next ?? 0;
  if (c <= 0 && n <= 0) return null;
  if (c > 0 && n <= 0) return { label: 'Ends', variant: 'this' };
  if (c <= 0 && n > 0) return { label: 'New Next', variant: 'next' };
  if (Math.abs(c - n) < 0.005) return { label: 'Same', variant: 'same' };
  return c > n ? { label: 'This Month', variant: 'this' } : { label: 'Next Month', variant: 'next' };
}

export default function RipProducts() {
  const [q, setQ] = useState('');
  const [ripCode, setRipCode] = useState('');
  const [wholesaler, setWholesaler] = useState('');
  const [productType, setProductType] = useState('');
  const [source, setSource] = useState('');
  const [minSave, setMinSave] = useState('');
  const [minGp, setMinGp] = useState('');
  const [tierUnit, setTierUnit] = useState('');
  const [newNext, setNewNext] = useState(false);
  const [sort, setSort] = useState('rip_save_per_case');
  const [order, setOrder] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(0);
  const [limit, setLimit] = useState(50);
  const { open } = useProductQuickView();

  // Shared draft-cart quantities (same localStorage cart as the Catalog).
  const [cart, setCart] = useState<CartState>(loadCart);
  const updateQty = (key: string, field: 'cases' | 'units', value: number) => {
    setCart(prev => {
      const cur = prev[key] ?? { cases: 0, units: 0 };
      const next = { ...prev, [key]: { ...cur, [field]: value } };
      saveCart(next);
      return next;
    });
  };

  const { data, isLoading } = useQuery({
    queryKey: ['rip-products', q, ripCode, wholesaler, productType, source, minSave, minGp, tierUnit, newNext, sort, order, page, limit],
    queryFn: () => deals.ripProducts({
      q: q || undefined,
      rip_code: ripCode || undefined,
      wholesaler: wholesaler || undefined,
      product_type: productType || undefined,
      source: source || undefined,
      min_savings: minSave ? parseFloat(minSave) : undefined,
      min_gp: minGp ? parseFloat(minGp) : undefined,
      tier_unit: tierUnit || undefined,
      new_next: newNext || undefined,
      sort, order, limit,
      offset: page * limit,
    }),
  });

  const { data: categories } = useQuery({
    queryKey: ['categories', wholesaler],
    queryFn: () => catalog.categories({ wholesaler: wholesaler || undefined }),
  });

  const items = data?.items ?? [];

  const stats = useMemo(() => {
    if (items.length === 0) return null;
    const saves = items.map(i => Math.max(i.curr_save_per_case ?? 0, i.next_save_per_case ?? 0));
    const avgSave = saves.reduce((s, v) => s + v, 0) / saves.length;
    const maxSave = saves.length ? Math.max(...saves) : 0;
    const onlyNext = items.filter(i => (i.next_save_per_case ?? 0) > 0 && (i.curr_save_per_case ?? 0) === 0).length;
    return { avgSave, maxSave, onlyNext };
  }, [items]);

  const headerEditions = useMemo(() => {
    const curr = items.find(i => i.curr_edition)?.curr_edition ?? null;
    const next = items.find(i => i.next_edition)?.next_edition ?? null;
    return { curr, next };
  }, [items]);

  const handleSort = (col: string) => {
    if (sort === col) {
      setOrder(o => o === 'asc' ? 'desc' : 'asc');
    } else {
      setSort(col);
      setOrder('desc');
    }
    setPage(0);
  };

  const sortIcon = (col: string) => {
    if (sort !== col) return '';
    return order === 'asc' ? ' ▲' : ' ▼';
  };

  const renderTierBadge = (
    qty: number,
    unit: string | null,
    amt: number | null,
    side: 'curr' | 'next'
  ) => {
    if (amt == null) return <span className="text-muted">-</span>;
    return (
      <span className={`rip-tier-badge rip-tier-${side}`}>
        {qty} {tierLabel(unit)} = <strong>${amt.toFixed(0)}</strong>
      </span>
    );
  };

  const filterSections: FilterSection[] = [
    {
      type: 'text',
      key: 'q',
      title: 'Search',
      placeholder: 'Product name or RIP code',
      value: q,
      onChange: v => { setQ(v); setPage(0); },
    },
    {
      type: 'text',
      key: 'rip_code',
      title: 'RIP #',
      placeholder: 'e.g. 10049',
      value: ripCode,
      onChange: v => { setRipCode(v); setPage(0); },
    },
    {
      type: 'pills',
      key: 'wholesaler',
      title: 'Distributor',
      options: ALL_DISTRIBUTORS,
      value: wholesaler,
      onChange: v => { setWholesaler(v); setPage(0); },
    },
    {
      type: 'pills',
      key: 'source',
      title: 'Incentive Type',
      options: [
        { value: '', label: 'All' },
        { value: 'discount', label: 'Discount' },
        { value: 'rip', label: 'RIP' },
      ],
      value: source,
      onChange: v => { setSource(v); setPage(0); },
    },
    {
      type: 'select',
      key: 'product_type',
      title: 'Category',
      placeholder: 'All Categories',
      options: (categories ?? []).map(c => ({
        value: c.product_type,
        label: c.product_type,
        count: c.count,
      })),
      value: productType,
      onChange: v => { setProductType(v); setPage(0); },
    },
    {
      type: 'text',
      key: 'min_save',
      title: 'Min Save / Case',
      placeholder: 'e.g. 50',
      value: minSave,
      onChange: v => { setMinSave(v); setPage(0); },
    },
    {
      type: 'text',
      key: 'min_gp',
      title: 'Min GP %',
      placeholder: 'e.g. 10',
      value: minGp,
      onChange: v => { setMinGp(v); setPage(0); },
    },
    {
      type: 'pills',
      key: 'tier_unit',
      title: 'Tier Unit',
      options: [
        { value: '', label: 'All' },
        { value: 'case', label: 'Cases' },
        { value: 'btl', label: 'Bottles' },
      ],
      value: tierUnit,
      onChange: v => { setTierUnit(v); setPage(0); },
    },
    {
      type: 'pills',
      key: 'new_next',
      title: 'Availability',
      options: [
        { value: '', label: 'All' },
        { value: '1', label: 'New next month' },
      ],
      value: newNext ? '1' : '',
      onChange: v => { setNewNext(v === '1'); setPage(0); },
    },
  ];

  const resetFilters = () => {
    setQ(''); setRipCode(''); setWholesaler(''); setProductType(''); setSource(''); setMinSave('');
    setMinGp(''); setTierUnit(''); setNewNext(false);
    setPage(0);
  };

  return (
    <FilterSidebar storageKey="rip-products" sections={filterSections} onReset={resetFilters}>
    <div className="page">
      <h2 style={{ marginBottom: 4 }}>Products with RIP</h2>
      <p className="text-muted" style={{ marginTop: 0, marginBottom: 12 }}>
        Each tier shown with current month and next month side by side
        {headerEditions.curr && headerEditions.next
          ? ` (${shortMonth(headerEditions.curr)} vs ${shortMonth(headerEditions.next)})`
          : ''}
      </p>

      <div className="rip-filter-bar">
        <RowLimitSelect value={limit} onChange={v => { setLimit(v); setPage(0); }} />
        <span className="search-count">{data?.total?.toLocaleString() ?? 0} tier lines</span>
      </div>

      {stats && (
        <div className="rip-summary-cards">
          <div className="rip-summary-card">
            <div className="rip-summary-value">{data?.total?.toLocaleString()}</div>
            <div className="rip-summary-label">RIP Tier Lines</div>
          </div>
          <div className="rip-summary-card">
            <div className="rip-summary-value text-green">${stats.avgSave.toFixed(2)}</div>
            <div className="rip-summary-label">Avg Save / Case</div>
          </div>
          <div className="rip-summary-card">
            <div className="rip-summary-value text-green">${stats.maxSave.toFixed(2)}</div>
            <div className="rip-summary-label">Max Save / Case</div>
          </div>
          <div className="rip-summary-card">
            <div className="rip-summary-value">{stats.onlyNext}</div>
            <div className="rip-summary-label">New Next Month</div>
          </div>
        </div>
      )}

      {isLoading ? <DataLoading /> : (
        <div className="rip-table-wrap">
          <table className="rip-products-table">
            <thead>
              <tr className="rip-group-header">
                <th colSpan={7} style={{ borderRight: '1px solid var(--border)' }}></th>
                <th colSpan={4} className="rip-group-curr" style={{ borderRight: '1px solid var(--border)' }}>
                  {headerEditions.curr ? `Current (${shortMonth(headerEditions.curr)})` : 'Current'}
                </th>
                <th colSpan={4} className="rip-group-next">
                  {headerEditions.next ? `Next (${shortMonth(headerEditions.next)})` : 'Next'}
                </th>
                <th></th>
                <th></th>
              </tr>
              <tr>
                <th style={{ width: 36 }}></th>
                <th className="sortable" onClick={() => handleSort('product_name')}>
                  Product{sortIcon('product_name')}
                </th>
                <th>Distributor</th>
                <th>Type</th>
                <th>Size</th>
                <th>RIP#</th>
                <th style={{ borderRight: '1px solid var(--border)' }}>Source</th>

                <th className="sortable right" onClick={() => handleSort('curr_case_price')}>
                  Case{sortIcon('curr_case_price')}
                </th>
                <th>RIP</th>
                <th className="sortable right" onClick={() => handleSort('curr_save_per_case')}>
                  Save{sortIcon('curr_save_per_case')}
                </th>
                <th className="sortable right" onClick={() => handleSort('curr_effective_case_price')}
                    style={{ borderRight: '1px solid var(--border)' }}>
                  Effective{sortIcon('curr_effective_case_price')}
                </th>

                <th className="sortable right" onClick={() => handleSort('next_case_price')}>
                  Case{sortIcon('next_case_price')}
                </th>
                <th>RIP</th>
                <th className="sortable right" onClick={() => handleSort('next_save_per_case')}>
                  Save{sortIcon('next_save_per_case')}
                </th>
                <th className="sortable right" onClick={() => handleSort('next_effective_case_price')}>
                  Effective{sortIcon('next_effective_case_price')}
                </th>
                <th>Better</th>
                <th>Order</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item, idx) => {
                const prevItem = idx > 0 ? items[idx - 1] : null;
                const isFirstForProduct = !prevItem ||
                  prevItem.product_name !== item.product_name ||
                  prevItem.wholesaler !== item.wholesaler ||
                  prevItem.unit_volume !== item.unit_volume;

                const code = item.rip_number ?? '';

                return (
                  <tr
                    key={`${item.product_name}-${item.wholesaler}-${item.unit_volume}-${item.rip_qty}-${item.rip_unit}-${idx}`}
                    className={`rip-row ${isFirstForProduct ? 'rip-row-first' : 'rip-row-sub'}`}
                    data-ctx=""
                    data-ctx-product={item.product_name}
                    data-ctx-wholesaler={item.wholesaler}
                    data-ctx-upc={item.upc}
                    data-ctx-volume={item.unit_volume}
                    onClick={() => open(item.product_name, item.wholesaler, undefined, { upc: item.upc, unitVolume: item.unit_volume })}
                  >
                    <td className="card-actions-cell" onClick={e => e.stopPropagation()}>
                      {isFirstForProduct && (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                          <FavoriteButton
                            productName={item.product_name}
                            wholesaler={item.wholesaler}
                            upc={item.upc}
                            unitVolume={item.unit_volume}
                          />
                          <RowMenuButton product={{ product_name: item.product_name, wholesaler: item.wholesaler, upc: item.upc, unit_volume: item.unit_volume }} />
                        </span>
                      )}
                    </td>
                    <td className="card-title-cell">
                      {isFirstForProduct ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <ProductThumb src={item.image_url} alt={item.product_name} size={64} />
                          <div className="rip-cell-product">
                            <span className="rip-product-name">{item.product_name}</span>
                            <span className="rip-product-code">{item.upc}</span>
                          </div>
                        </div>
                      ) : (
                        <span className="rip-sub-indicator">&nbsp;</span>
                      )}
                    </td>
                    <td data-label="Distributor">
                      {isFirstForProduct && (
                        <span className="cell-distributor-badge">
                          {distributorName(item.wholesaler)}
                        </span>
                      )}
                    </td>
                    <td data-label="Type">{isFirstForProduct ? item.product_type : ''}</td>
                    <td data-label="Size">{isFirstForProduct ? item.unit_volume : ''}</td>
                    <td data-label="RIP #">
                      {isFirstForProduct
                        ? (code ? <span className="rip-code-badge">{code}</span> : <span className="text-muted">—</span>)
                        : ''}
                    </td>
                    <td data-label="Incentive" style={{ borderRight: '1px solid var(--border)' }}>
                      <span className={`source-badge source-${item.source}`}>
                        {item.source === 'discount' ? 'Discount' : 'RIP'}
                      </span>
                    </td>

                    {/* Current month */}
                    <td className="right" data-label="Case (now)">
                      {isFirstForProduct ? fmtPrice(item.curr_case_price) : ''}
                    </td>
                    <td data-label="Tier (now)">
                      {renderTierBadge(item.rip_qty, item.rip_unit, item.curr_rip_amt, 'curr')}
                    </td>
                    <td className="right" data-label="Save (now)">
                      {item.curr_save_per_case != null
                        ? <span className="text-green font-bold">{fmtSave(item.curr_save_per_case)}</span>
                        : <span className="text-muted">-</span>}
                    </td>
                    <td className="right font-bold" data-label="Eff (now)" style={{ borderRight: '1px solid var(--border)' }}>
                      {fmtPrice(item.curr_effective_case_price)}
                    </td>

                    {/* Next month */}
                    <td className="right" data-label="Case (next)">
                      {isFirstForProduct ? fmtPrice(item.next_case_price) : ''}
                    </td>
                    <td data-label="Tier (next)">
                      {renderTierBadge(item.rip_qty, item.rip_unit, item.next_rip_amt, 'next')}
                    </td>
                    <td className="right" data-label="Save (next)">
                      {item.next_save_per_case != null
                        ? <span className="text-green font-bold">{fmtSave(item.next_save_per_case)}</span>
                        : <span className="text-muted">-</span>}
                    </td>
                    <td className="right font-bold" data-label="Eff (next)">
                      {fmtPrice(item.next_effective_case_price)}
                    </td>
                    <td data-label="Better">
                      {(() => {
                        const bm = betterMonth(item.curr_save_per_case, item.next_save_per_case);
                        return bm
                          ? <span className="better-price-badge" data-variant={bm.variant}>{bm.label}</span>
                          : <span className="text-muted">—</span>;
                      })()}
                    </td>
                    <td onClick={e => e.stopPropagation()}>
                      {isFirstForProduct && (() => {
                        const ckey = `${item.product_name}|${item.wholesaler}`;
                        const q = cart[ckey] ?? { cases: 0, units: 0 };
                        return (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 120 }}>
                            <QtyStepper label="Btl" value={q.units} onChange={v => updateQty(ckey, 'units', v)} />
                            <QtyStepper label="Case" value={q.cases} onChange={v => updateQty(ckey, 'cases', v)} />
                            <AddToCartButton productName={item.product_name} wholesaler={item.wholesaler}
                              upc={item.upc} unitVolume={item.unit_volume} qtyCases={q.cases} qtyUnits={q.units} />
                            <AddToListButton productName={item.product_name} wholesaler={item.wholesaler}
                              upc={item.upc} unitVolume={item.unit_volume} />
                          </div>
                        );
                      })()}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="pagination">
        <button disabled={page === 0} onClick={() => setPage(p => p - 1)}>Prev</button>
        <span>Page {page + 1} of {Math.max(1, Math.ceil((data?.total ?? 0) / limit))}</span>
        <button disabled={(page + 1) * limit >= (data?.total ?? 0)} onClick={() => setPage(p => p + 1)}>Next</button>
      </div>
    </div>
    </FilterSidebar>
  );
}
