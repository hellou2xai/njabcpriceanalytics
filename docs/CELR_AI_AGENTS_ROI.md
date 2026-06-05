# Celr AI Agents: ROI and Observability

How the procurement-agent platform pays for itself, how every claim in this
document can be re-verified from the database, and how to read the
observability data when justifying the spend.

Last updated: 2026-06-05. All figures below come from real runs recorded in
`agent_runs` / `agent_steps` against the Planet of Wine demo store.

## What the platform does

Once a month (or on demand), a pipeline of agents builds a fully-explained
draft order proposal for each store:

1. **Deal Scout** (Claude Sonnet): reads the store's own POS sell-through
   (velocity, days of cover, lapsed items) plus the new price edition, and
   short-lists what to buy and how much.
2. **Price-compare pre-pass** (plain code, free): attaches every
   distributor's current price to each candidate.
3. **Sourcing Planner** (Claude Sonnet): picks the distributor per line,
   weighs rebate-tier stretches, and consolidates orders where spreads are
   small.
4. **Money Gate** (plain code, no AI): re-verifies every price against the
   live price book, enforces the stocking-deal floor, the gross-profit floor,
   duplicate checks and quantity caps. The model's numbers are discarded;
   the catalog's numbers are used.
5. **Proposal Builder** (plain code, free): attaches the full WHY to every
   line: the Scout's evidence, the source comparison, the margin arithmetic,
   RIP rebate analysis (earned tier + next tier), and buy-now-vs-wait timing.

The pipeline's terminal state is a reviewable proposal. **No agent can put
anything in the cart, and nothing can ever send an order.** A human reviews
each line's step-by-step reasoning and adds approved lines to the cart;
sending stays the same manual flow as today.

## Measured economics (real runs)

| Run | Date | Lines proposed | Draft value | Sourcing savings found | AI cost | Duration |
|----:|------|---------------:|------------:|----------------------:|--------:|---------:|
| 3 (local) | 2026-06-05 | 23 | $6,323 | $562 | $0.28 | 2.8 min |
| 4 (local) | 2026-06-05 | 24 | $5,684 | $576 | $0.37 | 3.2 min |
| 6 (local) | 2026-06-05 | 25 | $5,964 | $598 | $0.46 | ~3 min |
| 8 (local) | 2026-06-05 | 25 | $7,156 | $616 | $0.29 | ~3 min |
| 1 (prod)  | 2026-06-05 | 24 | n/a | $690 | $0.40 | 2.8 min |

"Sourcing savings" counts only one of the proposal's value streams: dollars
saved by buying each line from the cheapest distributor instead of the
default one. It does not count RIP rebates captured, buy-now-vs-wait timing
wins, or the buyer hours saved, so it understates the real return.

**Headline: roughly $0.30 to $0.45 of AI spend per store per month finds
$550 to $700 of measurable sourcing savings: a 1,200x to 2,000x return on
the AI cost.** Even if the buyer rejects three-quarters of the proposal,
the run pays for itself several hundred times over.

### Cost structure

- Both agents run Claude Sonnet 4.6 ($3 in / $15 out per million tokens).
  A full run uses ~100-120k input + ~7k output tokens.
- Prompt caching cuts repeat-turn input cost to ~10%: cache reads are
  visible per step in the trace (`cache_read_tokens`).
- The expensive analytical work (price comparison across distributors,
  margin checks, RIP math, timing) is deterministic code: zero tokens.
- Hard caps guard against runaways: max 8 tool turns per agent, max 25
  candidates, 400k tokens per run (the run aborts and journals if exceeded).
- The nightly fan-out can move to the Batches API for a further 50% discount
  when run counts grow.

## How to re-verify every number

The observability schema makes each claim auditable:

- **`agent_runs`**: one row per run with `cost_usd`, `est_total_usd`,
  `est_savings_usd`, token totals, duration, status, and the persisted
  stage artifacts (`scout_json`, `plan_json`, `gated_json`,
  `proposal_json`).
- **`agent_steps`**: one row per action inside a run: every model turn
  (model, input/output/cache tokens, USD), every tool call (arguments,
  result size, latency), every code phase (gate veto reasons with dollar
  arithmetic), and the human add-to-cart action (who, when, which lines).
- **`ai_usage_log`** (`surface = 'procurement_agent'`): mirrors agent model
  spend into the existing admin AI-usage rollup.

ROI per run is therefore two columns on the same row:
`est_savings_usd / cost_usd`. The Order Proposals page renders this as the
"AI spend -> ROI" card, and the per-run trace shows where every cent went.

## Why the proposals can be trusted

- Every proposed line carries a five-step decision trail with actual
  numbers (POS velocity, source-by-source prices, the margin calculation,
  rebate tiers, price trajectory). The trail is generated from journalled
  data by deterministic code, never by model prose.
- Vetoed lines are shown, not hidden, with the rule and the arithmetic that
  killed them.
- Money rules live in code, not prompts. The gate re-verifies every price
  against the catalog and replaces the model's copy.
- Identifiers are never trusted from a model: all joins use the
  normalized-UPC convention, and accepted lines take the catalog's
  canonical UPC.
- The pipeline cannot touch the cart; a human approves lines from the
  proposal review, and the approval itself is journalled as a trace step.

## Current limits (honest caveats)

- The Planet of Wine POS feed is synthetic (built from real, live catalog
  SKUs with real distributors, but simulated sales). Quantity suggestions
  will improve materially once a real POS export feeds the same tables.
- "Savings found" is measured against the most expensive listed source the
  buyer could plausibly have used; a disciplined buyer would capture part
  of it anyway. The honest framing: the agents make the disciplined
  comparison happen every month, for every line, in three minutes.
- One store, one month of history so far. Re-baseline this document after
  the first quarter of real use.
