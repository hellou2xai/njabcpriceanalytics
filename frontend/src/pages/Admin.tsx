import { useQuery } from '@tanstack/react-query';
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

  const { data: stats } = useQuery({ queryKey: ['admin-stats'], queryFn: admin.stats, enabled: isAdmin });
  const { data: fb } = useQuery({ queryKey: ['admin-feedback'], queryFn: feedback.list, enabled: isAdmin });

  if (!isAdmin) {
    return (
      <div className="page">
        <div className="orders-header"><h2>Admin</h2></div>
        <p className="text-muted">You do not have access to this page.</p>
      </div>
    );
  }

  const counts = stats?.counts ?? {};
  const items = fb ?? [];

  return (
    <div className="page">
      <div className="orders-header"><h2>Admin</h2></div>
      <p className="text-muted" style={{ marginTop: 0 }}>
        Usage at a glance and every bug or suggestion users have submitted.
      </p>

      <div className="rip-summary-cards">
        {STAT_CARDS.map(([label, key]) => (
          <div className="rip-summary-card" key={key}>
            <div className="rip-summary-value">{(counts[key] ?? 0).toLocaleString()}</div>
            <div className="rip-summary-label">{label}</div>
          </div>
        ))}
      </div>

      <h3 style={{ marginTop: 24 }}>Feedback{fb ? ` (${items.length})` : ''}</h3>
      <div className="table-container">
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Type</th>
              <th>Message</th>
              <th>From</th>
              <th>Page</th>
            </tr>
          </thead>
          <tbody>
            {items.map(f => (
              <tr key={f.id}>
                <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(f.created_at)}</td>
                <td>{f.kind ?? '-'}</td>
                <td style={{ maxWidth: 520, whiteSpace: 'pre-wrap' }}>{f.message}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {f.user_email ?? (f.user_id ? `user ${f.user_id}` : 'anonymous')}
                </td>
                <td style={{ whiteSpace: 'nowrap' }}>{f.page ?? '-'}</td>
              </tr>
            ))}
            {fb && items.length === 0 && (
              <tr><td colSpan={5} className="empty">No feedback yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
