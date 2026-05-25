import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Trash2, RefreshCw, UserCheck, UserX, X } from 'lucide-react';
import { admin, feedback, settings } from '../lib/api';
import { setShareContentCache } from '../lib/share';
import { useAuth } from '../contexts/AuthContext';

const fieldStyle: React.CSSProperties = {
  padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 'var(--radius)',
  background: 'var(--surface)', color: 'var(--text)', fontFamily: 'var(--font-sans)', fontSize: 14,
};

// Admin editor for the WhatsApp share copy (stored server-side; used by every
// "Share via WhatsApp" button).
function ShareMessageEditor() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['share-message'], queryFn: settings.getShareMessage });
  const [message, setMessage] = useState('');
  const [url, setUrl] = useState('');
  const [saved, setSaved] = useState('');
  useEffect(() => { if (data) { setMessage(data.message); setUrl(data.url); } }, [data]);
  const save = useMutation({
    mutationFn: () => settings.updateShareMessage({ message, url }),
    onSuccess: (res) => {
      setShareContentCache(res);
      setSaved('Saved. New shares will use this copy.');
      qc.invalidateQueries({ queryKey: ['share-message'] });
    },
    onError: (e) => setSaved(e instanceof Error ? e.message : 'Save failed.'),
  });
  return (
    <div style={{ marginTop: 28 }}>
      <h3 style={{ marginBottom: 4 }}>WhatsApp share message</h3>
      <p className="text-muted" style={{ marginTop: 0, fontSize: 13 }}>
        Prefilled when anyone taps “Share via WhatsApp”. The link below is appended automatically.
      </p>
      <textarea value={message} onChange={e => { setMessage(e.target.value); setSaved(''); }}
        rows={7} style={{ ...fieldStyle, width: '100%', maxWidth: 560, display: 'block', resize: 'vertical' }} />
      <label style={{ display: 'block', maxWidth: 560, marginTop: 10 }}>
        <span className="text-muted" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>Link</span>
        <input type="text" value={url} onChange={e => { setUrl(e.target.value); setSaved(''); }}
          style={{ ...fieldStyle, width: '100%' }} />
      </label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12 }}>
        <button className="btn btn-sm" disabled={save.isPending || !message.trim()}
          onClick={() => { setSaved(''); save.mutate(); }}>
          {save.isPending ? 'Saving...' : 'Save share message'}
        </button>
        {saved && <span className="text-muted" style={{ fontSize: 13 }}>{saved}</span>}
      </div>
    </div>
  );
}

// [label, counts-key, drill-down: 'scroll:<id>' | 'detail:<entity>']
const STAT_CARDS: [string, string, string][] = [
  ['Users', 'users', 'scroll:admin-users'],
  ['Feedback', 'feedback', 'scroll:admin-feedback'],
  ['Orders', 'orders', 'detail:orders'],
  ['Order lines', 'order_lines', 'detail:order_lines'],
  ['Stores', 'stores', 'detail:stores'],
  ['Notes', 'user_notes', 'detail:user_notes'],
  ['Watchlist', 'watchlist', 'detail:watchlist'],
];

function fmtDate(d?: unknown): string {
  if (typeof d !== 'string' || !d) return '';
  const [date, time] = d.split(/[ T]/);
  return `${date} ${time ? time.slice(0, 5) : ''}`.trim();
}

function cell(v: unknown): string {
  if (v == null) return '-';
  return String(v);
}

