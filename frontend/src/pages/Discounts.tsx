import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { deals, watchlist, catalog } from '../lib/api';
import SortableTable from '../components/SortableTable';
import FavoriteButton from '../components/FavoriteButton';
import ProductThumb from '../components/ProductThumb';
import TrackedOnlyToggle from '../components/TrackedOnlyToggle';
import RowLimitSelect from '../components/RowLimitSelect';
import FilterSidebar, { type FilterSection } from '../components/FilterSidebar';
import { ContextMenuProvider } from '../components/ContextMenu';
import { useProductQuickView } from '../components/ProductQuickView';
import { distributorName, ALL_DISTRIBUTORS } from '../lib/distributors';
import type { Product } from '../lib/api';

export default function Discounts() {
  const [wholesaler, setWholesaler] = useState('');
  const [q, setQ] = useState('');
  const [productType, setProductType] = useState('');
  const [minDiscount, setMinDiscount] = useState('');
  const [limit, setLimit] = useState(100);
  const [trackedOnly, setTrackedOnly] = useState(false);
  const [hasRip, setHasRip] = useState<'' | 'yes' | 'no'>('');
  const { open } = useProductQuickView();

  const { data } = useQuery({
    queryKey: ['discounts', wholesaler, limit, productType, minDiscount],
    queryFn: () => deals.discounts({
      wholesaler: wholesaler || undefined,
      product_type: productType || undefined,
      min_discount_pct: minDiscount ? parseFloat(minDiscount) : undefined,
      limit,
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
    if (hasRip === 'no') result = result.filter(i => !i.has_rip);
    return result;
  }, [data, q, trackedOnly, wl, hasRip]);

  const sections: FilterSection[] = [
    {
      type: 'text', key: 'q', title: 'Search',
      placeholder: 'Product name',
      value: q, onChange: setQ,
    },
    {
      type: 'pills', key: 'wholesaler', title: 'Distributor',
      options: ALL_DISTRIBUTORS,
      value: wholesaler, onChange: setWholesaler,
    },
    {
      type: 'select', key: 'product_type', title: 'Category',
      placeholder: 'All Categories',
      options: (categories ?? []).map(c => ({
        value: c.product_type, label: c.product_type, count: c.count,
      })),
      value: productType, onChange: setProductType,
    },
    {
      type: 'pills', key: 'min_discount', title: 'Min Discount',
      options: [
        { value: '', label: 'Any' },
        { value: '5', label: '5%+' },
        { value: '10', label: '10%+' },
        { value: '15', label: '15%+' },
        { value: '20', label: '20%+' },
        { value: '30', label: '30%+' },
      ],
      value: minDiscount, onChange: setMinDiscount,
    },
    {
      type: 'pills', key: 'has_rip', title: 'Has RIP',
      options: [
        { value: '', label: 'Any' },
        { value: 'yes', label: 'Yes' },
        { value: 'no', label: 'No' },
      ],
      value: hasRip,
      onChange: v => setHasRip(v as '' | 'yes' | 'no'),
    },
    {
      type: 'custom', key: 'tracked', title: 'Watchlist',
      render: () => <TrackedOnlyToggle enabled={trackedOnly} onChange={setTrackedOnly} />,
    },
  ];

  const resetFilters = () => {
    setQ(''); setWholesaler(''); setProductType(''); setMinDiscount(''); setHasRip(''); setTrackedOnly(false);
  };

  return (
    <FilterSidebar storageKey="discounts" sections={sections} onReset={resetFilters}>
      <div className="page">
        <h2>Discount Ranker</h2>

        <div className="rip-filter-bar">
          <RowLimitSelect value={limit} onChange={setLimit} />
          <span className="search-count">{items.length} items</span>
        </div>

        <ContextMenuProvider onView={open}>
          <SortableTable
            columns={[
              { key: 'fav', label: '★', render: (r: Product) => (
                <FavoriteButton productName={r.product_name} wholesaler={r.wholesaler} upc={r.upc} unitVolume={r.unit_volume} />
              )},
              { key: 'product_name', label: 'Product', sortable: true, render: (r: Product) => (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <ProductThumb src={r.image_url} alt={r.product_name} size={64} />
                  <span style={{ fontWeight: 600 }}>{r.product_name}</span>
                </div>
              )},
              { key: 'wholesaler', label: 'Distributor', render: (r) => distributorName(r.wholesaler as string) },
              { key: 'product_type', label: 'Type' },
              { key: 'unit_volume', label: 'Size' },
              { key: 'frontline_case_price', label: 'Frontline', align: 'right',
                render: r => `$${r.frontline_case_price}` },
              { key: 'effective_case_price', label: 'Effective', align: 'right',
                render: r => `$${r.effective_case_price}` },
              { key: 'total_savings_per_case', label: 'Savings/Case', align: 'right', sortable: true,
                render: r => <span className="text-green">${r.total_savings_per_case}</span> },
              { key: 'discount_pct', label: 'Disc %', align: 'right', sortable: true,
                render: r => `${r.discount_pct}%` },
              { key: 'flags', label: 'Flags', render: (r: Product) => (
                <>{r.has_rip && <span className="tag tag-blue">RIP</span>}</>
              ), exportValue: (r: Product) => r.has_rip ? 'RIP' : '' },
            ]}
            data={items}
            exportName="discounts"
            onRowClick={r => open(r.product_name, r.wholesaler)}
          />
        </ContextMenuProvider>
      </div>
    </FilterSidebar>
  );
}
