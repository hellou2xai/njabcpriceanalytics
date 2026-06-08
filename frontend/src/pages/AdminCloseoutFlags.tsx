import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { XCircle } from 'lucide-react';
import { closeout } from '../lib/api';
import { distributorName } from '../lib/distributors';

// Admin-only: review the closeout candidates users flagged on the Compare
// Prices page. Move each through open -> reviewed/actioned/dismissed, or delete.
const num = (v?: number | null) => (Number(v) || 0).toLocaleString();

const STATUS_TAG: Record<string, string> = {
  open: 'tag tag-amber', reviewed: 'tag tag-blue',
  actioned: 'tag tag-green', dismissed: 'tag tag-gray',
};
const FILTERS = ['', 'open', 'reviewed', 'actioned', 'dismissed'];

export default function AdminCloseoutFlags() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState('open');

  const { data, isLoading } = useQuery({
    queryKey: ['admin-closeout', filter],
    queryFn: () => closeout.all(filter || undefined),
  });
  const flags = data?.flags ?? [];
  const counts = data?.counts ?? {};

  const setStatus = async (id: number, status: string) => {
    await closeout.setStatus(id, status);
    qc.invalidateQueries({ queryKey: ['admin-closeout'] });
  };
  const del = async (id: number) => {
    await closeout.adminRemove(id);
    qc.invalidateQueries({ queryKey: ['admin-closeout'] });
  };

  return (
    <div className="page">
      <div className="orders-header">
        <h2><XCircle size={20} style={{ verticalAlign: -3, marginRight: 6 }} />User Closeout Flags</h2>
        <span className="text-muted" style={{ fontSize: 13 }}>
          Products users flagged as closeout candidates on Compare Prices. Review, then mark actioned or dismissed.
        </span>
      </div>

      <div className="ai-usage-cards">
        <div className="ai-usage-card"><span>Open</span><strong>{num(counts.open)}</strong></div>
        <div className="ai-usage-card"><span>Reviewed</span><strong>{num(counts.reviewed)}</strong></div>
        <div className="ai-usage-card"><span>Actioned</span><strong>{num(counts.actioned)}</strong></div>
        <div className="ai-usage-card"><span>Dismissed</span><strong>{num(counts.dismissed)}</strong></div>
      </div>

      <div className="search-bar" style={{ gap: 8, flexWrap: 'wrap' }}>
        {FILTERS.map(f => (
          <button key={f || 'all'}
                  className={`btn btn-sm ${filter === f ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => setFilter(f)}>
            {f ? f[0].toUpperCase() + f.slice(1) : 'All'}
          </button>
        ))}
      </div>

      {isLoading ? <p>Loading…</p> : (
        <div className="table-container">
          <table className="catalog-table">
            <thead>
              <tr>
                <th>Flagged by</th><th>Product</th><th>Distributor</th>
                <th>Size</th><th>UPC</th><th>Note</th><th>Status</th>
                <th>When (UTC)</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {flags.map(f => (
                <tr key={f.id}>
                  <td>{f.user_email ?? `user ${f.user_id}`}</td>
                  <td>{f.product_name}</td>
                  <td>{distributorName(f.wholesaler)}</td>
                  <td>{f.unit_volume ?? '—'}{f.unit_qty ? ` · ${f.unit_qty}pk` : ''}</td>
                  <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{f.upc ?? '—'}</td>
                  <td className="text-muted" style={{ maxWidth: 240 }}>{f.note ?? '—'}</td>
                  <td><span className={STATUS_TAG[f.status] ?? 'tag tag-gray'}>{f.status}</span></td>
                  <td style={{ whiteSpace: 'nowrap', fontSize: 12 }}>{f.created_at}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {f.status !== 'reviewed' && <button className="btn btn-sm btn-secondary" onClick={() => setStatus(f.id, 'reviewed')}>Reviewed</button>}{' '}
                    {f.status !== 'actioned' && <button className="btn btn-sm btn-secondary" onClick={() => setStatus(f.id, 'actioned')}>Actioned</button>}{' '}
                    {f.status !== 'dismissed' && <button className="btn btn-sm btn-secondary" onClick={() => setStatus(f.id, 'dismissed')}>Dismiss</button>}{' '}
                    <button className="btn btn-sm btn-secondary" onClick={() => del(f.id)} title="Delete this flag">✕</button>
                  </td>
                </tr>
              ))}
              {flags.length === 0 && (
                <tr><td colSpan={9} className="empty">No flags{filter ? ` with status “${filter}”` : ''}.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
