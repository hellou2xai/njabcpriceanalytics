import { useEffect, useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Percent } from 'lucide-react';
import { deals, watchlist, catalog } from '../lib/api';
import FilterSidebar, { type FilterSection } from '../components/FilterSidebar';
import TrackedOnlyToggle from '../components/TrackedOnlyToggle';
import PromotionsToolbar from '../components/PromotionsToolbar';
import PromotionsTable, { type PromotionRow } from '../components/PromotionsTable';
import { ContextMenuProvider } from '../components/ContextMenu';
import { useProductQuickView } from '../components/ProductQuickView';
import { ALL_DISTRIBUTORS } from '../lib/distributors';
import type { Product } from '../lib/api';

// Admin-only "Top Discounts" page. Uses the same toolbar, table, and column
// set as the other Promotions pages so admins see the data in the familiar
// shape (Time-Sensitive Deals, Major Discounts, Price Drops, Price Increases).
export default function Discounts() {
  const [wholesaler, setWholesaler] = useState('');
  const [q, setQ] = useState('');
  const [productType, setProductType] = useState('');
  const [minDiscount, setMinDiscount] = useState('');
  const [limit, setLimit] = useState(60);
  const [trackedOnly, setTrackedOnly] = useState(false);
  const [hasRip, setHasRip] = useState<'' | 'yes' | 'no'>('');
  const [sort, setSort] = useState<'biggest-pct' | 'biggest-save' | 'name'>('biggest-pct');
  const [view, setView] = useState<'cards' | 'table'>(() => (localStorage.getItem('topdisc-view') as 'cards' | 'table') || 'table');
  useEffect(() => { localStorage.setItem('topdisc-view', view); }, [view]);
  const { open } = useProductQuickView();

  const { data } = useQuery({
    queryKey: ['discounts', wholesaler, productType, minDiscount, sort],
    queryFn: () => deals.discounts({
      wholesaler: wholesaler || undefined,
      product_type: productType || undefined,
      min_discount_pct: minDiscount ? parseFloat(minDiscount) : undefined,
      sort: sort === 'biggest-save' ? 'total_savings_per_case' : 'discount_pct',
      limit: 1000,
    }),
  });

  const { data: wl } = useQuery({ queryKey: ['watchlist'], queryFn: watchlist.get, enabled: trackedOnly });

  const { data: categories } = useQuery({
    queryKey: ['categories', wholesaler],
    queryFn: () => catalog.categories({ wholesaler: wholesaler || undefined }),
  });

  const items = useMemo(() => {
    let result = data ?? [];
    if (q) {
      const ql = q.toLowerCase();
      result = result.filter(i => i.product_name.toLowerCase().includes(ql));
    }
    if (trackedOnly && wl) {
      const tracked = new Set(wl.map(i => `${i.product_name}|${i.wholesaler}`));
      result = result.filter(i => tracked.has(`${i.product_name}|${i.wholesaler}`));
    }
    if (hasRip === 'yes') result = result.filter(i => i.has_rip);
    if (hasRip === 'no')  result = result.filter(i => !i.has_rip);
    if (sort === 'name')  result = [...result].sort((a, b) => a.product_name.localeCompare(b.product_name));
    return result;
  }, [data, q, trackedOnly, wl, hasRip, sort]);

  const sections: FilterSection[] = [
    { type: 'text',  key: 'q', title: 'Search', placeholder: 'Product name', value: q, onChange: setQ },
    { type: 'pills', key: 'wholesaler', title: 'Distributor', options: ALL_DISTRIBUTORS, value: wholesaler, onChange: setWholesaler },
    { type: 'select', key: 'product_type', title: 'Category', placeholder: 'All categories',
      options: (categories ?? []).map(c => ({ value: c.product_type, label: c.product_type, count: c.count })),
      value: productType, onChange: setProductType },
    { type: 'pills', key: 'min_discount', title: 'Min discount %', value: minDiscount, onChange: setMinDiscount,
      options: [
        { value: '', label: 'Any' }, { value: '5', label: '5%+' }, { value: '10', label: '10%+' },
        { value: '15', label: '15%+' }, { value: '20', label: '20%+' }, { value: '30', label: '30%+' },
      ] },
    { type: 'pills', key: 'has_rip', title: 'Has RIP', value: hasRip, onChange: v => setHasRip(v as '' | 'yes' | 'no'),
      options: [{ value: '', label: 'Any' }, { value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }] },
    { type: 'custom', key: 'tracked', title: 'Favorites',
      render: () => <TrackedOnlyToggle enabled={trackedOnly} onChange={setTrackedOnly} /> },
  ];

  const sortOptions = [
    { value: 'biggest-pct' as const,  label: 'Biggest % off' },
    { value: 'biggest-save' as const, label: 'Biggest saving $' },
    { value: 'name' as const,         label: 'Name (A-Z)' },
  ];

  const resetFilters = () => {
    setQ(''); setWholesaler(''); setProductType(''); setMinDiscount(''); setHasRip('');
    setTrackedOnly(false); setSort('biggest-pct');
  };

  return (
    <div className="page">
      <div className="orders-header">
        <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Percent size={22} color="#2563eb" /> Top Discounts
        </h2>
        <span className="text-muted" style={{ fontSize: 13 }}>
          {`${items.length.toLocaleString()} product${items.length === 1 ? '' : 's'}`}
        </span>
      </div>
      <p className="text-muted" style={{ marginTop: 0, fontSize: 13 }}>
        Admin view of the full discount ranker. Same columns as every other Promotions page.
      </p>

      <div className="catalog-layout">
        <FilterSidebar storageKey="discounts" sections={sections} onReset={resetFilters} />

        <div className="catalog-results">
          <PromotionsToolbar
            sortValue={sort}
            onSortChange={setSort}
            sortOptions={sortOptions}
            limit={limit}
            onLimitChange={setLimit}
            total={items.length}
            shownInCards={limit}
            view={view}
            onViewChange={setView}
            noun="discounts"
          />

          <ContextMenuProvider onView={open}>
            {view === 'cards' ? (
              <div className="empty" style={{ padding: 30, textAlign: 'center' }}>
                Top Discounts is a table-only admin view. Switch to <strong>Table</strong> above.
              </div>
            ) : (
              <PromotionsTable
                rows={items.slice(0, view === 'table' ? items.length : limit).map(productToPromotionRow)}
                exportName="top-discounts"
                onRowClick={r => open(r.product_name, r.wholesaler, undefined,
                  { upc: r.upc ?? undefined, unitVolume: r.unit_volume ?? undefined })}
              />
            )}
          </ContextMenuProvider>
        </div>
      </div>
    </div>
  );
}

