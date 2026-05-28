import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { LayoutGrid, Table as TableIcon, ArrowDownRight, ArrowUpRight } from 'lucide-react';
import { analytics, watchlist, catalog, type PriceMover } from '../lib/api';
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
const pct = (v?: number | null, sign = false) => v == null ? '-' : `${sign && v > 0 ? '+' : ''}${v.toFixed(1)}%`;

interface Props { direction: 'up' | 'down'; }

export default function PriceMovers({ direction }: Props) {
  const isDrop = direction === 'down';
  const accent = isDrop ? '#16a34a' : '#dc2626';
  const Icon = isDrop ? ArrowDownRight : ArrowUpRight;
  const title = isDrop ? 'Price Drops' : 'Price Increases';

  const { open } = useProductQuickView();
  const [wholesaler, setWholesaler] = useState('');
  const [q, setQ] = useState('');
  const [productType, setProductType] = useState('');
  const [minChange, setMinChange] = useState('');     // min ABS % change
  const [minDollar, setMinDollar] = useState('');     // min ABS $ change per case
  const [hasRip, setHasRip] = useState<'' | 'yes' | 'no'>('');
  const [size, setSize] = useState('');
  const [trackedOnly, setTrackedOnly] = useState(false);
  const [sort, setSort] = useState<'biggest-pct' | 'biggest-dollar' | 'name'>('biggest-pct');
  const [limit, setLimit] = useState(60);
  const [view, setView] = useState<'cards' | 'table'>(() => (localStorage.getItem('pm-view') as 'cards' | 'table') || 'cards');
  useEffect(() => { localStorage.setItem('pm-view', view); }, [view]);

  const { data, isLoading } = useQuery({
    queryKey: ['price-movers', direction, wholesaler],
    queryFn: () => analytics.priceMovers({ direction, wholesaler: wholesaler || undefined, limit: 2000 }),
  });
  const { data: wl } = useQuery({ queryKey: ['watchlist'], queryFn: watchlist.get, enabled: trackedOnly });
  const { data: cats } = useQuery({
    queryKey: ['categories', wholesaler],
    queryFn: () => catalog.categories({ wholesaler: wholesaler || undefined }),
  });

  const items = useMemo(() => {
    let res: PriceMover[] = data ?? [];
    if (q) {
      const ql = q.toLowerCase();
      res = res.filter(i => i.product_name.toLowerCase().includes(ql) || (i.brand ?? '').toLowerCase().includes(ql));
    }
    if (productType) res = res.filter(i => i.product_type === productType);
    if (size) res = res.filter(i => (i.unit_volume ?? '').toLowerCase().includes(size.toLowerCase()));
    if (hasRip === 'yes') res = res.filter(i => i.has_rip);
    if (hasRip === 'no') res = res.filter(i => !i.has_rip);
    if (minChange) { const n = parseFloat(minChange); res = res.filter(i => Math.abs(i.case_delta_pct ?? 0) >= n); }
    if (minDollar) { const n = parseFloat(minDollar); res = res.filter(i => Math.abs(i.case_delta ?? 0) >= n); }
    if (trackedOnly && wl) {
      const tracked = new Set(wl.map(i => `${i.product_name}|${i.wholesaler}`));
      res = res.filter(i => tracked.has(`${i.product_name}|${i.wholesaler}`));
    }
    switch (sort) {
      case 'biggest-dollar': res = [...res].sort((a, b) => Math.abs(b.case_delta ?? 0) - Math.abs(a.case_delta ?? 0)); break;
      case 'name':           res = [...res].sort((a, b) => a.product_name.localeCompare(b.product_name)); break;
      case 'biggest-pct':
      default:               res = [...res].sort((a, b) => Math.abs(b.case_delta_pct ?? 0) - Math.abs(a.case_delta_pct ?? 0));
    }
    return res;
  }, [data, q, productType, size, hasRip, minChange, minDollar, trackedOnly, wl, sort]);

  const shown = items.slice(0, limit);

  const sections: FilterSection[] = [
    { type: 'text', key: 'q', title: 'Search', placeholder: 'Product or brand', value: q, onChange: setQ },
    { type: 'pills', key: 'wholesaler', title: 'Distributor', options: ALL_DISTRIBUTORS, value: wholesaler, onChange: setWholesaler },
    { type: 'select', key: 'product_type', title: 'Category', placeholder: 'All categories',
      options: (cats ?? []).map(c => ({ value: c.product_type, label: c.product_type, count: c.count })),
      value: productType, onChange: setProductType },
    { type: 'pills', key: 'min_pct', title: `Min ${isDrop ? 'drop' : 'rise'} %`, value: minChange, onChange: setMinChange,
      options: [
        { value: '', label: 'Any' }, { value: '2', label: '2%+' }, { value: '5', label: '5%+' },
        { value: '10', label: '10%+' }, { value: '20', label: '20%+' },
      ] },
    { type: 'pills', key: 'min_dollar', title: 'Min change / case', value: minDollar, onChange: setMinDollar,
      options: [
        { value: '', label: 'Any' }, { value: '5', label: '$5+' }, { value: '10', label: '$10+' },
        { value: '25', label: '$25+' }, { value: '50', label: '$50+' },
      ] },
    { type: 'pills', key: 'has_rip', title: 'Has RIP rebate', value: hasRip, onChange: v => setHasRip(v as '' | 'yes' | 'no'),
      options: [{ value: '', label: 'Any' }, { value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }] },
    { type: 'text', key: 'size', title: 'Size', placeholder: 'e.g. 750ML, 1.75L', value: size, onChange: setSize },
    { type: 'toggle', key: 'tracked', title: 'Favorites', value: trackedOnly, onChange: setTrackedOnly, label: 'Only my favourites' },
    { type: 'pills', key: 'sort', title: 'Sort by', value: sort, onChange: v => setSort(v as 'biggest-pct' | 'biggest-dollar' | 'name'),
      options: [
        { value: 'biggest-pct', label: 'Biggest %' },
        { value: 'biggest-dollar', label: 'Biggest $ change' },
        { value: 'name', label: 'Name (A-Z)' },
      ] },
  ];

  return (
    <div className="page">
      <div className="orders-header">
        <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Icon size={22} color={accent} /> {title}
        </h2>
        <span className="text-muted" style={{ fontSize: 13 }}>
          {isLoading ? 'Loading…' : `${items.length.toLocaleString()} product${items.length === 1 ? '' : 's'}`}
        </span>
      </div>
      <p className="text-muted" style={{ marginTop: 0, fontSize: 13 }}>
        {isDrop
          ? 'Products whose frontline case price went down in the latest edition versus the prior one. Bigger drops at the top.'
          : 'Products whose frontline case price went up in the latest edition versus the prior one. Bigger rises at the top.'}
      </p>

      <div className="catalog-layout">
        <FilterSidebar storageKey={`pm-${direction}-filters`} sections={sections}
          onReset={() => { setQ(''); setWholesaler(''); setProductType(''); setMinChange(''); setMinDollar(''); setHasRip(''); setSize(''); setTrackedOnly(false); setSort('biggest-pct'); }} />

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
                {shown.map(d => <MoverCard key={`${d.wholesaler}|${d.upc ?? d.product_name}`} d={d} isDrop={isDrop} open={open} />)}
                {!isLoading && shown.length === 0 && (
                  <div className="empty" style={{ padding: 30, textAlign: 'center' }}>No products match these filters.</div>
                )}
              </div>
            ) : (
              <div className="dense-table">
                <SortableTable
                  data={items as unknown as Record<string, unknown>[]}
                  pageSize={50}
                  exportName={isDrop ? 'price-drops' : 'price-increases'}
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
                    { key: 'vintage', label: 'Vintage',
                      render: r => (r.vintage as string | null) ?? '-' },
                    { key: 'prev_case_price', label: 'Was/cs', align: 'right', sortable: true,
                      render: r => money(r.prev_case_price as number | null) },
                    { key: 'case_price', label: 'Now/cs', align: 'right', sortable: true,
                      render: r => <strong>{money(r.case_price as number | null)}</strong> },
                    { key: 'case_delta', label: 'Δ $', align: 'right', sortable: true,
                      render: r => {
                        const v = r.case_delta as number | null;
                        if (v == null) return '-';
                        return <span style={{ fontWeight: 700, color: v < 0 ? '#16a34a' : '#dc2626' }}>{v > 0 ? '+' : ''}{money(v)}</span>;
                      } },
                    { key: 'case_delta_pct', label: 'Δ %', align: 'right', sortable: true,
                      render: r => {
                        const v = r.case_delta_pct as number | null;
                        if (v == null) return '-';
                        return <span style={{ fontWeight: 700, color: v < 0 ? '#16a34a' : '#dc2626' }}>{pct(v, true)}</span>;
                      } },
                    { key: 'effective_case_price', label: 'Net/cs', align: 'right', sortable: true,
                      render: r => money(r.effective_case_price as number | null) },
                    { key: 'has_rip', label: 'RIP', align: 'center',
                      render: r => r.has_rip ? <span className="source-badge source-rip">RIP</span> : '' },
                    { key: 'edition', label: 'Edition' },
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

function MoverCard({ d, isDrop, open }: { d: PriceMover; isDrop: boolean; open: (n: string, w: string, c?: unknown, opts?: { upc?: string; unitVolume?: string }) => void }) {
  const prev = d.prev_case_price ?? null;
  const now = d.case_price ?? null;
  const delta = d.case_delta ?? null;
  const deltaPct = d.case_delta_pct ?? null;
  const eff = d.effective_case_price ?? null;
  const uq = Number(d.unit_qty) || 0;
  const effBtl = eff != null && uq > 1 ? eff / uq : null;
  const colour = isDrop ? '#16a34a' : '#dc2626';
  const bgClass = isDrop ? 'mover-card--drop' : 'mover-card--rise';

  return (
    <div className={`deal-card mover-card ${bgClass}`} role="button" tabIndex={0}
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
        <span className="deal-urgency" style={{ background: isDrop ? '#dcfce7' : '#fee2e2', color: colour }}>
          {isDrop ? 'Price drop' : 'Price up'}
        </span>
      </div>

      <div className="deal-card-price">
        {prev != null && <span className="deal-was">{money(prev)}</span>}
        <span className="deal-now" style={{ color: colour }}>{money(now)}<span className="deal-unit">/cs</span></span>
        {delta != null && (
          <span className="deal-save" style={{ color: colour }}>
            <strong>{delta > 0 ? '+' : ''}{money(delta)}/cs</strong>{deltaPct != null ? ` · ${pct(deltaPct, true)}` : ''}
          </span>
        )}
      </div>

      <div className="deal-card-meta">
        {eff != null && <span>Net {money(eff)}/cs (after deals)</span>}
        {effBtl != null && <span>· {money(effBtl)}/btl</span>}
        {d.has_rip && <span className="source-badge source-rip">RIP rebate stacks</span>}
        {d.vintage && <span>· Vintage {d.vintage}</span>}
      </div>

      <div className="deal-card-spark">
        <DealSparkline wholesaler={d.wholesaler} productName={d.product_name} />
        <span className="text-muted" style={{ fontSize: 11 }}>Edition {d.edition}</span>
      </div>

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
