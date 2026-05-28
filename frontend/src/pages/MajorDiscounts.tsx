import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { LayoutGrid, Table as TableIcon, Percent } from 'lucide-react';
import { deals, watchlist, catalog, type Product } from '../lib/api';
import { ContextMenuProvider, RowMenuButton } from '../components/ContextMenu';
import FavoriteButton from '../components/FavoriteButton';
import AddToCartButton from '../components/AddToCartButton';
import AddToListButton from '../components/AddToListButton';
import ProductThumb from '../components/ProductThumb';
import FilterSidebar, { type FilterSection } from '../components/FilterSidebar';
import RowLimitSelect from '../components/RowLimitSelect';
import SortableTable from '../components/SortableTable';
import DealSparkline from '../components/DealSparkline';
import { useProductQuickView } from '../components/ProductQuickView';
import { distributorName, ALL_DISTRIBUTORS } from '../lib/distributors';

const money = (v?: number | null) => (v == null ? '-' : `$${Number(v).toFixed(2)}`);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtEdition(ed?: string | null): string {
  if (!ed) return '-';
  const m = /^(\d{4})-(\d{1,2})/.exec(ed);
  return m ? `${MONTHS[parseInt(m[2], 10) - 1]} ${m[1]}` : ed;
}

export default function MajorDiscounts() {
  const { open } = useProductQuickView();
  const [wholesaler, setWholesaler] = useState('');
  const [q, setQ] = useState('');
  const [productType, setProductType] = useState('');
  const [minSave, setMinSave] = useState('');
  const [minDiscount, setMinDiscount] = useState('');
  const [hasRip, setHasRip] = useState<'' | 'yes' | 'no'>('');
  const [hasCloseout, setHasCloseout] = useState<'' | 'yes' | 'no'>('');
  const [size, setSize] = useState('');
  const [trackedOnly, setTrackedOnly] = useState(false);
  const [sort, setSort] = useState<'biggest-save' | 'biggest-pct' | 'name'>('biggest-save');
  const [limit, setLimit] = useState(60);
  const [view, setView] = useState<'cards' | 'table'>(() => (localStorage.getItem('md-view') as 'cards' | 'table') || 'cards');
  useEffect(() => { localStorage.setItem('md-view', view); }, [view]);

  const { data, isLoading } = useQuery({
    queryKey: ['major-discounts', wholesaler, minDiscount, sort],
    queryFn: () => deals.discounts({
      wholesaler: wholesaler || undefined,
      min_discount_pct: minDiscount ? parseFloat(minDiscount) : undefined,
      sort: sort === 'biggest-pct' ? 'discount_pct' : 'total_savings_per_case',
      limit: 1000,
    }),
  });
  const { data: wl } = useQuery({ queryKey: ['watchlist'], queryFn: watchlist.get, enabled: trackedOnly });
  const { data: cats } = useQuery({
    queryKey: ['categories', wholesaler],
    queryFn: () => catalog.categories({ wholesaler: wholesaler || undefined }),
  });

  const items = useMemo(() => {
    let res: Product[] = data ?? [];
    if (q) {
      const ql = q.toLowerCase();
      res = res.filter(i => i.product_name.toLowerCase().includes(ql) || (i.brand ?? '').toLowerCase().includes(ql));
    }
    if (productType) res = res.filter(i => i.product_type === productType);
    if (size) res = res.filter(i => (i.unit_volume ?? '').toLowerCase().includes(size.toLowerCase()));
    if (hasRip === 'yes') res = res.filter(i => i.has_rip);
    if (hasRip === 'no') res = res.filter(i => !i.has_rip);
    if (hasCloseout === 'yes') res = res.filter(i => i.has_closeout);
    if (hasCloseout === 'no') res = res.filter(i => !i.has_closeout);
    if (minSave) { const n = parseFloat(minSave); res = res.filter(i => (i.total_savings_per_case ?? 0) >= n); }
    if (trackedOnly && wl) {
      const tracked = new Set(wl.map(i => `${i.product_name}|${i.wholesaler}`));
      res = res.filter(i => tracked.has(`${i.product_name}|${i.wholesaler}`));
    }
    if (sort === 'name') res = [...res].sort((a, b) => a.product_name.localeCompare(b.product_name));
    return res;
  }, [data, q, productType, size, hasRip, hasCloseout, minSave, trackedOnly, wl, sort]);

  const shown = items.slice(0, limit);

  const sections: FilterSection[] = [
    { type: 'text', key: 'q', title: 'Search', placeholder: 'Product or brand', value: q, onChange: setQ },
    { type: 'pills', key: 'wholesaler', title: 'Distributor', options: ALL_DISTRIBUTORS, value: wholesaler, onChange: setWholesaler },
    { type: 'select', key: 'product_type', title: 'Category', placeholder: 'All categories',
      options: (cats ?? []).map(c => ({ value: c.product_type, label: c.product_type, count: c.count })),
      value: productType, onChange: setProductType },
    { type: 'pills', key: 'min_save', title: 'Min saving / case', value: minSave, onChange: setMinSave,
      options: [
        { value: '', label: 'Any' }, { value: '5', label: '$5+' }, { value: '10', label: '$10+' },
        { value: '25', label: '$25+' }, { value: '50', label: '$50+' }, { value: '100', label: '$100+' },
      ] },
    { type: 'pills', key: 'min_pct', title: 'Min discount %', value: minDiscount, onChange: setMinDiscount,
      options: [
        { value: '', label: 'Any' }, { value: '5', label: '5%+' }, { value: '10', label: '10%+' },
        { value: '15', label: '15%+' }, { value: '25', label: '25%+' },
      ] },
    { type: 'pills', key: 'has_rip', title: 'Has RIP rebate', value: hasRip, onChange: v => setHasRip(v as '' | 'yes' | 'no'),
      options: [{ value: '', label: 'Any' }, { value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }] },
    { type: 'pills', key: 'has_closeout', title: 'Closeout', value: hasCloseout, onChange: v => setHasCloseout(v as '' | 'yes' | 'no'),
      options: [{ value: '', label: 'Any' }, { value: 'yes', label: 'Closeout' }, { value: 'no', label: 'No' }] },
    { type: 'text', key: 'size', title: 'Size', placeholder: 'e.g. 750ML, 1.75L', value: size, onChange: setSize },
    { type: 'toggle', key: 'tracked', title: 'Favorites', value: trackedOnly, onChange: setTrackedOnly, label: 'Only my favourites' },
    { type: 'pills', key: 'sort', title: 'Sort by', value: sort, onChange: v => setSort(v as 'biggest-save' | 'biggest-pct' | 'name'),
      options: [
        { value: 'biggest-save', label: 'Biggest saving $' },
        { value: 'biggest-pct', label: 'Biggest %' },
        { value: 'name', label: 'Name (A-Z)' },
      ] },
  ];

  return (
    <div className="page">
      <div className="orders-header">
        <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Percent size={22} color="#2563eb" /> Major Discounts
        </h2>
        <span className="text-muted" style={{ fontSize: 13 }}>
          {isLoading ? 'Loading…' : `${items.length.toLocaleString()} product${items.length === 1 ? '' : 's'}`}
        </span>
      </div>
      <p className="text-muted" style={{ marginTop: 0, fontSize: 13 }}>
        Products with the biggest active discounts this edition. Largest savings per case at the top.
      </p>

      <div className="catalog-layout">
        <FilterSidebar storageKey="md-filters" sections={sections}
          onReset={() => { setQ(''); setWholesaler(''); setProductType(''); setMinSave(''); setMinDiscount(''); setHasRip(''); setHasCloseout(''); setSize(''); setTrackedOnly(false); setSort('biggest-save'); }} />

        <div className="catalog-results">
          <div className="toolbar" style={{ marginBottom: 12 }}>
            <RowLimitSelect value={limit} onChange={setLimit} />
            <span className="text-muted" style={{ fontSize: 12 }}>
              Showing {view === 'table' ? items.length : Math.min(limit, items.length)} of {items.length}
            </span>
            <span className="ts-view-toggle" role="group" aria-label="View mode">
              <button type="button" className={`btn btn-sm ${view === 'cards' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setView('cards')}>
                <LayoutGrid size={14} /> Cards
              </button>
              <button type="button" className={`btn btn-sm ${view === 'table' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setView('table')}>
                <TableIcon size={14} /> Table
              </button>
            </span>
          </div>

          <ContextMenuProvider onView={open}>
            {view === 'cards' ? (
              <div className="deal-cards">
                {shown.map(d => <DiscountCard key={`${d.wholesaler}|${d.upc ?? d.product_name}`} d={d} open={open} />)}
                {!isLoading && shown.length === 0 && (
                  <div className="empty" style={{ padding: 30, textAlign: 'center' }}>No products match these filters.</div>
                )}
              </div>
            ) : (
              <div className="dense-table">
                <SortableTable
                  data={items as unknown as Record<string, unknown>[]}
                  pageSize={50}
                  exportName="major-discounts"
                  onRowClick={r => open(r.product_name as string, r.wholesaler as string, undefined,
                    { upc: (r.upc as string) ?? undefined, unitVolume: (r.unit_volume as string) ?? undefined })}
                  columns={[
                    { key: 'product_name', label: 'Product', sortable: true,
                      render: r => r.product_name as string },
                    { key: 'brand', label: 'Brand', sortable: true,
                      render: r => (r.brand as string | null) ?? '-' },
                    { key: 'wholesaler', label: 'Distributor', sortable: true,
                      render: r => distributorName(r.wholesaler as string) },
                    { key: 'product_type', label: 'Category', sortable: true },
                    { key: 'unit_volume', label: 'Size' },
                    { key: 'frontline_case_price', label: 'List/cs', align: 'right', sortable: true,
                      render: r => money(r.frontline_case_price as number | null) },
                    { key: 'effective_case_price', label: 'Net/cs', align: 'right', sortable: true,
                      render: r => <strong>{money(r.effective_case_price as number | null)}</strong> },
                    { key: 'total_savings_per_case', label: 'Save/cs', align: 'right', sortable: true,
                      render: r => {
                        const v = r.total_savings_per_case as number | null;
                        return v != null ? <span className="text-green">{money(v)}</span> : '-';
                      } },
                    { key: 'discount_pct', label: '% off', align: 'right', sortable: true,
                      render: r => r.discount_pct != null ? `${(r.discount_pct as number).toFixed(0)}%` : '-' },
                    { key: 'has_rip', label: 'RIP', align: 'center',
                      render: r => r.has_rip ? <span className="source-badge source-rip">RIP</span> : '' },
                    { key: 'has_closeout', label: 'Closeout', align: 'center',
                      render: r => r.has_closeout ? <span className="tag tag-orange">Closeout</span> : '' },
                    { key: 'edition', label: 'Edition', sortable: true,
                      render: r => <span className="mover-month">{fmtEdition(r.edition as string)}</span> },
                    { key: 'ai_blurb', label: 'AI note',
                      exportValue: r => (r.ai_blurb as string | null) ?? '',
                      render: r => r.ai_blurb
                        ? <span title={r.ai_blurb as string} style={{ color: 'var(--accent)', fontSize: 12 }}>✨ hover</span>
                        : <span className="text-muted">-</span> },
                  ]}
                />
              </div>
            )}
          </ContextMenuProvider>
        </div>
      </div>
    </div>
  );
}

function DiscountCard({ d, open }: { d: Product; open: (n: string, w: string, c?: unknown, opts?: { upc?: string; unitVolume?: string }) => void }) {
  const list = d.frontline_case_price ?? null;
  const eff = d.effective_case_price ?? null;
  const save = d.total_savings_per_case ?? null;
  const pct = d.discount_pct ?? null;
  const uq = Number(d.unit_qty) || 0;
  const effBtl = eff != null && uq > 1 ? eff / uq : null;
  return (
    <div className="deal-card" role="button" tabIndex={0}
         data-ctx data-ctx-product={d.product_name} data-ctx-wholesaler={d.wholesaler}
         data-ctx-upc={d.upc ?? ''} data-ctx-volume={d.unit_volume ?? ''}
         onClick={(e) => {
           const t = e.target as HTMLElement;
           if (t.closest('button, a, input, label, .deal-card-actions, .add-to-list-menu, .row-menu-btn, .ctx-menu')) return;
           open(d.product_name, d.wholesaler, undefined, { upc: d.upc ?? undefined, unitVolume: d.unit_volume ?? undefined });
         }}
         onKeyDown={(e) => {
           if (e.key === 'Enter' || e.key === ' ') {
             e.preventDefault();
             open(d.product_name, d.wholesaler, undefined, { upc: d.upc ?? undefined, unitVolume: d.unit_volume ?? undefined });
           }
         }}>
      <div className="deal-card-head">
        <ProductThumb src={d.image_url ?? undefined} alt={d.product_name} size={70} />
        <div className="deal-card-id">
          <div className="deal-card-name" title={d.product_name}>{d.product_name}</div>
          <div className="deal-card-sub">
            {d.brand && <span>{d.brand}</span>}
            {d.unit_volume && <span>· {d.unit_volume}</span>}
            <span className="cell-distributor-badge">{distributorName(d.wholesaler)}</span>
          </div>
        </div>
        <div className="deal-card-pills">
          <span className="deal-urgency" style={{ background: '#dcfce7', color: '#15803d' }}>Discount</span>
          <span className="mover-month">Active {fmtEdition(d.edition)}</span>
        </div>
      </div>

      <div className="deal-card-price">
        {list != null && <span className="deal-was">{money(list)}</span>}
        <span className="deal-now">{money(eff ?? list)}<span className="deal-unit">/cs</span></span>
        {save != null && save > 0 && (
          <span className="deal-save">Save <strong>{money(save)}/cs</strong>{pct ? ` · ${pct.toFixed(0)}% off` : ''}</span>
        )}
      </div>

      <div className="deal-card-meta">
        {effBtl != null && <span>{money(effBtl)}/btl effective</span>}
        {d.has_rip && <span className="source-badge source-rip">RIP rebate stacks</span>}
        {d.has_closeout && <span className="tag tag-orange">Closeout</span>}
        {(d.discount_source && d.discount_source.length > 0) && (
          <span className="text-muted">· {d.discount_source.join(' + ')}</span>
        )}
      </div>

      <div className="deal-card-spark">
        <DealSparkline wholesaler={d.wholesaler} productName={d.product_name} />
        <span className="text-muted" style={{ fontSize: 11 }}>Edition {fmtEdition(d.edition)}</span>
      </div>

      {d.ai_blurb && (
        <div className="deal-card-ai" title="AI explanation of this discount">
          <span className="deal-ai-mark">✨</span> {d.ai_blurb}
        </div>
      )}

      <div className="deal-card-actions">
        <FavoriteButton productName={d.product_name} wholesaler={d.wholesaler}
          upc={d.upc ?? undefined} unitVolume={d.unit_volume ?? undefined} />
        <AddToCartButton productName={d.product_name} wholesaler={d.wholesaler}
          upc={d.upc ?? undefined} unitVolume={d.unit_volume ?? undefined} qtyCases={1} qtyUnits={0} />
        <AddToListButton productName={d.product_name} wholesaler={d.wholesaler}
          upc={d.upc ?? undefined} unitVolume={d.unit_volume ?? undefined} />
        <RowMenuButton product={{ product_name: d.product_name, wholesaler: d.wholesaler, upc: d.upc ?? undefined, unit_volume: d.unit_volume ?? undefined }} />
      </div>
    </div>
  );
}
