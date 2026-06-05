import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Play, ChevronDown, ChevronRight } from 'lucide-react';
import { agents, type AgentRun, type AgentStep } from '../lib/api';

// Admin-only: every procurement-agent run with its full step-by-step trace.
// The ROI framing is deliberate: each run shows what the AI spend bought
// (model cost vs draft value + sourcing savings found).
const money = (v?: number | null, dp = 0) => `$${(Number(v) || 0).toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
const cost = (v?: number | null) => `$${(Number(v) || 0).toFixed(4)}`;
const num = (v?: number | null) => (Number(v) || 0).toLocaleString();
const secs = (ms?: number | null) => `${((Number(ms) || 0) / 1000).toFixed(1)}s`;

const STATUS_TAG: Record<AgentRun['status'], string> = {
  running: 'tag tag-blue', completed: 'tag tag-green',
  failed: 'tag tag-red', aborted: 'tag tag-amber',
};

interface VetoLine { upc: string; name?: string; reason: string; detail?: string }

function StepRow({ s }: { s: AgentStep }) {
  const detail = s.detail ?? {};
  const summary =
    s.kind === 'llm_turn'
      ? `in ${num(s.input_tokens)} · out ${num(s.output_tokens)}` +
        (s.cache_read_tokens ? ` · cache ${num(s.cache_read_tokens)}` : '')
      : s.kind === 'tool_call'
        ? ('result_rows' in detail ? `${num(detail.result_rows as number)} rows` : '')
        : ('kept' in detail ? `kept ${detail.kept} / vetoed ${detail.vetoed}` : '');
  return (
    <tr className={s.status === 'error' ? 'agent-step-error' : undefined}>
      <td className="right text-muted">{s.seq}</td>
      <td><span className={`tag ${s.agent === 'scout' ? 'tag-blue' : s.agent === 'sourcing' ? 'tag-purple' : 'tag-gray'}`}>{s.agent}</span></td>
      <td>{s.name}{s.status === 'error' && <span className="tag tag-red" style={{ marginLeft: 6 }}>error</span>}</td>
      <td className="text-muted">{s.kind.replace('_', ' ')}</td>
      <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{s.model ?? ''}</td>
      <td className="text-muted" style={{ fontSize: 12 }}>{summary}</td>
      <td className="right">{secs(s.duration_ms)}</td>
      <td className="right">{s.kind === 'llm_turn' ? cost(s.cost_usd) : ''}</td>
    </tr>
  );
}

function RunDetail({ runId }: { runId: number }) {
  const { data, isLoading } = useQuery({
    queryKey: ['agent-run', runId],
    queryFn: () => agents.runDetail(runId),
  });
  if (isLoading || !data) return <p style={{ padding: 12 }}>Loading trace…</p>;
  const gate = data.steps.find(s => s.name === 'money_gate');
  const vetoed = ((gate?.detail?.vetoed_lines ?? []) as VetoLine[]);
  return (
    <div style={{ padding: '4px 8px 12px' }}>
      {data.run.summary && <p className="text-muted" style={{ fontSize: 13 }}>{data.run.summary}</p>}
      {data.run.error && <p className="text-red" style={{ fontSize: 13 }}>Error: {data.run.error}</p>}
      <div className="table-container">
        <table className="catalog-table">
          <thead>
            <tr>
              <th className="right">#</th><th>Agent</th><th>Action</th><th>Kind</th>
              <th>Model</th><th>Tokens</th><th className="right">Time</th><th className="right">Cost</th>
            </tr>
          </thead>
          <tbody>{data.steps.map(s => <StepRow key={s.seq} s={s} />)}</tbody>
        </table>
      </div>
      {vetoed.length > 0 && (
        <>
          <h4 style={{ marginTop: 14 }}>Vetoed by the money gate ({vetoed.length})</h4>
          <div className="table-container">
            <table className="catalog-table">
              <thead><tr><th>Product</th><th>Reason</th><th>Detail</th></tr></thead>
              <tbody>
                {vetoed.map((v, i) => (
                  <tr key={i}>
                    <td>{v.name ?? v.upc}</td>
                    <td><span className="tag tag-amber">{v.reason}</span></td>
                    <td className="text-muted" style={{ fontSize: 12 }}>{v.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

export default function AgentProposals() {
  const qc = useQueryClient();
  const [open, setOpen] = useState<number | null>(null);
  const [startErr, setStartErr] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['agent-runs'],
    queryFn: () => agents.runs(25),
    // Poll while any run is in flight so the row flips to completed by itself.
    refetchInterval: q => (q.state.data?.runs ?? []).some(r => r.status === 'running') ? 4000 : false,
  });
  const runs = data?.runs ?? [];
  const running = runs.some(r => r.status === 'running');
  const completed = runs.filter(r => r.status === 'completed');
  const totalCost = completed.reduce((a, r) => a + (r.cost_usd || 0), 0);
  const totalSavings = completed.reduce((a, r) => a + (r.est_savings_usd || 0), 0);

  const startRun = async () => {
    setStartErr('');
    try {
      await agents.startRun();
      qc.invalidateQueries({ queryKey: ['agent-runs'] });
    } catch (e) {
      setStartErr(e instanceof Error ? e.message : 'Failed to start run');
    }
  };

  return (
    <div className="page">
      <div className="orders-header">
        <h2><Bot size={20} style={{ verticalAlign: -3, marginRight: 6 }} />Order Proposals</h2>
        <span className="text-muted" style={{ fontSize: 13 }}>
          Each run: Scout → Sourcing → money gate → draft cart. The agents never send an order.
        </span>
        <button className="btn btn-primary btn-sm" style={{ marginLeft: 'auto' }}
                onClick={startRun} disabled={running}>
          <Play size={14} style={{ verticalAlign: -2, marginRight: 4 }} />
          {running ? 'Run in progress…' : 'Run now'}
        </button>
      </div>
      {startErr && <p className="text-red" style={{ fontSize: 13 }}>{startErr}</p>}

      <div className="ai-usage-cards">
        <div className="ai-usage-card"><span>Runs</span><strong>{num(runs.length)}</strong></div>
        <div className="ai-usage-card"><span>Lines staged (all runs)</span><strong>{num(completed.reduce((a, r) => a + r.lines_kept, 0))}</strong></div>
        <div className="ai-usage-card"><span>Sourcing savings found</span><strong>{money(totalSavings)}</strong></div>
        <div className="ai-usage-card ai-usage-card--cost">
          <span>AI spend → ROI</span>
          <strong>{cost(totalCost)}{totalCost > 0 && totalSavings > 0 ? ` → ${Math.round(totalSavings / totalCost).toLocaleString()}x` : ''}</strong>
        </div>
      </div>

      {isLoading ? <p>Loading…</p> : (
        <div className="table-container">
          <table className="catalog-table">
            <thead>
              <tr>
                <th></th><th>Run</th><th>Month</th><th>Status</th><th>Trigger</th>
                <th className="right">Kept</th><th className="right">Vetoed</th>
                <th className="right">Draft value</th><th className="right">Savings</th>
                <th className="right">Tokens</th><th className="right">AI cost</th>
                <th className="right">Time</th><th>Started (UTC)</th>
              </tr>
            </thead>
            <tbody>
              {runs.map(r => (
                <>
                  <tr key={r.id} style={{ cursor: 'pointer' }}
                      onClick={() => setOpen(open === r.id ? null : r.id)}>
                    <td>{open === r.id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</td>
                    <td>#{r.id}</td>
                    <td>{r.ym}</td>
                    <td><span className={STATUS_TAG[r.status]}>{r.status}</span></td>
                    <td className="text-muted">{r.trigger_source}</td>
                    <td className="right">{num(r.lines_kept)}</td>
                    <td className="right">{num(r.lines_vetoed)}</td>
                    <td className="right">{money(r.est_total_usd)}</td>
                    <td className="right text-green">{money(r.est_savings_usd)}</td>
                    <td className="right">{num(r.input_tokens + r.output_tokens)}</td>
                    <td className="right font-bold">{cost(r.cost_usd)}</td>
                    <td className="right">{secs(r.duration_ms)}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{r.created_at}</td>
                  </tr>
                  {open === r.id && (
                    <tr key={`${r.id}-detail`}>
                      <td colSpan={13} style={{ background: 'var(--bg)' }}>
                        <RunDetail runId={r.id} />
                      </td>
                    </tr>
                  )}
                </>
              ))}
              {runs.length === 0 && (
                <tr><td colSpan={13} className="empty">
                  No runs yet. Press “Run now” to generate this month's draft order.
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-muted" style={{ fontSize: 12, marginTop: 10 }}>
        Staged proposals appear in the <Link to="/cart">Cart</Link> as a labelled
        “Agent proposal” batch and in <Link to="/alerts">Alerts</Link>. Sending
        always stays manual.
      </p>
    </div>
  );
}
