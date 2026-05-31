import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ThumbsUp, ThumbsDown, Trash2 } from 'lucide-react';
import { admin } from '../lib/api';
import { useDialog } from '../components/Dialog';

// Admin-only: every "good"/"bad" rating users have clicked on an AI assistant
// reply, with the user's free-text reason on "bad" so the team can read what
// went wrong and fix the underlying tool / prompt.
function todayISO(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

const num = (v?: number | null) => (Number(v) || 0).toLocaleString();

export default function AdminAiFeedback() {
  const { confirm } = useDialog();
  const [from, setFrom] = useState(todayISO(-29));
  const [to, setTo] = useState(todayISO(0));
  const [rating, setRating] = useState<'' | 'good' | 'bad'>('');
  const [surface, setSurface] = useState<string>('');

  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['admin-ai-feedback', from, to, rating, surface],
    queryFn: () => admin.aiFeedback({
      from_date: from || undefined,
      to_date: to || undefined,
      rating: rating || undefined,
      surface: surface || undefined,
    }),
  });
  const del = useMutation({
    mutationFn: (id: number) => admin.aiFeedbackDelete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-ai-feedback'] }),
  });

  const totals = data?.totals ?? {};
  const perSurface = data?.per_surface ?? [];
  const recent = data?.recent ?? [];
  const good = Number(totals.good ?? 0);
  const bad = Number(totals.bad ?? 0);
  const goodPct = good + bad > 0 ? Math.round((good / (good + bad)) * 100) : null;

  return (
    <div className="page">
      <div className="orders-header">
        <h2>AI Feedback</h2>
        <span className="text-muted" style={{ fontSize: 13 }}>
          Thumbs up / down ratings users left on assistant replies.
        </span>
      </div>

      <div className="search-bar" style={{ gap: 16, flexWrap: 'wrap' }}>
        <label style={{ fontSize: 13 }}>From{' '}
          <input type="date" value={from} max={to} onChange={e => setFrom(e.target.value)} />
        </label>
        <label style={{ fontSize: 13 }}>To{' '}
          <input type="date" value={to} min={from} onChange={e => setTo(e.target.value)} />
        </label>
        <label style={{ fontSize: 13 }}>Rating{' '}
          <select value={rating} onChange={e => setRating(e.target.value as '' | 'good' | 'bad')}>
            <option value="">All</option>
            <option value="good">Good</option>
            <option value="bad">Bad</option>
          </select>
        </label>
        <label style={{ fontSize: 13 }}>Surface{' '}
          <select value={surface} onChange={e => setSurface(e.target.value)}>
            <option value="">All</option>
            {perSurface.map(s => <option key={s.surface} value={s.surface}>{s.surface}</option>)}
          </select>
        </label>
        <div style={{ display: 'flex', gap: 6 }}>
          {[['Today', 0], ['7 days', -6], ['30 days', -29], ['90 days', -89]].map(([label, off]) => (
            <button key={label as string} className="btn btn-sm btn-secondary"
                    onClick={() => { setFrom(todayISO(off as number)); setTo(todayISO(0)); }}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="ai-usage-cards">
        <div className="ai-usage-card"><span>Total ratings</span><strong>{num(totals.total)}</strong></div>
        <div className="ai-usage-card"><span>Good</span><strong style={{ color: 'var(--green, #16a34a)' }}>{num(good)}</strong></div>
        <div className="ai-usage-card"><span>Bad</span><strong style={{ color: 'var(--red, #dc2626)' }}>{num(bad)}</strong></div>
        <div className="ai-usage-card"><span>Satisfaction</span><strong>{goodPct == null ? '—' : `${goodPct}%`}</strong></div>
      </div>

      {isLoading ? <p>Loading...</p> : (
        <>
          <h4>By surface</h4>
          <div className="table-container">
            <table className="catalog-table">
              <thead>
                <tr>
                  <th>Surface</th>
                  <th className="right">Good</th>
                  <th className="right">Bad</th>
                  <th className="right">Total</th>
                  <th className="right">Satisfaction</th>
                </tr>
              </thead>
              <tbody>
                {perSurface.map(r => {
                  const tot = (Number(r.good) || 0) + (Number(r.bad) || 0);
                  const pct = tot > 0 ? Math.round((Number(r.good) / tot) * 100) : null;
                  return (
                    <tr key={r.surface}>
                      <td><span className="tag tag-blue">{r.surface}</span></td>
                      <td className="right">{num(r.good)}</td>
                      <td className="right">{num(r.bad)}</td>
                      <td className="right">{num(r.total)}</td>
                      <td className="right">{pct == null ? '—' : `${pct}%`}</td>
                    </tr>
                  );
                })}
                {perSurface.length === 0 && (
                  <tr><td colSpan={5} className="empty">No ratings in this range.</td></tr>
                )}
              </tbody>
            </table>
          </div>

          <h4 style={{ marginTop: 20 }}>
            Recent ratings <span className="text-muted" style={{ fontSize: 11, fontWeight: 400 }}>(latest 500)</span>
          </h4>
          <div className="table-container">
            <table className="catalog-table">
              <thead>
                <tr>
                  <th>When (UTC)</th>
                  <th>User</th>
                  <th>Surface</th>
                  <th>Rating</th>
                  <th>Question</th>
                  <th>Details (Bad)</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {recent.map(r => (
                  <tr key={r.id}>
                    <td style={{ whiteSpace: 'nowrap' }}>{r.created_at}</td>
                    <td>{r.user_email}</td>
                    <td><span className="tag tag-blue">{r.surface}</span></td>
                    <td>
                      {r.rating === 'good'
                        ? <span style={{ color: 'var(--green, #16a34a)', display: 'inline-flex', alignItems: 'center', gap: 4 }}><ThumbsUp size={13} /> Good</span>
                        : <span style={{ color: 'var(--red, #dc2626)', display: 'inline-flex', alignItems: 'center', gap: 4 }}><ThumbsDown size={13} /> Bad</span>}
                    </td>
                    <td style={{ maxWidth: 280 }} title={r.answer ?? ''}>{r.question ?? <em className="text-muted">(none)</em>}</td>
                    <td style={{ maxWidth: 340, whiteSpace: 'pre-wrap' }}>
                      {r.details ?? (r.rating === 'bad' ? <em className="text-muted">(no comment)</em> : '')}
                    </td>
                    <td>
                      <button className="btn btn-sm btn-secondary" title="Delete this rating"
                              onClick={async () => { if (await confirm({ title: 'Delete this rating?', confirmText: 'Delete', danger: true })) del.mutate(r.id); }}>
                        <Trash2 size={13} />
                      </button>
                    </td>
                  </tr>
                ))}
                {recent.length === 0 && (
                  <tr><td colSpan={7} className="empty">No ratings in this range.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