// ---- adapter: Product -> standard PromotionRow ----
// Same shape as MajorDiscounts: edition month gives Starts/Ends/Days.
function editionMonthStart(ed?: string | null): string | null {
  if (!ed) return null;
  const m = /^(\d{4})-(\d{1,2})/.exec(ed);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-01` : null;
}
function editionMonthEnd(ed?: string | null): string | null {
  if (!ed) return null;
  const m = /^(\d{4})-(\d{1,2})/.exec(ed);
  if (!m) return null;
  const y = parseInt(m[1], 10); const mo = parseInt(m[2], 10);
  const d = new Date(y, mo, 0);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function daysFromTodayTo(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso); if (isNaN(t)) return null;
  const now = new Date(); const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((t - today) / 86400000);
}
function productToPromotionRow(p: Product): PromotionRow {
  const from = editionMonthStart(p.edition);
  const to   = editionMonthEnd(p.edition);
  const days = daysFromTodayTo(to);
  const qty = Number(p.unit_qty) || 0;
  const net = p.effective_case_price ?? null;
  const netBtl = qty > 0 && net != null ? net / qty : null;
  const full = p.frontline_case_price ?? null;
  const gp = full != null && net != null && full > 0 ? ((full - net) / full) * 100 : null;
  const typeLabel = p.has_closeout ? 'Closeout' : (p.has_rip ? 'RIP rebate' : 'Discount');
  return {
    product_name: p.product_name,
    brand: p.brand ?? null,
    wholesaler: p.wholesaler,
    upc: p.upc ?? null,
    product_type: p.product_type ?? null,
    unit_volume: p.unit_volume ?? null,
    type_label: typeLabel,
    from_date: from,
    to_date: to,
    days_to_expire: days,
    orig_case_price: full,
    disc_per_case: p.total_savings_per_case ?? null,
    net_case_price: net,
    net_btl_price: netBtl,
    gp_pct: gp,
    off_pct: p.discount_pct ?? null,
    has_rip: p.has_rip ?? false,
    has_closeout: p.has_closeout ?? false,
    ai_blurb: p.ai_blurb ?? null,
    sticker: null,
  };
}
