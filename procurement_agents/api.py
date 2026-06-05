"""HTTP surface for the procurement agents + their observability data.

- POST /api/agents/procurement/run        start a run for the signed-in user
- GET  /api/agents/procurement/runs       run list (the observability index)
- GET  /api/agents/procurement/runs/{id}  full step-by-step trace of one run
- POST /api/agents/procurement/run-all    CRON_SECRET-protected fan-out
  (mirrors /api/alerts/regenerate-all)

Runs execute in a background thread (a chain takes 1-3 minutes); the POST
returns the run_id immediately and the UI polls the run row.
"""

import json
import os
import threading

from fastapi import APIRouter, Depends, HTTPException, Request

from backend.auth import get_current_user
from backend.pg import get_pg

from .run import run_for_user

router = APIRouter(prefix="/api/agents/procurement", tags=["agents"])


def _store_for(user_id: int) -> int | None:
    with get_pg() as pg:
        s = pg.execute("SELECT id FROM stores WHERE user_id=%s ORDER BY id LIMIT 1",
                       (user_id,)).fetchone()
    return s["id"] if s else None


@router.post("/run")
def start_run(user: dict = Depends(get_current_user)):
    store_id = _store_for(user["id"])
    if store_id is None:
        raise HTTPException(400, "Create a store first - the agents need one.")
    with get_pg() as pg:
        busy = pg.execute(
            "SELECT id FROM agent_runs WHERE user_id=%s AND status='running'",
            (user["id"],)).fetchone()
    if busy:
        raise HTTPException(409, f"Run {busy['id']} is already in progress.")
    result: dict = {}

    def _work():
        try:
            result.update(run_for_user(user["id"], store_id,
                                       trigger="manual", user_email=user.get("email")))
        except Exception:
            pass  # the run row carries status='failed' + error

    threading.Thread(target=_work, daemon=True).start()
    return {"status": "started"}


@router.get("/runs")
def list_runs(limit: int = 20, user: dict = Depends(get_current_user)):
    with get_pg() as pg:
        rows = pg.execute(
            "SELECT id, ym, trigger_source, status, batch_id, candidates, "
            "lines_kept, lines_vetoed, est_total_usd, est_savings_usd, "
            "input_tokens, output_tokens, cost_usd, duration_ms, summary, "
            "error, created_at, finished_at "
            "FROM agent_runs WHERE user_id=%s ORDER BY id DESC LIMIT %s",
            (user["id"], min(limit, 100))).fetchall()
    return {"runs": [dict(r) for r in rows]}


@router.get("/runs/{run_id}")
def run_detail(run_id: int, user: dict = Depends(get_current_user)):
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


@router.post("/run-all")
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
