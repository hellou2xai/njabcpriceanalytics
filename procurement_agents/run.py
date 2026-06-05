"""The orchestrator: deterministic control flow over the whole chain.

    scout (LLM) -> pre-pass (code) -> sourcing (LLM) -> gate (code)
        -> stage draft cart (code) -> alert (code)

Two execution modes over the SAME stage functions:
- run_for_user(): the full chain in one go (cron + "Run now").
- start_manual_run() / advance_manual_run(): one agent at a time. Each stage
  persists its artifact (scout_json / plan_json / gated_json) on the run row
  and pauses, so the admin can inspect what an agent produced before letting
  the next one loose.

Every phase is traced; the run row carries the ROI numbers. CLI:
    python -m procurement_agents.run --email <email> [--step]
"""

import argparse
import json
from datetime import date

from backend.db import init_user_db
from backend.pg import get_pg

from .cart_stage import notify
from .enrich import build_proposal
from .gate import apply_gate
from .journal import RunTrace
from .scout import run_scout
from .sourcing import run_sourcing

# stage value on the run row -> what has FINISHED. The next agent to run:
NEXT_STAGE = {"scout": "sourcing", "sourcing": "gate", "gate": "proposed"}


def _resolve(email: str) -> tuple[int, int | None]:
    with get_pg() as pg:
        u = pg.execute("SELECT id FROM users WHERE email=%s", (email,)).fetchone()
        if not u:
            raise SystemExit(f"user {email} not found")
        s = pg.execute(
            "SELECT id FROM stores WHERE user_id=%s ORDER BY id LIMIT 1",
            (u["id"],)).fetchone()
        return u["id"], (s["id"] if s else None)


# --------------------------- stage functions ---------------------------------
# Each takes the trace, does ONE agent's work, persists its artifact, and
# returns the data the next stage needs.

def _stage_scout(trace: RunTrace) -> dict:
    report = run_scout(trace, trace.user_id, trace.store_id)
    trace.save_json("scout_json", report)
    return report


def _stage_sourcing(trace: RunTrace, report: dict) -> dict:
    plan = run_sourcing(trace, trace.user_id, trace.store_id, report["candidates"])
    trace.save_json("plan_json", plan)
    return plan


def _stage_gate(trace: RunTrace, plan: dict) -> tuple[list, list]:
    with trace.phase("gate", "money_gate") as ctx:
        kept, vetoed = apply_gate(trace.user_id, trace.store_id, plan.get("lines", []))
        ctx["detail"] = {
            "kept": len(kept), "vetoed": len(vetoed),
            "veto_reasons": sorted({v["veto_reason"] for v in vetoed}),
            "vetoed_lines": [{"upc": v["upc"], "name": v.get("product_name"),
                              "reason": v["veto_reason"],
                              "detail": v.get("veto_detail")} for v in vetoed],
        }
    trace.save_json("gated_json", {"kept": kept, "vetoed": vetoed})
    return kept, vetoed


def _stage_propose(trace: RunTrace, kept: list, vetoed: list,
                   scout_report: dict) -> tuple[float, float]:
    """Terminal pipeline stage: build the reviewable, fully-explained proposal
    and notify. The pipeline NEVER touches the cart - adding lines to the cart
    is a separate human action on the proposal (api.add_proposal_to_cart)."""
    est_total = sum(l["effective_case_price"] * l["cases"] for l in kept)
    est_savings = sum((l.get("savings_vs_alt") or 0) for l in kept
                      if (l.get("savings_vs_alt") or 0) > 0)
    with trace.phase("proposal", "build_proposal") as ctx:
        lines = build_proposal(trace.store_id, kept, scout_report)
        trace.save_json("proposal_json", {"lines": lines})
        ctx["detail"] = {"lines": len(lines),
                         "with_rip": sum(1 for l in lines if l.get("rip")),
                         "buy_now": sum(1 for l in lines
                                        if (l.get("timing") or {}).get("verdict") == "buy_now"),
                         "est_total_usd": round(est_total, 2)}
    if kept:
        with trace.phase("notify", "alert_digest") as ctx:
            notify(trace.user_id, trace.ym, kept, vetoed, est_total, est_savings)
            ctx["detail"] = {"alert": "agent_proposal"}
    return est_total, est_savings


# --------------------------- full-chain mode ---------------------------------

