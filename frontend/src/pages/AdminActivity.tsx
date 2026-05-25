import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { activity } from '../lib/api';
import { useAuth } from '../contexts/AuthContext';

const RANGES = [7, 30, 90];

function fmtDuration(ms: number | null | undefined): string {
  const s = Math.round((ms ?? 0) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

function fmtDate(d?: string | null): string {
  if (!d) return '-';
  const [date, time] = d.split(/[ T]/);
  return `${date} ${time ? time.slice(0, 5) : ''}`.trim();
}

function UserActivityModal({ id, email, days, onClose }: { id: number; email: string; days: number; onClose: () => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ['activity-user', id, days],
    queryFn: () => activity.adminUserDetail(id, Math.max(days, 90)),
  });
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="Close"><X size={18} /></button>
        <h3 style={{ marginTop: 0 }}>{email}</h3>
        {isLoading || !data ? <p>Loading...</p> : (
          <>
            <p className="text-muted" style={{ marginTop: 0, fontSize: 13 }}>
              {fmtDuration(data.totals.total_ms)} total · {data.totals.pageviews} page views · {data.totals.actions} actions ·
              {' '}first seen {fmtDate(data.totals.first_seen)} · last active {fmtDate(data.totals.last_active)}
            </p>
            <h4>Time per screen</h4>
            <div className="table-container">
              <table>
                <thead><tr><th>Screen</th><th>Path</th><th className="right">Views</th><th className="right">Time</th></tr></thead>
                <tbody>
                  {data.screens.map((s, i) => (
                    <tr key={i}>
                      <td>{s.label || '-'}</td>
                      <td style={{ color: 'var(--text-muted)' }}>{s.path}</td>
                      <td className="right">{s.views}</td>
                      <td className="right">{fmtDuration(s.total_ms)}</td>
                    </tr>
                  ))}
                  {data.screens.length === 0 && <tr><td colSpan={4} className="empty">No page views in range.</td></tr>}
                </tbody>
              </table>
            </div>
            <h4 style={{ marginTop: 18 }}>Recent activity</h4>
            <div className="table-container">
              <table>
                <thead><tr><th>When</th><th>Type</th><th>Screen / action</th><th>Path</th><th className="right">Time</th></tr></thead>
                <tbody>
                  {data.recent.map((r, i) => (
                    <tr key={i}>
                      <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(r.created_at)}</td>
                      <td>{r.event_type}</td>
                      <td>{r.label || '-'}</td>
                      <td style={{ color: 'var(--text-muted)' }}>{r.path || '-'}</td>
                      <td className="right">{r.event_type === 'pageview' ? fmtDuration(r.duration_ms) : ''}</td>
                    </tr>
                  ))}
                  {data.recent.length === 0 && <tr><td colSpan={5} className="empty">No events recorded.</td></tr>}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default function AdminActivity() {
  const { user } = useAuth();
  const isAdmin = !!user?.is_admin;
  const [days, setDays] = useState(30);
  const [openUser, setOpenUser] = useState<{ id: number; email: string } | null>(null);

  const { data: summary, isLoading: sLoading } = useQuery({
    queryKey: ['activity-summary', days], queryFn: () => activity.adminSummary(days), enabled: isAdmin,
  });
  const { data: users, isLoading: uLoading } = useQuery({
    queryKey: ['activity-users', days], queryFn: () => activity.adminUsers(days), enabled: isAdmin,
  });

  if (!isAdmin) {
    return (
      <div className="page">
        <div className="orders-header"><h2>Activity</h2></div>
        <p className="text-muted">You do not have access to this page.</p>
      </div>
    );
  }

  const t = summary?.totals;
  const cards: [string, string][] = [
    ['Active users', (t?.users ?? 0).toLocaleString()],
    ['Sessions', (t?.sessions ?? 0).toLocaleString()],
    ['Page views', (t?.pageviews ?? 0).toLocaleString()],
    ['Total time', fmtDuration(t?.total_ms)],
    ['Actions', (t?.actions ?? 0).toLocaleString()],
  ];

  return (
    <div className="page">
      <div className="orders-header"><h2>Activity analytics</h2></div>
      <p className="text-muted" style={{ marginTop: 0 }}>
        Which screens people use and how long they spend, plus notable actions. Click a user for their detail.
      </p>

      <div className="filter-bar" style={{ marginBottom: 14 }}>
        {RANGES.map(r => (
          <button key={r} type="button" className={`filter-pill ${days === r ? 'active' : ''}`} onClick={() => setDays(r)}>
            Last {r} days
          </button>
        ))}
      </div>

      <div className="rip-summary-cards">
        {cards.map(([label, value]) => (
          <div className="rip-summary-card" key={label}>
            <div className="rip-summary-value">{value}</div>
            <div className="rip-summary-label">{label}</div>
          </div>
        ))}
      </div>

      <h3 style={{ marginTop: 24 }}>Time per screen</h3>
      {sLoading ? <p className="text-muted">Loading...</p> : (
        <div className="table-container">
          <table>
            <thead>
              <tr><th>Screen</th><th>Path</th><th className="right">Views</th><th className="right">Users</th>
                <th className="right">Total time</th><th className="right">Avg / view</th></tr>
            </thead>
            <tbody>
              {(summary?.screens ?? []).map((s, i) => (
                <tr key={i}>
                  <td>{s.label || '-'}</td>
                  <td style={{ color: 'var(--text-muted)' }}>{s.path}</td>
                  <td className="right">{s.views.toLocaleString()}</td>
                  <td className="right">{s.users}</td>
                  <td className="right">{fmtDuration(s.total_ms)}</td>
                  <td className="right">{fmtDuration(s.views > 0 ? s.total_ms / s.views : 0)}</td>
                </tr>
              ))}
              {summary && summary.screens.length === 0 && <tr><td colSpan={6} className="empty">No activity yet in this range.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      <h3 style={{ marginTop: 24 }}>By user</h3>
      {uLoading ? <p className="text-muted">Loading...</p> : (
        <div className="table-container">
          <table>
            <thead>
              <tr><th>User</th><th className="right">Page views</th><th className="right">Actions</th>
                <th className="right">Sessions</th><th className="right">Total time</th><th>Last active</th></tr>
            </thead>
            <tbody>
              {(users ?? []).map((u, i) => (
                <tr key={i}>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {u.user_id != null ? (
                      <button className="login-link-btn" onClick={() => setOpenUser({ id: u.user_id as number, email: u.user_email })}>
                        {u.user_email}
                      </button>
                    ) : <span className="text-muted">{u.user_email}</span>}
                  </td>
                  <td className="right">{u.pageviews.toLocaleString()}</td>
                  <td className="right">{u.actions.toLocaleString()}</td>
                  <td className="right">{u.sessions}</td>
                  <td className="right">{fmtDuration(u.total_ms)}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(u.last_active)}</td>
                </tr>
              ))}
              {users && users.length === 0 && <tr><td colSpan={6} className="empty">No activity yet in this range.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {summary && summary.actions.length > 0 && (
        <>
          <h3 style={{ marginTop: 24 }}>Top actions</h3>
          <div className="table-container" style={{ maxWidth: 520 }}>
            <table>
              <thead><tr><th>Action</th><th className="right">Count</th></tr></thead>
              <tbody>
                {summary.actions.map((a, i) => (
                  <tr key={i}><td>{a.label}</td><td className="right">{a.count.toLocaleString()}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {openUser && <UserActivityModal id={openUser.id} email={openUser.email} days={days} onClose={() => setOpenUser(null)} />}
    </div>
  );
}
