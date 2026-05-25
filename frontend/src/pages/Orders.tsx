import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { orders, salesReps } from '../lib/api';
import type { Order } from '../lib/api';
import SortableTable from '../components/SortableTable';
import OrderLinesView from './OrderLinesView';
import { distributorName, DISTRIBUTOR_NAMES } from '../lib/distributors';

const STATUS_FILTERS = [
  { value: '', label: 'All' },
  { value: 'draft', label: 'In Progress' },
  { value: 'submitted', label: 'Submitted' },
  { value: 'archived', label: 'Archived' },
] as const;

const DISTRIBUTORS = Object.keys(DISTRIBUTOR_NAMES);

export default function OrdersPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [name, setName] = useState('');
  const [distributor, setDistributor] = useState('');
  const [repId, setRepId] = useState('');
  const [createErr, setCreateErr] = useState('');
  const [view, setView] = useState<'list' | 'lines'>('list');
  const status = params.get('status') ?? '';

  const { data } = useQuery({
    queryKey: ['orders', status],
    queryFn: () => orders.list(status || undefined),
  });
  const { data: reps } = useQuery({ queryKey: ['sales-reps'], queryFn: salesReps.list });
  const repsForDist = (reps ?? []).filter(r => !distributor || r.distributor === distributor);
  const repName = (id?: number | null) => reps?.find(r => r.id === id)?.name ?? '—';

  const createMut = useMutation({
    mutationFn: () => orders.create({
      name: name.trim() || `${distributorName(distributor)} order`,
      distributor,
      sales_rep_id: repId ? Number(repId) : null,
    }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['orders'] });
      // Navigates whether the order was just created or already existed
      // (one open order per distributor + rep).
      navigate(`/orders/${res.id}`);
    },
  });

  const setStatus = (value: string) => {
    if (value) setParams({ status: value });
    else setParams({});
  };

  const active = STATUS_FILTERS.find(f => f.value === status) ?? STATUS_FILTERS[0];

  return (
    <div className="page">
      <div className="orders-header">
        <h2>Orders</h2>
        <div className="inline-form" style={{ marginBottom: 0 }}>
          <input type="text" placeholder="Order name (optional)" value={name} onChange={e => setName(e.target.value)} />
          <select value={distributor} onChange={e => { setDistributor(e.target.value); setRepId(''); }}>
            <option value="">Distributor *</option>
            {DISTRIBUTORS.map(d => <option key={d} value={d}>{distributorName(d)}</option>)}
          </select>
          <select value={repId} onChange={e => setRepId(e.target.value)} disabled={!distributor} title={!distributor ? 'Pick a distributor first' : undefined}>
            <option value="">Sales rep (optional)</option>
            {repsForDist.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
          <button className="btn" disabled={createMut.isPending}
                  onClick={() => {
                    if (!distributor) { setCreateErr('Please select a distributor first.'); return; }
                    setCreateErr('');
                    createMut.mutate();
                  }}>
            {createMut.isPending ? 'Creating...' : 'Create Order'}
          </button>
        </div>
      </div>
      <p className="page-sub" style={{ marginTop: -6 }}>
        One open order per distributor and sales rep. Pick a distributor (sales rep is optional), then Create Order.
        Creating for a pair you already have open opens that order.
      </p>
      {createErr && <p className="login-error" style={{ marginTop: 0 }}>{createErr}</p>}
      {createMut.isError && (
        <p className="login-error" style={{ marginTop: 0 }}>
          {createMut.error instanceof Error ? createMut.error.message : 'Could not create the order.'}
        </p>
      )}

      <div className="tab-bar">
        <button type="button" className={`tab ${view === 'list' ? 'active' : ''}`} onClick={() => setView('list')}>Orders</button>
        <button type="button" className={`tab ${view === 'lines' ? 'active' : ''}`} onClick={() => setView('lines')}>All Order Lines</button>
      </div>

      <div className="filter-bar">
        {STATUS_FILTERS.map(f => (
          <button
            key={f.value || 'all'}
            type="button"
            className={`filter-pill ${status === f.value ? 'active' : ''}`}
            onClick={() => setStatus(f.value)}
          >
            {f.label}
          </button>
        ))}
        <span style={{ color: 'var(--text-muted)', fontSize: 12, marginLeft: 'auto' }}>
          {(data ?? []).length} {active.label.toLowerCase()} order{(data ?? []).length !== 1 ? 's' : ''}
        </span>
      </div>

      {view === 'lines' ? (
        <OrderLinesView status={status} />
      ) : (
      <>
      <div
        style={{
          display: 'flex', alignItems: 'center', gap: 9, maxWidth: 740,
          background: '#fef9c3', color: '#1f2937',
          border: '1px solid #fde047', borderLeft: '4px solid #f59e0b',
          borderRadius: 10, padding: '11px 16px', margin: '0 0 16px',
          boxShadow: '0 3px 8px rgba(0,0,0,0.14)', transform: 'rotate(-0.5deg)',
          fontSize: 13.5, fontWeight: 600, lineHeight: 1.35,
        }}
      >
        <span style={{ fontSize: 20, lineHeight: 1 }}>💡</span>
        <span>Click any order below to open it and see all its line items: the products, quantities, RIP savings, and totals.</span>
      </div>
      <SortableTable
        columns={[
          { key: 'id', label: 'ID', sortable: true },
          { key: 'name', label: 'Name', sortable: true },
          { key: 'distributor', label: 'Distributor', sortable: true,
            render: r => r.distributor ? distributorName(r.distributor as string) : '—' },
          { key: 'sales_rep_id', label: 'Sales Rep',
            render: r => repName(r.sales_rep_id as number | null) },
          { key: 'total', label: 'Total', sortable: true, align: 'right',
            render: r => r.total != null
              ? <span className="num" style={{ fontWeight: 600 }}>${(r.total as number).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
              : '—' },
          { key: 'status', label: 'Status', sortable: true, render: r => (
            <span className={`tag tag-${r.status === 'draft' ? 'blue' : r.status === 'submitted' ? 'green' : 'gray'}`}>
              {r.status === 'draft' ? 'in progress' : r.status as string}
            </span>
          )},
          { key: 'created_at', label: 'Created', sortable: true },
          { key: 'updated_at', label: 'Updated', sortable: true },
        ]}
        data={data ?? []}
        exportName="orders"
        onRowClick={(row: Order) => navigate(`/orders/${row.id}`)}
      />
      </>
      )}
    </div>
  );
}
