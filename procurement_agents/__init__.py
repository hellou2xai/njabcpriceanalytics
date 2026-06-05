"""Procurement agents: the monthly draft-order pipeline.

Code-orchestrated (option A): deterministic control flow, model judgement only
inside each step. Scout (find candidates) -> price-compare pre-pass (code) ->
Sourcing (pick distributor per line) -> gate (code-only money rules) ->
draft cart batch + alert. The pipeline NEVER sends an order; its terminal
state is a labelled batch in the user's cart.

Every action is traced to agent_runs / agent_steps (see journal.py) with
model, tokens, latency and USD cost, so each proposal carries its own
cost-vs-savings ROI story.

Tools are reused from backend.assistant's registries plus the POS-signal
tools in pos_signals.py. No tool logic is duplicated here.
"""
