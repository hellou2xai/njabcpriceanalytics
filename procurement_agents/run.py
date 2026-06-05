"""The orchestrator: deterministic control flow over the whole chain.

    scout (LLM) -> pre-pass (code) -> sourcing (LLM) -> gate (code)
        -> stage draft cart (code) -> alert (code)

Every phase is traced; the run row carries the ROI numbers (cost_usd spent vs
est_savings_usd found). Run from the repo root:

    python -m procurement_agents.run --email sambit.tripathy@gmail.com
"""

import argparse
from datetime import date

from backend.db import init_user_db
from backend.pg import get_pg

from .cart_stage import notify, stage_draft
from .gate import apply_gate
from .journal import RunTrace
from .scout import run_scout
from .sourcing import run_sourcing


def _resolve(email: str) -> tuple[int, int | None]:
    with get_pg() as pg:
        u = pg.execute("SELECT id FROM users WHERE email=%s", (email,)).fetchone()
        if not u:
            raise SystemExit(f"user {email} not found")
        s = pg.execute(
            "SELECT id FROM stores WHERE user_id=%s ORDER BY id LIMIT 1",
            (u["id"],)).fetchone()
        return u["id"], (s["id"] if s else None)


def run_for_user(user_id: int, store_id: int, ym: str | None = None,
                 trigger: str = "manual", user_email: str | None = None) -> dict:
    ym = ym or date.today().strftime("%Y-%m")
    trace = RunTrace(user_id, store_id, ym, trigger, user_email)
    try:
        report = run_scout(trace, user_id, store_id)
        candidates = report["candidates"]

        plan = run_sourcing(trace, user_id, store_id, candidates)

        with trace.phase("gate", "money_gate") as ctx:
            kept, vetoed = apply_gate(user_id, store_id, plan.get("lines", []))
            ctx["detail"] = {
                "kept": len(kept), "vetoed": len(vetoed),
                "veto_reasons": sorted({v["veto_reason"] for v in vetoed}),
                "vetoed_lines": [{"upc": v["upc"], "name": v.get("product_name"),
                                  "reason": v["veto_reason"],
                                  "detail": v.get("veto_detail")} for v in vetoed],
            }

        est_total = sum(l["effective_case_price"] * l["cases"] for l in kept)
        est_savings = sum((l.get("savings_vs_alt") or 0) for l in kept
                          if (l.get("savings_vs_alt") or 0) > 0)

        batch_id = None
        if kept:
            with trace.phase("cart", "stage_draft_batch") as ctx:
                batch_id = stage_draft(user_id, kept, ym)
                ctx["detail"] = {"batch_id": batch_id, "lines": len(kept),
                                 "est_total_usd": round(est_total, 2)}
            with trace.phase("notify", "alert_digest") as ctx:
                notify(user_id, ym, kept, vetoed, est_total, est_savings)
                ctx["detail"] = {"alert": "agent_proposal"}

        summary = (f"{len(kept)} lines staged (~${est_total:,.0f}), "
                   f"{len(vetoed)} vetoed, est sourcing savings ${est_savings:,.0f}. "
                   f"Scout note: {report.get('skipped_note', '')[:300]}")
        trace.finish("completed", batch_id=batch_id, candidates=len(candidates),
                     kept=len(kept), vetoed=len(vetoed), est_total=est_total,
                     est_savings=est_savings, summary=summary)
        return {"run_id": trace.run_id, "batch_id": batch_id,
                "candidates": len(candidates), "kept": len(kept),
                "vetoed": len(vetoed), "est_total_usd": round(est_total, 2),
                "est_savings_usd": round(est_savings, 2),
                "cost_usd": round(trace.cost, 4)}
    except Exception as e:
        trace.finish("failed", error=str(e)[:2000])
        raise


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--email", required=True)
    ap.add_argument("--ym", default=None)
    args = ap.parse_args()
    init_user_db()
    user_id, store_id = _resolve(args.email)
    if store_id is None:
        raise SystemExit("user has no store (POS signals need one)")
    out = run_for_user(user_id, store_id, args.ym, "manual", args.email)
    print(out)


if __name__ == "__main__":
    main()
