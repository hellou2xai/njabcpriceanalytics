import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { analytics, watchlist } from '../lib/api';
import SortableTable from '../components/SortableTable';
import WholesalerFilter from '../components/WholesalerFilter';
import FavoriteButton from '../components/FavoriteButton';
import TrackedOnlyToggle from '../components/TrackedOnlyToggle';
import RowLimitSelect from '../components/RowLimitSelect';
import { ContextMenuProvider } from '../components/ContextMenu';
import { ErrorState, EmptyState } from '../components/DataState';
import DataLoading from '../components/DataLoading';
import { useProductQuickView } from '../components/ProductQuickView';
import { distributorName } from '../lib/distributors';
import { useChartTheme } from '../hooks/useChartTheme';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

type Tab = 'movers-down' | 'movers-up' | 'new-items' | 'new-discounts' | 'lost-discounts' | 'cross-source' | 'category-trends';

const VALID_TABS: Tab[] = ['movers-down', 'movers-up', 'new-items', 'new-discounts', 'lost-discounts', 'cross-source', 'category-trends'];

export default function AnalyticsPage() {
  const [params] = useSearchParams();
  const initialTab = VALID_TABS.includes(params.get('tab') as Tab) ? (params.get('tab') as Tab) : 'movers-down';
  const [wholesaler, setWholesaler] = useState('');
  const [tab, setTab] = useState<Tab>(initialTab);

  const tabs: { key: Tab; label: string }[] = [
    { key: 'movers-down', label: 'Price Drops' },
    { key: 'movers-up', label: 'Price Increases' },
    { key: 'new-items', label: 'New Items' },
    { key: 'new-discounts', label: 'New Discounts' },
    { key: 'lost-discounts', label: 'Lost Discounts' },
    { key: 'cross-source', label: 'Cross-Source' },
    { key: 'category-trends', label: 'Category Trends' },
  ];

  return (
    <div className="page">
      <h2>Analytics</h2>
      <WholesalerFilter value={wholesaler} onChange={setWholesaler} />
      <div className="tab-bar">
        {tabs.map(t => (
          <button key={t.key} className={`tab ${tab === t.key ? 'active' : ''}`} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>
      {(tab === 'movers-down' || tab === 'movers-up') && <MoversTab wholesaler={wholesaler} direction={tab === 'movers-down' ? 'down' : 'up'} />}
      {tab === 'new-items' && <LifecycleTab wholesaler={wholesaler} eventType="new_item" />}
      {tab === 'new-discounts' && <LifecycleTab wholesaler={wholesaler} eventType="new_discount" />}
      {tab === 'lost-discounts' && <LifecycleTab wholesaler={wholesaler} eventType="lost_discount" />}
      {tab === 'cross-source' && <CrossSourceTab />}
      {tab === 'category-trends' && <CategoryTrendsTab wholesaler={wholesaler} />}
    </div>
  );
}

function MoversTab({ wholesaler, direction }: { wholesaler: string; direction: string }) {
  const [limit, setLimit] = useState(50);
  const [trackedOnly, setTrackedOnly] = useState(false);
  const { open } = useProductQuickView();

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['movers', wholesaler, direction, limit],
    queryFn: () => analytics.priceMovers({ wholesaler: wholesaler || undefined, direction, limit }),
  });

  const { data: wl } = useQuery({ queryKey: ['watchlist'], queryFn: watchlist.get, enabled: trackedOnly });

  let items = data ?? [];
  if (trackedOnly && wl) {
    const tracked = new Set(wl.map(i => `${i.product_name}|${i.wholesaler}`));
    items = items.filter(i => tracked.has(`${i.product_name}|${i.wholesaler}`));
  }

  return (
    <>
      <div className="toolbar">
        <TrackedOnlyToggle enabled={trackedOnly} onChange={setTrackedOnly} />
        <RowLimitSelect value={limit} onChange={setLimit} />
      </div>
      {isError ? <ErrorState retry={() => refetch()} /> : isLoading ? <DataLoading /> : items.length === 0 ? (
        <EmptyState title="No products match these filters">Try broadening or clearing your filters.</EmptyState>
      ) : (
      <ContextMenuProvider onView={open}>
        <SortableTable
          columns={[
            { key: 'fav', label: '★', render: r => (
              <FavoriteButton productName={r.product_name} wholesaler={r.wholesaler} unitVolume={r.unit_volume} />
            )},
            { key: 'product_name', label: 'Product' },
            { key: 'vintage', label: 'Vintage', align: 'center', sortable: true,
              render: r => r.vintage ? String(r.vintage) : '—' },
            { key: 'wholesaler', label: 'Distributor', render: (r) => distributorName(r.wholesaler as string) },
            { key: 'prev_case_price', label: 'Previous', align: 'right', render: r => `$${r.prev_case_price}` },
            { key: 'case_price', label: 'Current', align: 'right', render: r => `$${r.case_price}` },
            { key: 'case_delta_pct', label: 'Change %', align: 'right', sortable: true,
              render: r => <span className={r.case_delta_pct < 0 ? 'text-green' : 'text-red'}>{r.case_delta_pct}%</span> },
          ]}
          data={items}
          exportName="price-movers"
          onRowClick={r => open(r.product_name, r.wholesaler)}
        />
      </ContextMenuProvider>
      )}
    </>
  );
}

function LifecycleTab({ wholesaler, eventType }: { wholesaler: string; eventType: string }) {
  const [limit, setLimit] = useState(100);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['lifecycle', wholesaler, eventType, limit],
    queryFn: () => analytics.lifecycle({ wholesaler: wholesaler || undefined, event_type: eventType, limit }),
  });

  return (
    <>
      <div className="toolbar">
        <RowLimitSelect value={limit} onChange={setLimit} />
      </div>
      {isError ? <ErrorState retry={() => refetch()} /> : isLoading ? <DataLoading /> : (data?.length ?? 0) === 0 ? (
        <EmptyState title="No products match these filters">Try broadening or clearing your filters.</EmptyState>
      ) : (
      <SortableTable
        columns={[
          { key: 'product_name', label: 'Product' },
          { key: 'wholesaler', label: 'Distributor', render: (r) => distributorName(r.wholesaler as string) },
          { key: 'edition', label: 'Edition' },
          { key: 'product_type', label: 'Type' },
          { key: 'event_type', label: 'Event' },
        ]}
        data={data ?? []}
        exportName="lifecycle"
      />
      )}
    </>
  );
}

