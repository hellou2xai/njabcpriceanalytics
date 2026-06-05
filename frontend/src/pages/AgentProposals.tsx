import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bot, Play, ChevronDown, ChevronRight, Search, GitCompareArrows,
  ShieldCheck, ShoppingCart, Bell, ArrowRight, ClipboardCheck,
} from 'lucide-react';
import { agents, type AgentRun, type AgentStep, type AgentProposalLine } from '../lib/api';

// Admin-only: every procurement-agent run with its full step-by-step trace.
// The ROI framing is deliberate: each run shows what the AI spend bought
// (model cost vs draft value + sourcing savings found).
const money = (v?: number | null, dp = 0) => `$${(Number(v) || 0).toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
const cost = (v?: number | null) => `$${(Number(v) || 0).toFixed(4)}`;
const num = (v?: number | null) => (Number(v) || 0).toLocaleString();
const secs = (ms?: number | null) => `${((Number(ms) || 0) / 1000).toFixed(1)}s`;

const STATUS_TAG: Record<AgentRun['status'], string> = {
  running: 'tag tag-blue', paused: 'tag tag-amber', completed: 'tag tag-green',
  failed: 'tag tag-red', aborted: 'tag tag-amber',
};

// Stepwise mode: what has finished -> which agent runs next.
const NEXT_AGENT: Record<string, string> = {
  scout: 'Sourcing Planner', sourcing: 'Money Gate', gate: 'Build proposal',
};

const CONF_TAG: Record<string, string> = { high: 'tag tag-green', medium: 'tag tag-blue', low: 'tag tag-gray' };

// The four stages of a stepwise run, in order, for the progress stepper.
// 'staged' is the legacy name for the old terminal stage; treat as proposed.
const STAGE_FLOW: { key: string; label: string }[] = [
  { key: 'scout', label: 'Deal Scout' },
  { key: 'sourcing', label: 'Sourcing Planner' },
  { key: 'gate', label: 'Money Gate' },
  { key: 'proposed', label: 'Proposal (your review)' },
];

/** Stepwise progress: which agents have run, which one is live or next.
 *  `stage` is the last FINISHED stage (null = none yet). */
function StageStepper({ stage, running }: { stage: string | null; running: boolean }) {
  const doneIdx = stage ? STAGE_FLOW.findIndex(s => s.key === stage) : -1;
  return (
    <div className="agent-flow" style={{ margin: '8px 0' }}>
      {STAGE_FLOW.map((s, i) => {
        const done = i <= doneIdx;
        const isLive = running && i === doneIdx + 1;
        const isNext = !running && i === doneIdx + 1;
        return (
          <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {i > 0 && <ArrowRight size={14} className="text-muted" />}
            <div className="agent-flow-chip"
                 style={{ opacity: done || isLive || isNext ? 1 : 0.45 }}>
              {done ? <span className="text-green">✓</span>
                : isLive ? <span className="agent-live-dot" /> : null}
              <span>{s.label}</span>
              {isNext && <span className="tag tag-amber">next - waiting for you</span>}
              {isLive && <span className="tag tag-blue">running</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function parseJson<T>(s?: string | null): T | null {
  if (!s) return null;
  try { return JSON.parse(s) as T; } catch { return null; }
}

interface ScoutCandidate {
  upc: string; product_name: string; wholesaler: string; reason_code: string;
  rationale: string; suggested_cases: number; confidence: string;
}
interface PlanLine {
  upc: string; product_name: string; chosen_wholesaler: string; cases: number;
  effective_case_price: number; alt_wholesaler: string | null;
  alt_effective_price: number | null; savings_vs_alt: number | null;
  rip_code: string | null; sourcing_note: string; gp_pct?: number | null;
}

/** Plain-language data panel for one stage's output, so a buyer (not just a
 *  developer) can analyze what each agent produced. */
function StagePanel({ title, blurb, children }: {
  title: string; blurb: string; children: ReactNode;
}) {
  const [openPanel, setOpenPanel] = useState(true);
  return (
    <div className="agent-group">
      <div className="agent-group-head" style={{ cursor: 'pointer' }}
           onClick={() => setOpenPanel(o => !o)}>
        {openPanel ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <strong>{title}</strong>
        <span className="text-muted" style={{ fontSize: 12 }}>{blurb}</span>
      </div>
      {openPanel && children}
    </div>
  );
}

function ScoutOutput({ report }: { report: { candidates: ScoutCandidate[]; skipped_note?: string } }) {
  return (
    <StagePanel title="Scout output: the candidate list"
                blurb="What the Deal Scout thinks the store should buy this month, and why.">
      <div className="table-container">
        <table className="catalog-table">
          <thead><tr>
            <th>Product</th><th>From</th><th>Why now</th>
            <th className="right">Cases</th><th>Confidence</th><th>Scout's reasoning</th>
          </tr></thead>
          <tbody>
            {report.candidates.map((c, i) => (
              <tr key={`${c.upc}-${i}`}>
                <td>{c.product_name}</td>
                <td>{c.wholesaler}</td>
                <td><span className="tag tag-blue">{c.reason_code.replace(/_/g, ' ')}</span></td>
                <td className="right">{c.suggested_cases}</td>
                <td><span className={CONF_TAG[c.confidence] ?? 'tag tag-gray'}>{c.confidence}</span></td>
                <td className="text-muted" style={{ fontSize: 12, maxWidth: 420 }}>{c.rationale}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {report.skipped_note && (
        <p className="text-muted" style={{ fontSize: 12, marginTop: 6 }}>
          <strong>What it left out:</strong> {report.skipped_note}
        </p>
      )}
    </StagePanel>
  );
}

function PlanOutput({ plan }: { plan: { lines: PlanLine[]; summary?: string } }) {
  return (
    <StagePanel title="Sourcing output: the buying plan"
                blurb="Which distributor to buy each line from, and what the alternative would have cost.">
      {plan.summary && <p className="text-muted" style={{ fontSize: 12, margin: '2px 0 8px' }}>{plan.summary}</p>}
      <div className="table-container">
        <table className="catalog-table">
          <thead><tr>
            <th>Product</th><th>Buy from</th><th className="right">Cases</th>
            <th className="right">$/case</th><th>Best alternative</th>
            <th className="right">Saved vs alt</th><th>Planner's note</th>
          </tr></thead>
          <tbody>
            {plan.lines.map((l, i) => (
              <tr key={`${l.upc}-${i}`}>
                <td>{l.product_name}</td>
                <td className="font-bold">{l.chosen_wholesaler}</td>
                <td className="right">{l.cases}</td>
                <td className="right">{money(l.effective_case_price, 2)}</td>
                <td className="text-muted">
                  {l.alt_wholesaler ? `${l.alt_wholesaler} @ ${money(l.alt_effective_price, 2)}` : 'only source'}
                </td>
                <td className={`right ${((l.savings_vs_alt ?? 0) >= 0) ? 'text-green' : 'text-red'}`}>
                  {l.savings_vs_alt == null ? '—' : money(l.savings_vs_alt, 2)}
                </td>
                <td className="text-muted" style={{ fontSize: 12, maxWidth: 360 }}>{l.sourcing_note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </StagePanel>
  );
}

function GateOutput({ gated }: { gated: { kept: PlanLine[]; vetoed: (PlanLine & VetoLine)[] } }) {
  return (
    <StagePanel title="Gate output: what survived the money rules"
                blurb="Verified prices, margins, and the lines headed for the draft cart.">
      <div className="table-container">
        <table className="catalog-table">
          <thead><tr>
            <th>Product</th><th>Buy from</th><th className="right">Cases</th>
            <th className="right">$/case (verified)</th><th className="right">Est. margin</th>
          </tr></thead>
          <tbody>
            {gated.kept.map((l, i) => (
              <tr key={`${l.upc}-${i}`}>
                <td>{l.product_name}</td>
                <td>{l.chosen_wholesaler}</td>
                <td className="right">{l.cases}</td>
                <td className="right">{money(l.effective_case_price, 2)}</td>
                <td className="right">{l.gp_pct != null ? `${Math.round(l.gp_pct * 100)}%` : 'n/a'}</td>
              </tr>
            ))}
            {gated.kept.length === 0 && <tr><td colSpan={5} className="empty">Nothing survived the gate.</td></tr>}
          </tbody>
        </table>
      </div>
    </StagePanel>
  );
}

interface VetoLine { upc: string; name?: string; reason: string; detail?: string }

// Per-agent identity used by the pipeline strip and the per-agent sections.
const AGENT_META: Record<string, { label: string; role: string; icon: typeof Search; tag: string }> = {
  scout:    { label: 'Deal Scout',       role: 'finds what the store should buy', icon: Search,           tag: 'tag-blue' },
  sourcing: { label: 'Sourcing Planner', role: 'picks the distributor per line',  icon: GitCompareArrows, tag: 'tag-purple' },
  gate:     { label: 'Money Gate',       role: 'code-only price & margin vetoes', icon: ShieldCheck,      tag: 'tag-amber' },
  proposal: { label: 'Proposal Builder', role: 'explains every line for review',  icon: ClipboardCheck,   tag: 'tag-green' },
  cart:     { label: 'Cart Stager',      role: 'stages lines YOU approved',       icon: ShoppingCart,     tag: 'tag-green' },
  notify:   { label: 'Notifier',         role: 'posts the alert digest',          icon: Bell,             tag: 'tag-gray' },
};
const meta = (agent: string) =>
  AGENT_META[agent] ?? { label: agent, role: '', icon: Bot, tag: 'tag-gray' };

/** Steps grouped per agent, preserving pipeline order. */
function groupByAgent(steps: AgentStep[]) {
  const groups: { agent: string; steps: AgentStep[] }[] = [];
  for (const s of steps) {
    const last = groups[groups.length - 1];
    if (last && last.agent === s.agent) last.steps.push(s);
    else groups.push({ agent: s.agent, steps: [s] });
  }
  return groups;
}

function stepSummary(s: AgentStep): string {
  const detail = s.detail ?? {};
  if (s.kind === 'llm_turn')
    return `in ${num(s.input_tokens)} · out ${num(s.output_tokens)}` +
      (s.cache_read_tokens ? ` · cache ${num(s.cache_read_tokens)}` : '');
  if (s.kind === 'tool_call')
    return 'result_rows' in detail ? `${num(detail.result_rows as number)} rows`
      : 'error' in detail ? String(detail.error).slice(0, 80) : '';
  if ('kept' in detail) return `kept ${detail.kept} / vetoed ${detail.vetoed}`;
  if ('batch_id' in detail) return `${num(detail.lines as number)} lines → batch ${String(detail.batch_id).slice(0, 8)}…`;
  if ('with_source' in detail) return `${num(detail.candidates as number)} candidates, ${num(detail.with_source as number)} sourceable`;
  return '';
}

const AGENT_DOT: Record<string, string> = {
  scout: '#2563eb', sourcing: '#7c3aed', gate: '#f59e0b',
  proposal: '#0d9488', cart: '#10b981', notify: '#6b7280',
};

function AgentSection({ agent, steps, vetoed, selectedSeq, onSelect }: {
  agent: string; steps: AgentStep[]; vetoed: VetoLine[];
  selectedSeq: number | null; onSelect: (seq: number) => void;
}) {
  const m = meta(agent);
  const Icon = m.icon;
  const llm = steps.filter(s => s.kind === 'llm_turn');
  const agentCost = llm.reduce((a, s) => a + (s.cost_usd || 0), 0);
  const agentMs = steps.reduce((a, s) => a + (s.duration_ms || 0), 0);
  const model = llm.find(s => s.model)?.model;
  const hasError = steps.some(s => s.status === 'error');
  return (
    <div className="agent-group">
      <div className="agent-group-head">
        <Icon size={16} />
        <strong>{m.label}</strong>
        <span className="text-muted" style={{ fontSize: 12 }}>{m.role}</span>
        {model && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }} className="text-muted">{model}</span>}
        {hasError && <span className="tag tag-red">error</span>}
        <span className="agent-group-stats">
          {steps.length} action{steps.length !== 1 ? 's' : ''} · {secs(agentMs)}
          {llm.length > 0 && <> · <strong>{cost(agentCost)}</strong></>}
          {llm.length === 0 && <> · <strong className="text-green">$0 (code)</strong></>}
        </span>
      </div>
      <div className="table-container">
        <table className="catalog-table">
          <thead>
            <tr>
              <th className="right" style={{ width: 36 }}>#</th><th>Action</th><th>Kind</th>
              <th>What happened</th><th className="right">Time</th><th className="right">Cost</th>
            </tr>
          </thead>
          <tbody>
            {steps.map(s => (
              <tr key={s.seq} id={`agent-step-${s.seq}`}
                  className={s.status === 'error' ? 'agent-step-error' : undefined}
                  onClick={() => onSelect(s.seq)}
                  style={{ cursor: 'pointer',
                           background: selectedSeq === s.seq ? 'rgba(37,99,235,0.08)' : undefined }}>
                <td className="right text-muted">{s.seq}</td>
                <td>{s.name}{s.status === 'error' && <span className="tag tag-red" style={{ marginLeft: 6 }}>error</span>}</td>
                <td className="text-muted">{s.kind.replace('_', ' ')}</td>
                <td className="text-muted" style={{ fontSize: 12 }}>{stepSummary(s)}</td>
                <td className="right">{secs(s.duration_ms)}</td>
                <td className="right">{s.kind === 'llm_turn' ? cost(s.cost_usd) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {agent === 'gate' && vetoed.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div className="text-muted" style={{ fontSize: 12, margin: '4px 0' }}>
            Lines vetoed by this agent ({vetoed.length}):
          </div>
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
        </div>
      )}
    </div>
  );
}

const VERDICT_TAG: Record<string, [string, string]> = {
  buy_now: ['tag tag-green', 'BUY NOW'], wait: ['tag tag-amber', 'WAIT'],
  neutral: ['tag tag-gray', 'STABLE'], no_forecast: ['tag tag-gray', 'NO FORECAST'],
};

/** The review-and-approve surface: every proposed line with its full
 *  step-by-step decision trail. THIS is where lines enter the cart - by a
 *  human pressing the button, never by an agent. */
function ProposalReview({ runId, lines, ym }: {
  runId: number; lines: AgentProposalLine[]; ym: string;
}) {
  const qc = useQueryClient();
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [openLine, setOpenLine] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  const unstaged = lines.filter(l => !l.staged);
  const stagedCount = lines.length - unstaged.length;
  const total = (ls: AgentProposalLine[]) =>
    ls.reduce((a, l) => a + l.effective_case_price * l.cases, 0);

  const toggle = (upc: string) => setChecked(s => {
    const n = new Set(s);
    if (n.has(upc)) n.delete(upc); else n.add(upc);
    return n;
  });

  const add = async (upcs?: string[]) => {
    setMsg('');
    try {
      const r = await agents.addToCart(runId, upcs);
      setMsg(`Added ${r.lines} line(s) to the cart (${r.remaining} left to review).`);
      setChecked(new Set());
      qc.invalidateQueries({ queryKey: ['agent-run', runId] });
      qc.invalidateQueries({ queryKey: ['agent-runs'] });
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Failed to add to cart');
    }
  };

  return (
    <div className="agent-group" style={{ borderLeft: '3px solid var(--accent)' }}>
      <div className="agent-group-head">
        <ClipboardCheck size={16} />
        <strong>Order Proposal · {ym}</strong>
        <span className="text-muted" style={{ fontSize: 12 }}>
          {lines.length} lines, ~{money(total(lines))}. Click a product for its full
          step-by-step reasoning. Nothing reaches the cart until you add it.
        </span>
        <span className="agent-group-stats">
          {stagedCount > 0 && <span className="tag tag-green" style={{ marginRight: 8 }}>{stagedCount} in cart</span>}
          <button className="btn btn-sm btn-secondary" disabled={checked.size === 0}
                  onClick={() => add([...checked])}>
            <ShoppingCart size={13} style={{ verticalAlign: -2, marginRight: 4 }} />
            Add selected ({checked.size})
          </button>{' '}
          <button className="btn btn-sm btn-primary" disabled={unstaged.length === 0}
                  onClick={() => add()}>
            <ShoppingCart size={13} style={{ verticalAlign: -2, marginRight: 4 }} />
            Add all remaining ({unstaged.length})
          </button>
        </span>
      </div>
      {msg && <p style={{ fontSize: 12 }} className={msg.startsWith('Added') ? 'text-green' : 'text-red'}>
        {msg} {msg.startsWith('Added') && <Link to="/cart">Open cart →</Link>}
      </p>}
      <div className="table-container">
        <table className="catalog-table">
          <thead><tr>
            <th style={{ width: 30 }}></th>
            <th>Product</th><th>Buy</th><th className="right">$/case</th>
            <th className="right">Margin</th><th>Why</th><th>Rebate</th><th>Timing</th>
            <th style={{ width: 90 }}></th>
          </tr></thead>
          <tbody>
            {lines.map((l, i) => {
              const key = `${l.upc}-${i}`;
              const expanded = openLine === key;
              const v = l.timing ? VERDICT_TAG[l.timing.verdict] : null;
              return (
                <>
                  <tr key={key} style={{ cursor: 'pointer', opacity: l.staged ? 0.6 : 1 }}
                      onClick={() => setOpenLine(expanded ? null : key)}>
                    <td onClick={e => e.stopPropagation()}>
                      {l.staged
                        ? <span className="tag tag-green">✓</span>
                        : <input type="checkbox" checked={checked.has(l.upc)}
                                 onChange={() => toggle(l.upc)} />}
                    </td>
                    <td>
                      {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}{' '}
                      {l.product_name}
                      {l.pos?.days_of_cover != null && l.pos.days_of_cover <= 14 && (
                        <span className="tag tag-red" style={{ marginLeft: 6 }}>
                          {l.pos.days_of_cover}d stock
                        </span>
                      )}
                    </td>
                    <td>{l.cases} cs · {l.chosen_wholesaler}</td>
                    <td className="right">{money(l.effective_case_price, 2)}</td>
                    <td className="right">{l.gp_pct != null ? `${Math.round(l.gp_pct * 100)}%` : '–'}</td>
                    <td><span className="tag tag-blue">{(l.reason_code ?? 'opportunity').replace(/_/g, ' ')}</span></td>
                    <td style={{ fontSize: 12 }}>
                      {l.rip?.earned_rebate
                        ? <span className="text-green">${l.rip.earned_rebate.toLocaleString()} back</span>
                        : l.rip ? 'tier below' : '–'}
                    </td>
                    <td>{v && <span className={v[0]}>{v[1]}</span>}</td>
                    <td className="text-muted" style={{ fontSize: 11 }}>
                      {expanded ? 'hide detail' : 'why? ▸'}
                    </td>
                  </tr>
                  {expanded && (
                    <tr key={`${key}-detail`}>
                      <td colSpan={9} style={{ background: 'var(--bg)' }}>
                        <div style={{ padding: '8px 10px' }}>
                          {(l.explain_steps ?? []).map(s => (
                            <p key={s.title} style={{ fontSize: 13, margin: '6px 0' }}>
                              <strong>{s.title}.</strong>{' '}
                              <span className="text-muted">{s.text}</span>
                            </p>
                          ))}
                          {l.rip?.next_tier && (
                            <p style={{ fontSize: 12, margin: '6px 0' }} className="text-muted">
                              Tier ladder tip: {l.rip.note}
                            </p>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              );
            })}
            {lines.length === 0 && <tr><td colSpan={9} className="empty">Proposal is empty.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RunDetail({ runId }: { runId: number }) {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<number | null>(null);
  const [stepErr, setStepErr] = useState('');
  const { data, isLoading } = useQuery({
    queryKey: ['agent-run', runId],
    queryFn: () => agents.runDetail(runId),
    // LIVE MODE: while the run is in flight, poll the trace so the sidebar
    // streams actions as the journal writes them. Stops itself on completion.
    refetchInterval: q => q.state.data?.run.status === 'running' ? 2000 : false,
  });
  if (isLoading || !data) return <p style={{ padding: 12 }}>Loading trace…</p>;
  const live = data.run.status === 'running';
  const paused = data.run.status === 'paused';
  const nextAgent = paused && data.run.stage ? NEXT_AGENT[data.run.stage] : null;
  // Per-stage artifacts: the analyzable data each agent produced.
  const scoutReport = parseJson<{ candidates: ScoutCandidate[]; skipped_note?: string }>(data.run.scout_json);
  const plan = parseJson<{ lines: PlanLine[]; summary?: string }>(data.run.plan_json);
  const gated = parseJson<{ kept: PlanLine[]; vetoed: (PlanLine & VetoLine)[] }>(data.run.gated_json);
  const proposal = parseJson<{ lines: AgentProposalLine[] }>(data.run.proposal_json);

  const advance = async () => {
    setStepErr('');
    try {
      await agents.advanceStep(runId);
      qc.invalidateQueries({ queryKey: ['agent-run', runId] });
      qc.invalidateQueries({ queryKey: ['agent-runs'] });
    } catch (e) {
      setStepErr(e instanceof Error ? e.message : 'Failed to advance');
    }
  };
  const gate = data.steps.find(s => s.name === 'money_gate');
  const vetoed = ((gate?.detail?.vetoed_lines ?? []) as VetoLine[]);
  const groups = groupByAgent(data.steps);
  // With nothing manually selected, follow the newest action (live tail).
  const shownSeq = selected ?? (data.steps.length ? data.steps[data.steps.length - 1].seq : null);
  const shownStep = data.steps.find(s => s.seq === shownSeq) ?? null;

  const select = (seq: number) => {
    setSelected(seq);
    document.getElementById(`agent-step-${seq}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };

  return (
    <div style={{ padding: '4px 8px 12px' }}>
      {live && (
        <p style={{ fontSize: 13, margin: '6px 0' }}>
          <span className="agent-live-dot" /> <strong>
            {data.run.mode === 'manual' ? 'Running ONE agent' : 'Run in progress'}
          </strong>
          <span className="text-muted">
            {data.run.mode === 'manual'
              ? ' — this stage will finish and PAUSE for your review. Nothing else runs without your say-so.'
              : ' — actions appear below as each agent finishes them.'}
          </span>
        </p>
      )}
      {data.run.mode === 'manual' && (
        <StageStepper stage={data.run.stage === 'staged' ? 'proposed' : data.run.stage} running={live} />
      )}

      {/* THE review surface: the explained proposal, with add-to-cart under
          the user's control. Shown above the trace because approving lines is
          the job; the trace below is the audit trail. */}
      {proposal && proposal.lines.length > 0 && (
        <ProposalReview runId={runId} lines={proposal.lines} ym={data.run.ym} />
      )}
      {data.run.summary && !live && <p className="text-muted" style={{ fontSize: 13 }}>{data.run.summary}</p>}
      {data.run.error && <p className="text-red" style={{ fontSize: 13 }}>Error: {data.run.error}</p>}

      {/* Stepwise mode: the run is paused between agents, waiting for a human. */}
      {paused && nextAgent && (
        <div className="agent-step-detail" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span className="tag tag-amber">paused</span>
          <span style={{ fontSize: 13 }}>
            <strong>{meta(data.run.stage === 'scout' ? 'scout' : data.run.stage === 'sourcing' ? 'sourcing' : 'gate').label}</strong>
            {' '}finished and STOPPED. Nothing else runs until you press the button.
            Review its output below first.
          </span>
          <button className="btn btn-primary btn-sm" style={{ marginLeft: 'auto' }} onClick={advance}>
            <Play size={13} style={{ verticalAlign: -2, marginRight: 4 }} />
            Run next: {nextAgent}
          </button>
          {stepErr && <span className="text-red" style={{ fontSize: 12 }}>{stepErr}</span>}
        </div>
      )}

      <div className="agent-trace-layout">
        {/* Sidebar: EVERY action, chronological, streaming while live. */}
        <div className="agent-trace-sidebar">
          <h5>{live ? 'Actions (live)' : 'All actions'} · {data.steps.length}</h5>
          {data.steps.map(s => (
            <button key={s.seq}
                    className={`agent-trace-item ${shownSeq === s.seq ? 'active' : ''}`}
                    onClick={() => select(s.seq)}>
              <span className="dot" style={{ background: AGENT_DOT[s.agent] ?? '#6b7280' }} />
              <span className="seq">{s.seq}</span>
              <span className="nm">{s.name}</span>
              <span className="ms">{s.status === 'error' ? '✕' : secs(s.duration_ms)}</span>
            </button>
          ))}
          {live && (
            <div className="agent-trace-item" style={{ cursor: 'default' }}>
              <span className="agent-live-dot" />
              <span className="nm text-muted">
                {data.run.current_action ?? (data.steps.length === 0 ? 'starting up…' : 'agents working…')}
              </span>
            </div>
          )}
          {!live && data.steps.length === 0 && (
            <div className="text-muted" style={{ fontSize: 12, padding: 6 }}>No actions recorded.</div>
          )}
        </div>

        {/* Main pane: pipeline strip, selected-action detail, per-agent sections. */}
        <div>
          <div className="agent-flow">
            {groups.map((g, i) => {
              const m = meta(g.agent);
              const Icon = m.icon;
              const llmCost = g.steps.reduce((a, s) => a + (s.cost_usd || 0), 0);
              const ms = g.steps.reduce((a, s) => a + (s.duration_ms || 0), 0);
              const err = g.steps.some(s => s.status === 'error');
              return (
                <div key={`${g.agent}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {i > 0 && <ArrowRight size={14} className="text-muted" />}
                  <div className={`agent-flow-chip ${err ? 'agent-flow-chip--error' : ''}`}>
                    <Icon size={13} />
                    <span>{m.label}</span>
                    <span className="text-muted">{secs(ms)}{llmCost > 0 ? ` · ${cost(llmCost)}` : ''}</span>
                  </div>
                </div>
              );
            })}
            {live && groups.length < 5 && (
              <span className="text-muted" style={{ fontSize: 12 }}>… more to come</span>
            )}
          </div>

          {/* Full journalled payload of the highlighted action. */}
          {shownStep && (
            <div className="agent-step-detail">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span className="dot" style={{ width: 8, height: 8, borderRadius: '50%', display: 'inline-block', background: AGENT_DOT[shownStep.agent] ?? '#6b7280' }} />
                <strong>#{shownStep.seq} · {meta(shownStep.agent).label} · {shownStep.name}</strong>
                <span className="text-muted" style={{ fontSize: 12 }}>
                  {shownStep.kind.replace('_', ' ')}
                  {shownStep.model ? ` · ${shownStep.model}` : ''} · {secs(shownStep.duration_ms)}
                  {shownStep.kind === 'llm_turn' ? ` · ${cost(shownStep.cost_usd)}` : ''}
                </span>
              </div>
              {shownStep.kind === 'llm_turn' && (
                <div className="text-muted" style={{ fontSize: 12, marginTop: 4 }}>
                  tokens: {num(shownStep.input_tokens)} in / {num(shownStep.output_tokens)} out
                  {shownStep.cache_read_tokens ? ` · ${num(shownStep.cache_read_tokens)} cached` : ''}
                  {shownStep.cache_write_tokens ? ` · ${num(shownStep.cache_write_tokens)} cache-written` : ''}
                </div>
              )}
              {shownStep.detail && <pre>{JSON.stringify(shownStep.detail, null, 2)}</pre>}
            </div>
          )}

          {/* One section per agent (its actions), followed by the readable
              data that agent produced - the analysis layer for humans. */}
          {groups.map((g, i) => {
            const lastOfAgent = !groups.slice(i + 1).some(x => x.agent === g.agent);
            return (
              <div key={`${g.agent}-sec-${i}`}>
                <AgentSection agent={g.agent} steps={g.steps}
                              vetoed={vetoed} selectedSeq={shownSeq} onSelect={select} />
                {lastOfAgent && g.agent === 'scout' && scoutReport && <ScoutOutput report={scoutReport} />}
                {lastOfAgent && g.agent === 'sourcing' && plan && <PlanOutput plan={plan} />}
                {lastOfAgent && g.agent === 'gate' && gated && <GateOutput gated={gated} />}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default function AgentProposals() {
  const qc = useQueryClient();
  const [open, setOpen] = useState<number | null>(null);
  const [autoOpened, setAutoOpened] = useState<number | null>(null);
  const [startErr, setStartErr] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['agent-runs'],
    queryFn: () => agents.runs(25),
    // Poll while any run is in flight so the row flips to completed by itself.
    refetchInterval: q => (q.state.data?.runs ?? []).some(r => r.status === 'running') ? 3000 : false,
  });
  const runs = data?.runs ?? [];
  const running = runs.some(r => r.status === 'running');

  // The trace IS the product here, so never land on a closed page: expand the
  // running run (live stream), else a paused stepwise run (it's waiting on a
  // human), else the latest run. Only once per run id, so the user can still
  // collapse it without it fighting back.
  const runningRun = runs.find(r => r.status === 'running');
  const pausedRun = runs.find(r => r.status === 'paused');
  useEffect(() => {
    const target = runningRun ?? pausedRun ?? runs[0];
    if (target && autoOpened !== target.id) {
      setOpen(target.id);
      setAutoOpened(target.id);
    }
  }, [runningRun, pausedRun, runs, autoOpened]);
  const completed = runs.filter(r => r.status === 'completed');
  const totalCost = completed.reduce((a, r) => a + (r.cost_usd || 0), 0);
  const totalSavings = completed.reduce((a, r) => a + (r.est_savings_usd || 0), 0);

  const start = async (step: boolean) => {
    setStartErr('');
    try {
      await (step ? agents.startStep() : agents.startRun());
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
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          {pausedRun ? (
            // A step run is waiting on a human: continuing IT is the primary
            // action. Starting a second scout from here was too easy a misclick.
            <button className="btn btn-secondary btn-sm"
                    disabled={running}
                    title={`Run #${pausedRun.id} is paused after the ${pausedRun.stage} stage. Continues with: ${NEXT_AGENT[pausedRun.stage ?? ''] ?? 'next agent'}.`}
                    onClick={async () => {
                      setStartErr('');
                      try {
                        await agents.advanceStep(pausedRun.id);
                        setOpen(pausedRun.id);
                        qc.invalidateQueries({ queryKey: ['agent-runs'] });
                        qc.invalidateQueries({ queryKey: ['agent-run', pausedRun.id] });
                      } catch (e) {
                        setStartErr(e instanceof Error ? e.message : 'Failed to continue');
                      }
                    }}>
              <Play size={14} style={{ verticalAlign: -2, marginRight: 4 }} />
              Continue run #{pausedRun.id}: {NEXT_AGENT[pausedRun.stage ?? ''] ?? 'next agent'}
            </button>
          ) : (
            <button className="btn btn-secondary btn-sm" onClick={() => start(true)}
                    disabled={running}
                    title="Runs ONLY the Deal Scout, then pauses for your review. You advance each later agent yourself.">
              <Play size={14} style={{ verticalAlign: -2, marginRight: 4 }} />
              Step-by-step (Scout only)
            </button>
          )}
          <button className="btn btn-primary btn-sm" onClick={() => start(false)} disabled={running}>
            <Play size={14} style={{ verticalAlign: -2, marginRight: 4 }} />
            {running ? 'Run in progress…' : 'Run now'}
          </button>
        </div>
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
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button className="btn btn-sm btn-secondary"
                              onClick={e => { e.stopPropagation(); setOpen(open === r.id ? null : r.id); }}>
                        {open === r.id ? <ChevronDown size={13} style={{ verticalAlign: -2 }} />
                                       : <ChevronRight size={13} style={{ verticalAlign: -2 }} />}
                        {open === r.id ? ' Hide trace' : ' View trace'}
                      </button>
                    </td>
                    <td>#{r.id}</td>
                    <td>{r.ym}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <span className={STATUS_TAG[r.status]}>{r.status}</span>
                      {r.status === 'paused' && r.stage && (
                        <span className="text-muted" style={{ fontSize: 11, marginLeft: 5 }}>
                          {r.stage} done
                        </span>
                      )}
                      {r.mode === 'manual' && <span className="tag tag-gray" style={{ marginLeft: 5 }}>step</span>}
                    </td>
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
