"""HTTP surface for the procurement agents + their observability data.
ADMIN-ONLY (except the CRON_SECRET fan-out): the whole 'Celr AI Agents'
section is gated while the platform matures.

- POST /api/agents/procurement/run        start a run for the signed-in admin
- GET  /api/agents/procurement/runs       run list (the observability index)
- GET  /api/agents/procurement/runs/{id}  full step-by-step trace of one run
- GET  /api/agents/procurement/config     pipeline config (models, floors, caps)
- GET  /api/agents/pos/summary|velocity|low-stock|lapsed   Store Feed data
- POST /api/agents/procurement/run-all    CRON_SECRET-protected fan-out
  (mirrors /api/alerts/regenerate-all)

Runs execute in a background thread (a chain takes 1-3 minutes); the POST
returns immediately and the UI polls the run list.
"""

import json
import os
import threading

from fastapi import APIRouter, Body, Depends, HTTPException, Request

from backend.auth import require_admin
from backend.pg import get_pg

from . import config as cfg
from .cart_stage import stage_draft
from .pos_signals import pos_lapsed, pos_low_stock, pos_velocity
from .run import advance_manual_run, run_for_user, start_manual_run

router = APIRouter(prefix="/api/agents", tags=["agents"])


def _store_for(user_id: int) -> int | None:
    with get_pg() as pg:
        s = pg.execute("SELECT id FROM stores WHERE user_id=%s ORDER BY id LIMIT 1",
                       (user_id,)).fetchone()
    return s["id"] if s else None


def _guard_can_start(user_id: int) -> int:
    store_id = _store_for(user_id)
    if store_id is None:
        raise HTTPException(400, "Create a store first - the agents need one.")
    with get_pg() as pg:
        busy = pg.execute(
            "SELECT id FROM agent_runs WHERE user_id=%s AND status='running'",
            (user_id,)).fetchone()
    if busy:
        raise HTTPException(409, f"Run {busy['id']} is already in progress.")
    return store_id


def _in_background(fn, *args, **kwargs):
    def _work():
        try:
            fn(*args, **kwargs)
        except Exception:
            pass  # the run row carries status='failed' + error
    threading.Thread(target=_work, daemon=True).start()


@router.post("/procurement/run")
def start_run(user: dict = Depends(require_admin)):
    """Full chain: all agents back to back."""
    store_id = _guard_can_start(user["id"])
    _in_background(run_for_user, user["id"], store_id,
                   trigger="manual", user_email=user.get("email"))
    return {"status": "started"}


@router.post("/procurement/step")
def start_step_run(user: dict = Depends(require_admin)):
    """Stepwise mode, stage 1: run ONLY the Deal Scout, then pause."""
    store_id = _guard_can_start(user["id"])
    _in_background(start_manual_run, user["id"], store_id,
                   user_email=user.get("email"))
    return {"status": "started", "stage": "scout"}


@router.post("/procurement/runs/{run_id}/step")
def advance_step_run(run_id: int, user: dict = Depends(require_admin)):
    """Stepwise mode: run exactly one more agent on a paused run."""
    with get_pg() as pg:
        run = pg.execute("SELECT user_id, status, stage FROM agent_runs WHERE id=%s",
                         (run_id,)).fetchone()
    if not run or run["user_id"] != user["id"]:
        raise HTTPException(404, "run not found")
    if run["status"] != "paused":
        raise HTTPException(409, f"run is {run['status']}, not paused")
    _guard_can_start(user["id"])
    _in_background(advance_manual_run, run_id, user.get("email"))
    return {"status": "started", "after_stage": run["stage"]}


@router.get("/procurement/runs")
def list_runs(limit: int = 20, user: dict = Depends(require_admin)):
    with get_pg() as pg:
        rows = pg.execute(
            "SELECT id, ym, trigger_source, status, mode, stage, batch_id, candidates, "
            "lines_kept, lines_vetoed, est_total_usd, est_savings_usd, "
            "input_tokens, output_tokens, cost_usd, duration_ms, summary, "
            "error, current_action, created_at, finished_at "
            "FROM agent_runs WHERE user_id=%s ORDER BY id DESC LIMIT %s",
            (user["id"], min(limit, 100))).fetchall()
    return {"runs": [dict(r) for r in rows]}