function CrossSourceTab() {
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(50);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['cross-source', q, limit],
    queryFn: () => analytics.crossSource({ product_name: q || undefined, limit }),
  });

  return (
    <>
      <input type="text" placeholder="Search product..." value={q} onChange={e => setQ(e.target.value)} className="search-input" />
      <div className="toolbar">
        <RowLimitSelect value={limit} onChange={setLimit} />
      </div>
      {isError ? <ErrorState retry={() => refetch()} /> : isLoading ? <DataLoading /> : (data?.length ?? 0) === 0 ? (
        <EmptyState title="No products match these filters">Try broadening or clearing your filters.</EmptyState>
      ) : (
      <SortableTable
        columns={[
          { key: 'product_name_a', label: 'Product A' },
          { key: 'wholesaler_a', label: 'Source A' },
          { key: 'case_price_a', label: 'Price A', align: 'right', render: r => `$${r.case_price_a}` },
          { key: 'product_name_b', label: 'Product B' },
          { key: 'wholesaler_b', label: 'Source B' },
          { key: 'case_price_b', label: 'Price B', align: 'right', render: r => `$${r.case_price_b}` },
          { key: 'price_delta', label: 'Delta', align: 'right',
            render: r => <span className={r.price_delta < 0 ? 'text-green' : r.price_delta > 0 ? 'text-red' : ''}>${r.price_delta}</span> },
          { key: 'name_similarity', label: 'Match', align: 'right', render: r => `${(r.name_similarity * 100).toFixed(0)}%`,
            exportValue: r => Math.round(r.name_similarity * 100) },
        ]}
        data={data ?? []}
        exportName="cross-source"
      />
      )}
    </>
  );
}

function CategoryTrendsTab({ wholesaler }: { wholesaler: string }) {
  const ct = useChartTheme();

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['category-trends', wholesaler],
    queryFn: () => analytics.categoryTrends({ wholesaler: wholesaler || undefined }),
  });

  const latest = data?.filter(d => d.edition === data[data.length - 1]?.edition) ?? [];

  return (
    <>
      {isError ? <ErrorState retry={() => refetch()} /> : isLoading ? <DataLoading /> : (data?.length ?? 0) === 0 ? (
        <EmptyState title="No category trends yet">Try clearing the distributor filter, or check back after the next edition loads.</EmptyState>
      ) : (<>
      <ResponsiveContainer width="100%" height={300}>
        <BarChart data={latest} margin={{ top: 5, right: 20, bottom: 5, left: 10 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={ct.grid} />
          <XAxis dataKey="product_type" stroke={ct.axis} fontSize={11} />
          <YAxis stroke={ct.axis} fontSize={12} tickFormatter={v => `${v}%`} />
          <Tooltip contentStyle={{ background: ct.tooltipBg, border: `1px solid ${ct.tooltipBorder}`, borderRadius: 8 }} />
          <Bar dataKey="avg_change_pct" fill="#3b82f6" name="Avg Change %" />
        </BarChart>
      </ResponsiveContainer>
      <SortableTable
        columns={[
          { key: 'product_type', label: 'Category' },
          { key: 'edition', label: 'Edition' },
          { key: 'items', label: 'Items', align: 'right' },
          { key: 'avg_change_pct', label: 'Avg Change %', align: 'right',
            render: r => <span className={r.avg_change_pct < 0 ? 'text-green' : 'text-red'}>{r.avg_change_pct}%</span> },
          { key: 'increases', label: 'Up', align: 'right' },
          { key: 'decreases', label: 'Down', align: 'right' },
        ]}
        data={data ?? []}
        exportName="category-trends"
      />
      </>)}
    </>
  );
}