def run_for_user(user_id: int, store_id: int, ym: str | None = None,
                 trigger: str = "manual", user_email: str | None = None) -> dict:
    ym = ym or date.today().strftime("%Y-%m")
    trace = RunTrace(user_id, store_id, ym, trigger, user_email, mode="auto")
    try:
        report = _stage_scout(trace)
        plan = _stage_sourcing(trace, report)
        kept, vetoed = _stage_gate(trace, plan)
        est_total, est_savings = _stage_propose(trace, kept, vetoed, report)
        summary = (f"Proposal ready: {len(kept)} lines (~${est_total:,.0f}), "
                   f"{len(vetoed)} vetoed, est sourcing savings ${est_savings:,.0f}. "
                   f"Awaiting your review - nothing added to the cart. "
                   f"Scout note: {report.get('skipped_note', '')[:300]}")
        trace.finish("completed", stage="proposed",
                     candidates=len(report["candidates"]),
                     kept=len(kept), vetoed=len(vetoed), est_total=est_total,
                     est_savings=est_savings, summary=summary)
        return {"run_id": trace.run_id,
                "candidates": len(report["candidates"]), "kept": len(kept),
                "vetoed": len(vetoed), "est_total_usd": round(est_total, 2),
                "est_savings_usd": round(est_savings, 2),
                "cost_usd": round(trace.cost, 4)}
    except Exception as e:
        trace.finish("failed", error=str(e)[:2000])
        raise


# --------------------------- stepwise (manual) mode --------------------------

def start_manual_run(user_id: int, store_id: int, ym: str | None = None,
                     user_email: str | None = None) -> dict:
    """Stage 1 only: run the Deal Scout, then pause for review."""
    ym = ym or date.today().strftime("%Y-%m")
    trace = RunTrace(user_id, store_id, ym, "manual-step", user_email, mode="manual")
    try:
        report = _stage_scout(trace)
        trace.pause("scout", candidates=len(report["candidates"]),
                    summary=f"Scout done: {len(report['candidates'])} candidates. "
                            "Review them, then run the Sourcing Planner.")
        return {"run_id": trace.run_id, "stage": "scout",
                "candidates": len(report["candidates"])}
    except Exception as e:
        trace.finish("failed", error=str(e)[:2000])
        raise


def advance_manual_run(run_id: int, user_email: str | None = None) -> dict:
    """Run exactly ONE more agent on a paused manual run."""
    with get_pg() as pg:
        run = pg.execute("SELECT * FROM agent_runs WHERE id=%s", (run_id,)).fetchone()
    if not run:
        raise ValueError(f"run {run_id} not found")
    if run["status"] != "paused":
        raise ValueError(f"run {run_id} is {run['status']}, not paused")
    stage = run["stage"]
    if stage not in NEXT_STAGE:
        raise ValueError(f"run {run_id} has no next stage after '{stage}'")

    trace = RunTrace.attach(run_id, user_email)
    try:
        if stage == "scout":
            report = json.loads(run["scout_json"] or "{}")
            plan = _stage_sourcing(trace, report)
            trace.pause("sourcing",
                        summary=f"Sourcing done: {len(plan.get('lines', []))} lines "
                                "planned. Review, then run the Money Gate.")
            return {"run_id": run_id, "stage": "sourcing",
                    "lines": len(plan.get("lines", []))}
        if stage == "sourcing":
            plan = json.loads(run["plan_json"] or "{}")
            kept, vetoed = _stage_gate(trace, plan)
            trace.pause("gate", lines_kept=len(kept), lines_vetoed=len(vetoed),
                        summary=f"Gate done: {len(kept)} kept, {len(vetoed)} vetoed. "
                                "Review the vetoes, then stage the draft cart.")
            return {"run_id": run_id, "stage": "gate",
                    "kept": len(kept), "vetoed": len(vetoed)}
        # stage == 'gate': final step builds the reviewable proposal and
        # completes. The cart stays untouched until the human adds lines.
        gated = json.loads(run["gated_json"] or "{}")
        report = json.loads(run["scout_json"] or "{}")
        kept, vetoed = gated.get("kept", []), gated.get("vetoed", [])
        est_total, est_savings = _stage_propose(trace, kept, vetoed, report)
        trace.finish("completed", stage="proposed",
                     candidates=run["candidates"], kept=len(kept),
                     vetoed=len(vetoed), est_total=est_total,
                     est_savings=est_savings,
                     summary=f"Proposal ready: {len(kept)} lines "
                             f"(~${est_total:,.0f}), {len(vetoed)} vetoed. "
                             f"Awaiting your review. (Step-by-step run.)")
        return {"run_id": run_id, "stage": "proposed"}
    except Exception as e:
        trace.finish("failed", error=str(e)[:2000])
        raise


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--email", required=True)
    ap.add_argument("--ym", default=None)
    ap.add_argument("--step", action="store_true",
                    help="start a stepwise run (scout only)")
    ap.add_argument("--advance", type=int, default=None, metavar="RUN_ID",
                    help="advance a paused stepwise run by one agent")
    args = ap.parse_args()
    init_user_db()
    user_id, store_id = _resolve(args.email)
    if store_id is None:
        raise SystemExit("user has no store (POS signals need one)")
    if args.advance:
        print(advance_manual_run(args.advance, args.email))
    elif args.step:
        print(start_manual_run(user_id, store_id, args.ym, args.email))
    else:
        print(run_for_user(user_id, store_id, args.ym, "manual", args.email))


if __name__ == "__main__":
    main()