@router.get("/procurement/runs/{run_id}")
def run_detail(run_id: int, user: dict = Depends(require_admin)):
    with get_pg() as pg:
        run = pg.execute("SELECT * FROM agent_runs WHERE id=%s AND user_id=%s",
                         (run_id, user["id"])).fetchone()
        if not run:
            raise HTTPException(404, "run not found")
        steps = pg.execute(
            "SELECT seq, agent, kind, name, status, model, input_tokens, "
            "output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, "
            "duration_ms, detail, created_at "
            "FROM agent_steps WHERE run_id=%s ORDER BY seq", (run_id,)).fetchall()
    out_steps = []
    for s in steps:
        d = dict(s)
        try:
            d["detail"] = json.loads(d["detail"]) if d["detail"] else None
        except Exception:
            pass
        out_steps.append(d)
    return {"run": dict(run), "steps": out_steps}


@router.post("/procurement/runs/{run_id}/add-to-cart")
def add_proposal_to_cart(run_id: int, payload: dict = Body(default={}),
                         user: dict = Depends(require_admin)):
    """THE human approval step: push proposal lines into the cart.
    payload.upcs (optional list) limits it to selected lines; omitted = every
    line not yet staged. Appends to the run's existing batch on repeat calls."""
    with get_pg() as pg:
        run = pg.execute("SELECT * FROM agent_runs WHERE id=%s", (run_id,)).fetchone()
    if not run or run["user_id"] != user["id"]:
        raise HTTPException(404, "run not found")
    if not run["proposal_json"]:
        raise HTTPException(409, "this run has no proposal to stage")
    proposal = json.loads(run["proposal_json"])
    lines = proposal.get("lines", [])
    norm = lambda u: str(u or "").strip().lstrip("0")
    wanted = {norm(u) for u in (payload.get("upcs") or [])}
    selected = [l for l in lines if not l.get("staged")
                and (not wanted or norm(l["upc"]) in wanted)]
    if not selected:
        raise HTTPException(409, "no unstaged lines matched")

    batch_id = stage_draft(user["id"], selected, run["ym"],
                           batch_id=run["batch_id"])
    sel_upcs = {norm(l["upc"]) for l in selected}
    for l in lines:
        if norm(l["upc"]) in sel_upcs:
            l["staged"] = True
    with get_pg() as pg:
        pg.execute("UPDATE agent_runs SET proposal_json=%s, batch_id=%s WHERE id=%s",
                   (json.dumps(proposal, default=str), batch_id, run_id))
        # Journal the human action as a trace step, so the run's story shows
        # WHO put lines in the cart (the user, never an agent).
        seq = pg.execute("SELECT COALESCE(MAX(seq),0)+1 s FROM agent_steps "
                         "WHERE run_id=%s", (run_id,)).fetchone()["s"]
        pg.execute(
            "INSERT INTO agent_steps (run_id, seq, agent, kind, name, status, detail) "
            "VALUES (%s,%s,'cart','phase','user_added_to_cart','ok',%s)",
            (run_id, seq, json.dumps({"by": user.get("email"), "lines": len(selected),
                                      "batch_id": batch_id})))
    return {"status": "staged", "batch_id": batch_id, "lines": len(selected),
            "remaining": sum(1 for l in lines if not l.get("staged"))}


@router.get("/procurement/config")
def pipeline_config(user: dict = Depends(require_admin)):
    """Read-only pipeline configuration for the Agent Settings page."""
    return {
        "scout_model": cfg.SCOUT_MODEL,
        "sourcing_model": cfg.SOURCING_MODEL,
        "max_turns": cfg.MAX_TURNS,
        "max_candidates": cfg.MAX_CANDIDATES,
        "max_cases_per_line": cfg.MAX_CASES_PER_LINE,
        "min_gp": cfg.MIN_GP,
        "max_run_tokens": cfg.MAX_RUN_TOKENS,
        "pricing_per_mtok": {k: {"input": v[0], "output": v[1]}
                             for k, v in cfg.PRICING.items()},
        "env_overrides": ["CELR_AGENT_SCOUT_MODEL", "CELR_AGENT_SOURCING_MODEL",
                          "CELR_AGENT_MIN_GP", "CELR_AGENT_MAX_RUN_TOKENS"],
    }


