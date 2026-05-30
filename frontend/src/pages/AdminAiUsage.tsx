import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { admin } from '../lib/api';

// Admin-only: track every AI assistant question, labelled by user, with token
// consumption and USD cost, totalled over a date range.
const money = (v?: number | null) => `$${(Number(v) || 0).toFixed(4)}`;
const num = (v?: number | null) => (Number(v) || 0).toLocaleString();

function todayISO(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

export default function AdminAiUsage() {
  const [from, setFrom] = useState(todayISO(-29)); // last 30 days by default
  const [to, setTo] = useState(todayISO(0));

  const { data, isLoading } = useQuery({
    queryKey: ['admin-ai-usage', from, to],
    queryFn: () => admin.aiUsage({ from_date: from || undefined, to_date: to || undefined }),
  });

  const totals = data?.totals ?? {};
  const perUser = data?.per_user ?? [];
  const recent = data?.recent ?? [];

  return (
    <div className="page">
      <div className="orders-header">
        <h2>AI Usage</h2>
        <span className="text-muted" style={{ fontSize: 13 }}>
          Every assistant question, by user — tokens &amp; cost.
        </span>
      </div>

      <div className="search-bar" style={{ gap: 16, flexWrap: 'wrap' }}>
        <label style={{ fontSize: 13 }}>From{' '}
          <input type="date" value={from} max={to} onChange={e => setFrom(e.target.value)} />
        </label>
        <label style={{ fontSize: 13 }}>To{' '}
          <input type="date" value={to} min={from} onChange={e => setTo(e.target.value)} />
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

      {/* Totals across the selected range. */}
      <div className="ai-usage-cards">
        <div className="ai-usage-card"><span>Questions</span><strong>{num(totals.questions)}</strong></div>
        <div className="ai-usage-card"><span>Total tokens</span><strong>{num(totals.total_tokens)}</strong></div>
        <div className="ai-usage-card"><span>Input / Output</span><strong>{num(totals.input_tokens)} / {num(totals.output_tokens)}</strong></div>
        <div className="ai-usage-card ai-usage-card--cost"><span>Total cost</span><strong>{money(totals.cost_usd)}</strong></div>
      </div>

      {isLoading ? <p>Loading…</p> : (
        <>
          <h4>By user</h4>
          <div className="table-container">
            <table className="catalog-table">
              <thead>
                <tr>
                  <th>User</th>
                  <th className="right">Questions</th>
                  <th className="right">Input tok</th>
                  <th className="right">Output tok</th>
                  <th className="right">Total tok</th>
                  <th className="right">Cost</th>
                </tr>
              </thead>
              <tbody>
                {perUser.map(r => (
                  <tr key={r.user_email}>
                    <td>{r.user_email}</td>
                    <td className="right">{num(r.questions)}</td>
                    <td className="right">{num(r.input_tokens)}</td>
                    <td className="right">{num(r.output_tokens)}</td>
                    <td className="right">{num(r.total_tokens)}</td>
                    <td className="right text-green font-bold">{money(r.cost_usd)}</td>
                  </tr>
                ))}
                {perUser.length === 0 && (
                  <tr><td colSpan={6} className="empty">No AI usage in this range.</td></tr>
                )}
              </tbody>
            </table>
          </div>

          <h4 style={{ marginTop: 20 }}>Recent questions <span className="text-muted" style={{ fontSize: 11, fontWeight: 400 }}>(latest 200)</span></h4>
          <div className="table-container">
            <table className="catalog-table">
              <thead>
                <tr>
                  <th>When (UTC)</th>
                  <th>User</th>
                  <th>Surface</th>
                  <th>Question</th>
                  <th className="right">Tokens (in/out)</th>
                  <th className="right">Cost</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((r, i) => (
                  <tr key={i}>
                    <td style={{ whiteSpace: 'nowrap' }}>{r.created_at}</td>
                    <td>{r.user_email}</td>
                    <td><span className="tag tag-blue">{r.surface}</span></td>
                    <td style={{ maxWidth: 360 }}>{r.question}</td>
                    <td className="right">{num(r.input_tokens)} / {num(r.output_tokens)}</td>
                    <td className="right">{money(r.cost_usd)}</td>
                  </tr>
                ))}
                {recent.length === 0 && (
                  <tr><td colSpan={6} className="empty">No questions in this range.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
