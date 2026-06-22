import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { deals, watchlist, catalog } from '../lib/api';
import SortableTable from '../components/SortableTable';
import FavoriteButton from '../components/FavoriteButton';
import ProductThumb from '../components/ProductThumb';
import NextMonthChip from '../components/NextMonthChip';
import TrackedOnlyToggle from '../components/TrackedOnlyToggle';
import RowLimitSelect from '../components/RowLimitSelect';
import FilterSidebar, { type FilterSection } from '../components/FilterSidebar';
import { ContextMenuProvider } from '../components/ContextMenu';
import { useProductQuickView } from '../components/ProductQuickView';
import { distributorName, ALL_DISTRIBUTORS } from '../lib/distributors';
import type { Product } from '../lib/api';
import { ErrorState, EmptyState } from '../components/DataState';
import DataLoading from '../components/DataLoading';

export default function Clearance() {
  const [wholesaler, setWholesaler] = useState('');
  const [q, setQ] = useState('');
  const [productType, setProductType] = useState('');
  const [limit, setLimit] = useState(100);
  const [trackedOnly, setTrackedOnly] = useState(false);
  const { open } = useProductQuickView();

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['clearance', wholesaler, limit],
    queryFn: () => deals.clearance({ wholesaler: wholesaler || undefined, limit }),
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
    if (productType) {
      result = result.filter(i => i.product_type === productType);
    }
    if (trackedOnly && wl) {
      const tracked = new Set(wl.map(i => `${i.product_name}|${i.wholesaler}`));
      result = result.filter(i => tracked.has(`${i.product_name}|${i.wholesaler}`));
    }
    return result;
  }, [data, q, productType, trackedOnly, wl]);

  const sections: FilterSection[] = [
    {
      type: 'text', key: 'q', title: 'Search',
      placeholder: 'Product name',
      value: q, onChange: setQ,
    },
    {
      type: 'pills', key: 'wholesaler', title: 'Distributor', defaultCollapsed: true,
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
      type: 'custom', key: 'tracked', title: 'Watchlist',
      render: () => <TrackedOnlyToggle enabled={trackedOnly} onChange={setTrackedOnly} />,
    },
  ];

  const resetFilters = () => {
    setQ(''); setWholesaler(''); setProductType(''); setTrackedOnly(false);
  };

  return (
    <FilterSidebar storageKey="clearance" sections={sections} onReset={resetFilters}>
      <div className="page">
        <h2>Clearance / Closeout Items</h2>

        <div className="rip-filter-bar">
          <RowLimitSelect value={limit} onChange={setLimit} />
          <span className="search-count">{items.length} items</span>
        </div>

        {isError ? (
          <ErrorState retry={() => refetch()} />
        ) : isLoading ? (
          <DataLoading label="Loading closeouts…" />
        ) : items.length === 0 ? (
          <EmptyState title="No closeouts match these filters">
            Try broadening or clearing your filters.
          </EmptyState>
        ) : (
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
              { key: 'effective_case_price', label: 'Best Price', align: 'right',
                render: r => `$${r.effective_case_price}` },
              { key: 'next_effective_case_price', label: 'Next mo', align: 'right',
                render: r => <NextMonthChip current={r.effective_case_price as number | null}
                  next={r.next_effective_case_price as number | null} edition={r.edition as string | null} /> },
              { key: 'discount_pct', label: 'Savings %', align: 'right',
                render: r => <span className="text-green">{r.discount_pct}%</span> },
              { key: 'closeout_permit', label: 'Permit' },
            ]}
            data={items}
            exportName="clearance"
            onRowClick={r => open(r.product_name, r.wholesaler)}
          />
        </ContextMenuProvider>
        )}
      </div>
    </FilterSidebar>
  );
}
