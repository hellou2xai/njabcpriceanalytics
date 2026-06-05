import { useQuery } from '@tanstack/react-query';
import { Settings2 } from 'lucide-react';
import { agents } from '../lib/api';

// Admin-only: read-only view of the pipeline configuration. Values change via
// environment variables (listed below) so prod settings live in Render, not
// in a mutable table an agent could touch.
export default function AgentSettings() {
  const { data: cfg, isLoading } = useQuery({ queryKey: ['agent-config'], queryFn: agents.config });

  if (isLoading || !cfg) return <div className="page"><p>Loading…</p></div>;

  const rows: [string, string, string][] = [
    ['Scout model', cfg.scout_model, 'CELR_AGENT_SCOUT_MODEL'],
    ['Sourcing model', cfg.sourcing_model, 'CELR_AGENT_SOURCING_MODEL'],
    ['Minimum GP floor', `${Math.round(cfg.min_gp * 100)}%`, 'CELR_AGENT_MIN_GP'],
    ['Max tokens per run', cfg.max_run_tokens.toLocaleString(), 'CELR_AGENT_MAX_RUN_TOKENS'],
    ['Max tool turns per agent', String(cfg.max_turns), '(code constant)'],
    ['Max scout candidates', String(cfg.max_candidates), '(code constant)'],
    ['Max cases per line', String(cfg.max_cases_per_line), '(code constant)'],
  ];

  return (
    <div className="page agents-page">
      <div className="orders-header">
        <h2><Settings2 size={20} style={{ verticalAlign: -3, marginRight: 6 }} />Agent Settings</h2>
        <span className="text-muted" style={{ fontSize: 13 }}>
          Read-only by design: money rules are enforced in code, and config changes go through env vars + deploy.
        </span>
      </div>

      <h4>Pipeline configuration</h4>
      <div className="table-container">
        <table className="catalog-table">
          <thead><tr><th>Setting</th><th>Value</th><th>Override</th></tr></thead>
          <tbody>
            {rows.map(([k, v, env]) => (
              <tr key={k}>
                <td>{k}</td>
                <td className="font-bold">{v}</td>
                <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }} className="text-muted">{env}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h4 style={{ marginTop: 20 }}>Model pricing (USD per 1M tokens)</h4>
      <div className="table-container">
        <table className="catalog-table">
          <thead><tr><th>Model family</th><th className="right">Input</th><th className="right">Output</th></tr></thead>
          <tbody>
            {Object.entries(cfg.pricing_per_mtok).map(([k, p]) => (
              <tr key={k}>
                <td>{k}</td>
                <td className="right">${p.input.toFixed(2)}</td>
                <td className="right">${p.output.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h4 style={{ marginTop: 20 }}>Guarantees enforced in code (not prompts)</h4>
      <ul className="text-muted" style={{ fontSize: 13, lineHeight: 1.9 }}>
        <li>Agents can never send an order: the pipeline's terminal state is a draft cart batch.</li>
        <li>Every price is re-verified against the catalog before staging; the model's copy is discarded.</li>
        <li>Stocking-deal floor, GP floor, duplicate and quantity caps run as plain code after the agents finish.</li>
        <li>A re-run replaces the month's unsent proposal instead of stacking a new one.</li>
        <li>Hard token budget per run; the run aborts (and journals) if exceeded.</li>
      </ul>

      <h4 style={{ marginTop: 12 }}>Scheduling</h4>
      <p className="text-muted" style={{ fontSize: 13 }}>
        The monthly fan-out hits <code>POST /api/agents/procurement/run-all</code> with the
        <code> X-Cron-Secret</code> header (GitHub Actions workflow <code>monthly-agent-proposals.yml</code>,
        same pattern as the nightly alert refresh). Manual runs: the “Run now” button on Order Proposals.
      </p>
    </div>
  );
}