function GenericTable({ rows }: { rows: Record<string, unknown>[] }) {
  if (!rows || rows.length === 0) return <p className="text-muted">Nothing here yet.</p>;
  const cols = Object.keys(rows[0]);
  return (
    <div className="table-container">
      <table>
        <thead><tr>{cols.map(c => <th key={c}>{c}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {cols.map(c => (
                <td key={c} style={{ maxWidth: 360, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {c.endsWith('created_at') || c.endsWith('updated_at') ? fmtDate(r[c]) : cell(r[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DetailModal({ entity, label, onClose }: { entity: string; label: string; onClose: () => void }) {
  const { data, isLoading } = useQuery({ queryKey: ['admin-detail', entity], queryFn: () => admin.detail(entity) });
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="Close"><X size={18} /></button>
        <h3 style={{ marginTop: 0 }}>{label} ({data?.length ?? 0})</h3>
        {isLoading ? <p>Loading...</p> : <GenericTable rows={data ?? []} />}
      </div>
    </div>
  );
}

function UserDetailModal({ id, onClose }: { id: number; onClose: () => void }) {
  const { data, isLoading } = useQuery({ queryKey: ['admin-user', id], queryFn: () => admin.userDetail(id) });
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="Close"><X size={18} /></button>
        {isLoading || !data ? <p>Loading...</p> : (
          <>
            <h3 style={{ marginTop: 0 }}>
              {data.user.email}
              {data.user.is_admin && <span className="tag tag-blue" style={{ marginLeft: 6, fontSize: 10 }}>ADMIN</span>}
            </h3>
            <p className="text-muted" style={{ marginTop: 0 }}>
              {(data.user.full_name as string) || 'No name'} · {data.user.activated ? 'Active' : 'Pending'} ·
              joined {fmtDate(data.user.created_at as string)}
            </p>
            <h4>Orders ({data.orders.length})</h4>
            <GenericTable rows={data.orders} />
            <h4>Stores ({data.stores.length})</h4>
            <GenericTable rows={data.stores} />
            <h4>Notes ({data.notes.length})</h4>
            <GenericTable rows={data.notes} />
            <h4>Watchlist ({data.watchlist.length})</h4>
            <GenericTable rows={data.watchlist} />
            <h4>Feedback ({data.feedback.length})</h4>
            <GenericTable rows={data.feedback} />
          </>
        )}
      </div>
    </div>
  );
}

export default function Admin() {
  const { user } = useAuth();
  const isAdmin = !!user?.is_admin;
  const qc = useQueryClient();
  const [reloadMsg, setReloadMsg] = useState('');
  const [detail, setDetail] = useState<{ entity: string; label: string } | null>(null);
  const [detailUser, setDetailUser] = useState<number | null>(null);

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

  const onCardClick = (key: string, label: string, drill: string) => {
    const [kind, target] = drill.split(':');
    if (kind === 'scroll') document.getElementById(target)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    else setDetail({ entity: target, label });
  };

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
        Usage, users, and feedback. Click a card or a user to drill in.
      </p>

      <div className="rip-summary-cards">
        {STAT_CARDS.map(([label, key, drill]) => (
          <button className="rip-summary-card admin-card" key={key} type="button"
                  onClick={() => onCardClick(key, label, drill)}>
            <div className="rip-summary-value">{(counts[key] ?? 0).toLocaleString()}</div>
            <div className="rip-summary-label">{label}</div>
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 18 }}>
        <button className="btn btn-secondary btn-sm" disabled={reloadMut.isPending}
                onClick={() => { setReloadMsg(''); reloadMut.mutate(); }}>
          <RefreshCw size={14} /> {reloadMut.isPending ? 'Reloading...' : 'Reload pricing cache'}
        </button>
        {reloadMsg && <span className="text-muted" style={{ fontSize: 13 }}>{reloadMsg}</span>}
      </div>

      <ShareMessageEditor />

      <h3 id="admin-users" style={{ marginTop: 24 }}>Users ({userList.length})</h3>
      <div className="table-container">
        <table>
          <thead>
            <tr>
              <th>Email</th><th>Name</th><th>Status</th>
              <th className="right">Orders</th><th className="right">Stores</th><th>Joined</th><th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {userList.map(u => (
              <tr key={u.id}>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <button className="login-link-btn" onClick={() => setDetailUser(u.id)}>{u.email}</button>
                  {u.is_admin && <span className="tag tag-blue" style={{ marginLeft: 6, fontSize: 10 }}>ADMIN</span>}
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
            {users && userList.length === 0 && <tr><td colSpan={7} className="empty">No users.</td></tr>}
          </tbody>
        </table>
      </div>

      <h3 id="admin-feedback" style={{ marginTop: 24 }}>Feedback ({fbList.length})</h3>
      <div className="table-container">
        <table>
          <thead>
            <tr><th>When</th><th>Type</th><th>Message</th><th>From</th><th>Page</th><th></th></tr>
          </thead>
          <tbody>
            {fbList.map(f => (
              <tr key={f.id}>
                <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(f.created_at)}</td>
                <td>{f.kind ?? '-'}</td>
                <td style={{ maxWidth: 460, whiteSpace: 'pre-wrap' }}>{f.message}</td>
                <td style={{ whiteSpace: 'nowrap' }}>{f.user_email ?? (f.user_id ? `user ${f.user_id}` : 'anonymous')}</td>
                <td style={{ whiteSpace: 'nowrap' }}>{f.page ?? '-'}</td>
                <td>
                  <button className="btn-icon" title="Delete feedback" disabled={deleteFbMut.isPending}
                          onClick={() => deleteFbMut.mutate(f.id)}>
                    <Trash2 size={15} />
                  </button>
                </td>
              </tr>
            ))}
            {fb && fbList.length === 0 && <tr><td colSpan={6} className="empty">No feedback yet.</td></tr>}
          </tbody>
        </table>
      </div>

      {detail && <DetailModal entity={detail.entity} label={detail.label} onClose={() => setDetail(null)} />}
      {detailUser != null && <UserDetailModal id={detailUser} onClose={() => setDetailUser(null)} />}
    </div>
  );
}
