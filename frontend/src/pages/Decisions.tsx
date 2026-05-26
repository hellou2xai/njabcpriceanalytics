import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { intelligence } from '../lib/api';
import SortableTable from '../components/SortableTable';
import WholesalerFilter from '../components/WholesalerFilter';
import KPICard from '../components/KPICard';
import FavoriteButton from '../components/FavoriteButton';
import ProductThumb from '../components/ProductThumb';
import RowLimitSelect from '../components/RowLimitSelect';
import { ContextMenuProvider } from '../components/ContextMenu';
import { useProductQuickView } from '../components/ProductQuickView';
import { distributorName } from '../lib/distributors';
import type { BuySignal, Product } from '../lib/api';

const SIGNAL_COLORS: Record<string, string> = {
  LAST_CHANCE: '#ef4444', STRONG_BUY: '#22c55e', BUY_NOW: '#10b981',
  GOOD_BUY: '#3b82f6', HOLD: '#6b7280', DEFER: '#f97316',
};

export default function Decisions() {
  const [wholesaler, setWholesaler] = useState('');
  const [tab, setTab] = useState<'buysheet' | 'missed'>('buysheet');

  return (
    <div className="page">
      <h2>Decision Intelligence</h2>
      <WholesalerFilter value={wholesaler} onChange={setWholesaler} />
      <div className="tab-bar">
        <button className={`tab ${tab === 'buysheet' ? 'active' : ''}`} onClick={() => setTab('buysheet')}>Buy Sheet</button>
        <button className={`tab ${tab === 'missed' ? 'active' : ''}`} onClick={() => setTab('missed')}>Missed Opportunities</button>
      </div>
      {tab === 'buysheet' && <BuySheetTab wholesaler={wholesaler} />}
      {tab === 'missed' && <MissedTab wholesaler={wholesaler} />}
    </div>
  );
}

function BuySheetTab({ wholesaler }: { wholesaler: string }) {
  const { open } = useProductQuickView();
  const { data } = useQuery({
    queryKey: ['buy-sheet', wholesaler],
    queryFn: () => intelligence.buySheet({ wholesaler: wholesaler || undefined }),
  });

  if (!data) return <p>Loading...</p>;

  const ms = data.market_summary;

  return (
    <>
      <div className="kpi-grid">
        <KPICard label="Market Direction" value={ms.direction.toUpperCase()}
                 color={ms.direction === 'falling' ? '#22c55e' : ms.direction === 'rising' ? '#ef4444' : '#6b7280'} />
        <KPICard label="Price Drops" value={ms.price_drops} color="#22c55e" />
        <KPICard label="Price Increases" value={ms.price_increases} color="#ef4444" />
        <KPICard label="Savings Pool" value={`$${ms.total_savings_pool.toLocaleString()}`} color="#3b82f6" />
      </div>

      <ContextMenuProvider onView={open}>
        {Object.entries(data.sections).map(([signal, items]) => (
          <div key={signal} className="panel" style={{ borderLeftColor: SIGNAL_COLORS[signal] ?? '#333', marginBottom: 12 }}>
            <h3>
              <span className="signal-badge" style={{ background: SIGNAL_COLORS[signal] }}>{signal.replace('_', ' ')}</span>
              <span className="signal-count">{items.length} items</span>
            </h3>
            <SortableTable
              columns={[
                { key: 'fav', label: '★', render: (r: BuySignal) => (
                  <FavoriteButton productName={r.product_name} wholesaler={r.wholesaler} unitVolume={r.unit_volume} />
                )},
                { key: 'product_name', label: 'Product', render: (r: BuySignal) => (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <ProductThumb src={r.image_url} alt={r.product_name} size={64} />
                    <span style={{ fontWeight: 600 }}>{r.product_name}</span>
                  </div>
                )},
                { key: 'wholesaler', label: 'Distributor', render: (r) => distributorName(r.wholesaler as string) },
                { key: 'frontline_case_price', label: 'Price', align: 'right',
                  render: r => `$${r.frontline_case_price}` },
                { key: 'total_savings_per_case', label: 'Savings', align: 'right',
                  render: r => r.total_savings_per_case > 0 ? <span className="text-green">${r.total_savings_per_case}</span> : '—' },
                { key: 'reason', label: 'Reason' },
              ]}
              data={items.slice(0, 20)}
              exportName="buy-signals"
              onRowClick={r => open(r.product_name, r.wholesaler)}
            />
          </div>
        ))}
      </ContextMenuProvider>
    </>
  );
}

function MissedTab({ wholesaler }: { wholesaler: string }) {
  const [limit, setLimit] = useState(50);
  const { open } = useProductQuickView();
  const { data } = useQuery({
    queryKey: ['missed', wholesaler],
    queryFn: () => intelligence.missedOpportunities({ wholesaler: wholesaler || undefined }),
  });

  if (!data) return <p>Loading...</p>;

  return (
    <>
      <div className="kpi-grid">
        <KPICard label="Opportunities" value={data.total_opportunities} color="#f59e0b" />
        <KPICard label="Savings Missed" value={`$${data.total_savings_missed.toLocaleString()}`} color="#ef4444" />
        <KPICard label="Clearance Items" value={data.clearance_count} color="#ef4444" />
      </div>
      <div className="toolbar">
        <RowLimitSelect value={limit} onChange={setLimit} />
      </div>
      <ContextMenuProvider onView={open}>
        <SortableTable
          columns={[
            { key: 'fav', label: '★', render: (r: Product) => (
              <FavoriteButton productName={r.product_name} wholesaler={r.wholesaler} unitVolume={r.unit_volume} />
            )},
            { key: 'product_name', label: 'Product', render: (r: Product) => (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <ProductThumb src={r.image_url} alt={r.product_name} size={64} />
                <span style={{ fontWeight: 600 }}>{r.product_name}</span>
              </div>
            )},
            { key: 'wholesaler', label: 'Distributor', render: (r) => distributorName(r.wholesaler as string) },
            { key: 'product_type', label: 'Type' },
            { key: 'frontline_case_price', label: 'Price', align: 'right', render: r => `$${r.frontline_case_price}` },
            { key: 'total_savings_per_case', label: 'Potential Savings', align: 'right', sortable: true,
              render: r => <span className="text-green">${r.total_savings_per_case}</span> },
            { key: 'flags', label: 'Type', render: r => (
              <>
                {r.has_discount && <span className="tag tag-green">DISC</span>}
                {r.has_rip && <span className="tag tag-blue">RIP</span>}
                {r.has_closeout && <span className="tag tag-red">CLOSE</span>}
              </>
            ), exportValue: r => [r.has_discount && 'DISC', r.has_rip && 'RIP', r.has_closeout && 'CLOSE'].filter(Boolean).join(' ') },
          ]}
          data={data.items.slice(0, limit)}
          exportName="missed-opportunities"
          onRowClick={r => open(r.product_name, r.wholesaler)}
        />
      </ContextMenuProvider>
    </>
  );
}
