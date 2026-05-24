import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { alerts } from '../lib/api';
import { Bell, CheckCheck, RefreshCw } from 'lucide-react';

const PRIORITY_COLORS: Record<string, string> = {
  new_clearance: '#ef4444', target_price_hit: '#f97316', new_discount: '#10b981',
  price_drop: '#22c55e', price_increase: '#f59e0b',
};

export default function AlertsPage() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['alerts'], queryFn: () => alerts.get() });

  const generateMut = useMutation({
    mutationFn: alerts.generate,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['alerts'] }),
  });

  const markAllMut = useMutation({
    mutationFn: () => fetch('/api/alerts/mark-all-read', { method: 'PUT' }).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['alerts'] });
      qc.invalidateQueries({ queryKey: ['unread-alerts'] });
    },
  });

  const markReadMut = useMutation({
    mutationFn: (id: number) => alerts.markRead(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['alerts'] });
      qc.invalidateQueries({ queryKey: ['unread-alerts'] });
    },
  });

  return (
    <div className="page">
      <div className="page-header">
        <h2>Alerts</h2>
        <div className="page-actions">
          <button className="btn" onClick={() => generateMut.mutate()}>
            <RefreshCw size={14} /> Generate
          </button>
          <button className="btn btn-secondary" onClick={() => markAllMut.mutate()}>
            <CheckCheck size={14} /> Mark All Read
          </button>
        </div>
      </div>

      <div className="alert-list">
        {(data ?? []).map(a => (
          <div
            key={a.id}
            className={`alert-item ${a.read ? 'read' : 'unread'}`}
            style={{ borderLeftColor: PRIORITY_COLORS[a.alert_type] ?? '#6b7280' }}
            onClick={() => !a.read && markReadMut.mutate(a.id)}
          >
            <Bell size={16} className="alert-icon" />
            <div className="alert-body">
              <div className="alert-message">{a.message}</div>
              <div className="alert-meta">
                <span className="tag">{a.alert_type.replace('_', ' ')}</span>
                <span>{a.wholesaler}</span>
                <span>{a.edition}</span>
              </div>
            </div>
          </div>
        ))}
        {(data ?? []).length === 0 && <p className="empty">No alerts. Click Generate to scan for new alerts.</p>}
      </div>
    </div>
  );
}
