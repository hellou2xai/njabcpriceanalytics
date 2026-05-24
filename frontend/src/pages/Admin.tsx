import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Trash2, RefreshCw, UserCheck, UserX } from 'lucide-react';
import { admin, feedback } from '../lib/api';
import { useAuth } from '../contexts/AuthContext';

const STAT_CARDS: [string, string][] = [
  ['Users', 'users'],
  ['Feedback', 'feedback'],
  ['Orders', 'orders'],
  ['Order lines', 'order_lines'],
  ['Stores', 'stores'],
  ['Notes', 'user_notes'],
  ['Watchlist', 'watchlist'],
];

function fmtDate(d?: string | null): string {
  if (!d) return '';
  const [date, time] = d.split(/[ T]/);
  return `${date} ${time ? time.slice(0, 5) : ''}`.trim();
}

export default function Admin() {
  const { user } = useAuth();
  const isAdmin = !!user?.is_admin;
  const qc = useQueryClient();
  const [reloadMsg, setReloadMsg] = useState('');

  const { data: stats } = useQuery({ queryKey: ['admin-stats'], queryFn: admin.stats, enabled: isAdmin });
  const { data: users } = useQuery({ queryKey: ['admin-users'], queryFn: admin.users, enabled: isAdmin });
  const { data: fb } = useQuery({ queryKey: ['admin-feedback'], queryFn: feedback.list, enabled: isAdmin });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['admin-users'] });
    qc.invalidateQueries({ queryKey: ['admin-stats'] });
    qc.invalidateQueries({ queryKey: ['admin-feedback'] });
  };

  const activateMut = useMutation({ mutationFn: (id: number) => admin.activateUser(id), onSuccess: invalidate });
  const deactivateMut = useMutation({ mutationFn: (id: number) => admin.deactivateUser(id), onSuccess: invalidate });
  const deleteUserMut = useMutation({ mutationFn: (id: number) => admin.deleteUser(id), onSuccess: invalidate });
  const deleteFbMut = useMutation({ mutationFn: (id: number) => feedback.remove(id), onSuccess: invalidate });
  const reloadMut = useMutation({
    mutationFn: () => admin.reloadPricing(),
    onSuccess: (res) => setReloadMsg(`Pricing cache rebuilt (${(res.counts?.cpl_enriched ?? 0).toLocaleString()} enriched rows).`),
    onError: (e) => setReloadMsg(e instanceof Error ? e.message : 'Reload failed.'),
  });

  if (!isAdmin) {
    return (
      <div className="page">
        <div className="orders-header"><h2>Admin</h2></div>
        <p className="text-muted">You do not have access to this page.</p>
      </div>
    );
  }

  const counts = stats?.counts ?? {};
  const userList = users ?? [];
  const fbList = fb ?? [];

  return (
    <div className="page">
      <div className="orders-header"><h2>Admin</h2></div>
      <p className="text-muted" style={{ marginTop: 0 }}>
        Usage, users, and feedback. Admin access is by email allowlist (ADMIN_EMAILS).
      </p>

      <div className="rip-summary-cards">
        {STAT_CARDS.map(([label, key]) => (
          <div className="rip-summary-card" key={key}>
            <div className="rip-summary-value">{(counts[key] ?? 0).toLocaleString()}</div>
            <div className="rip-summary-label">{label}</div>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 18 }}>
        <button className="btn btn-secondary btn-sm" disabled={reloadMut.isPending}
                onClick={() => { setReloadMsg(''); reloadMut.mutate(); }}>
          <RefreshCw size={14} /> {reloadMut.isPending ? 'Reloading...' : 'Reload pricing cache'}
        </button>
        {reloadMsg && <span className="text-muted" style={{ fontSize: 13 }}>{reloadMsg}</span>}
      </div>

      <h3 style={{ marginTop: 24 }}>Users ({userList.length})</h3>
      <div className="table-container">
        <table>
          <thead>
            <tr>
              <th>Email</th>
              <th>Name</th>
              <th>Status</th>
              <th className="right">Orders</th>
              <th className="right">Stores</th>
              <th>Joined</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {userList.map(u => (
              <tr key={u.id}>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {u.email}{u.is_admin && <span className="tag tag-blue" style={{ marginLeft: 6, fontSize: 10 }}>ADMIN</span>}
                </td>
                <td>{u.full_name ?? '-'}</td>
                <td>
                  {u.activated
                    ? <span className="text-green" style={{ fontWeight: 600 }}>Active</span>
                    : <span style={{ color: 'var(--yellow)', fontWeight: 600 }}>Pending</span>}
                </td>
                <td className="right">{u.orders}</td>
                <td className="right">{u.stores}</td>
                <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(u.created_at)}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {u.activated ? (
                    <button className="btn-icon" title="Deactivate (ends their sessions)"
                            disabled={u.id === user?.id || deactivateMut.isPending}
                            onClick={() => deactivateMut.mutate(u.id)}>
                      <UserX size={15} />
                    </button>
                  ) : (
                    <button className="btn-icon" title="Activate"
                            disabled={activateMut.isPending}
                            onClick={() => activateMut.mutate(u.id)}>
                      <UserCheck size={15} />
                    </button>
                  )}
                  <button className="btn-icon" title={u.is_admin ? 'Admins cannot be deleted here' : 'Delete user and all their data'}
                          disabled={u.id === user?.id || u.is_admin || deleteUserMut.isPending}
                          onClick={() => {
                            if (window.confirm(`Delete ${u.email} and all of their data? This cannot be undone.`)) {
                              deleteUserMut.mutate(u.id);
                            }
                          }}>
                    <Trash2 size={15} />
                  </button>
                </td>
              </tr>
            ))}
            {users && userList.length === 0 && (
              <tr><td colSpan={7} className="empty">No users.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <h3 style={{ marginTop: 24 }}>Feedback ({fbList.length})</h3>
      <div className="table-container">
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Type</th>
              <th>Message</th>
              <th>From</th>
              <th>Page</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {fbList.map(f => (
              <tr key={f.id}>
                <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(f.created_at)}</td>
                <td>{f.kind ?? '-'}</td>
                <td style={{ maxWidth: 460, whiteSpace: 'pre-wrap' }}>{f.message}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {f.user_email ?? (f.user_id ? `user ${f.user_id}` : 'anonymous')}
                </td>
                <td style={{ whiteSpace: 'nowrap' }}>{f.page ?? '-'}</td>
                <td>
                  <button className="btn-icon" title="Delete feedback"
                          disabled={deleteFbMut.isPending}
                          onClick={() => deleteFbMut.mutate(f.id)}>
                    <Trash2 size={15} />
                  </button>
                </td>
              </tr>
            ))}
            {fb && fbList.length === 0 && (
              <tr><td colSpan={6} className="empty">No feedback yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