def _pos_ctx(user: dict) -> dict:
    store_id = _store_for(user["id"])
    if store_id is None:
        raise HTTPException(400, "Create a store first - the POS feed hangs off one.")
    return {"user_id": user["id"], "store_id": store_id}


@router.get("/pos/summary")
def pos_summary(user: dict = Depends(require_admin)):
    """Store Feed header: store identity, monthly revenue/units, totals."""
    ctx = _pos_ctx(user)
    with get_pg() as pg:
        store = pg.execute("SELECT id, name, city, state FROM stores WHERE id=%s",
                           (ctx["store_id"],)).fetchone()
        months = pg.execute(
            "SELECT SUBSTR(business_date,1,7) ym, ROUND(SUM(net_revenue)::numeric,0)::float revenue, "
            "SUM(units_sold) units FROM pos_sales_daily WHERE store_id=%s "
            "GROUP BY 1 ORDER BY 1 DESC LIMIT 12", (ctx["store_id"],)).fetchall()
        totals = pg.execute(
            "SELECT COUNT(DISTINCT upc) skus, MIN(business_date) first_sale, "
            "MAX(business_date) last_sale, SUM(units_sold) units, "
            "ROUND(SUM(net_revenue)::numeric,0)::float revenue "
            "FROM pos_sales_daily WHERE store_id=%s", (ctx["store_id"],)).fetchone()
        feed = pg.execute(
            "SELECT source, kind, period_end, rows_ingested, created_at "
            "FROM pos_ingest_log WHERE store_id=%s ORDER BY id DESC LIMIT 1",
            (ctx["store_id"],)).fetchone()
    return {"store": dict(store) if store else None,
            "months": [dict(m) for m in reversed(months)],
            "totals": dict(totals) if totals else {},
            "last_feed": dict(feed) if feed else None}


@router.get("/pos/velocity")
def pos_velocity_api(limit: int = 50, category: str | None = None,
                     user: dict = Depends(require_admin)):
    return {"rows": pos_velocity({"limit": limit, "category": category}, _pos_ctx(user))}


@router.get("/pos/low-stock")
def pos_low_stock_api(days_threshold: float = 14, limit: int = 50,
                      user: dict = Depends(require_admin)):
    return {"rows": pos_low_stock({"days_threshold": days_threshold, "limit": limit},
                                  _pos_ctx(user))}


@router.get("/pos/lapsed")
def pos_lapsed_api(lapsed_days: int = 60, limit: int = 50,
                   user: dict = Depends(require_admin)):
    return {"rows": pos_lapsed({"lapsed_days": lapsed_days, "limit": limit},
                               _pos_ctx(user))}


@router.post("/procurement/run-all")
def run_all(request: Request):
    """Nightly/monthly fan-out for every user with a store. Same shared-secret
    pattern as /api/alerts/regenerate-all."""
    secret = os.getenv("CRON_SECRET")
    if not secret or request.headers.get("x-cron-secret") != secret:
        raise HTTPException(403, "forbidden")
    with get_pg() as pg:
        targets = pg.execute(
            "SELECT u.id user_id, u.email, MIN(s.id) store_id FROM users u "
            "JOIN stores s ON s.user_id = u.id GROUP BY u.id, u.email").fetchall()

    def _work():
        for t in targets:
            try:
                run_for_user(t["user_id"], t["store_id"],
                             trigger="cron", user_email=t["email"])
            except Exception:
                continue  # failure is journalled on the run row

    threading.Thread(target=_work, daemon=True).start()
    return {"status": "started", "users": len(targets)}
