"""Run tracing: the observability backbone.

One agent_runs row per pipeline execution; one agent_steps row per action
inside it (every LLM turn, every tool call, every deterministic phase), each
with model, tokens, cache activity, latency and USD cost. The 'Celr AI Agents'
UI reads these two tables; ROI per run is cost_usd vs est_savings_usd.

LLM turns are ALSO mirrored into ai_usage_log (surface='procurement_agent')
so the existing admin AI-usage rollup sees agent spend without any new query.
"""

import json
import time
from contextlib import contextmanager

from backend.ai_usage import log_usage
from backend.pg import get_pg

from .config import usd


def _clip(obj, limit=4000) -> str:
    try:
        s = json.dumps(obj, default=str)
    except Exception:
        s = str(obj)
    return s[:limit]


class RunTrace:
    """Created once per pipeline run; threaded through every step."""

    def __init__(self, user_id: int, store_id: int | None, ym: str,
                 trigger: str = "manual", user_email: str | None = None):
        self.user_id, self.store_id, self.ym = user_id, store_id, ym
        self.user_email = user_email
        self.seq = 0
        self.input_tokens = self.output_tokens = 0
        self.cost = 0.0
        self._t0 = time.monotonic()
        with get_pg() as pg:
            row = pg.execute(
                "INSERT INTO agent_runs (user_id, store_id, ym, trigger_source) "
                "VALUES (%s,%s,%s,%s) RETURNING id",
                (user_id, store_id, ym, trigger)).fetchone()
        self.run_id = row["id"]

    # ---- step recording -----------------------------------------------------

    def _write_step(self, agent, kind, name, status, detail, dur_ms,
                    model=None, itok=0, otok=0, cread=0, cwrite=0, cost=0.0):
        self.seq += 1
        with get_pg() as pg:
            pg.execute(
                "INSERT INTO agent_steps (run_id, seq, agent, kind, name, status, "
                "model, input_tokens, output_tokens, cache_read_tokens, "
                "cache_write_tokens, cost_usd, duration_ms, detail) "
                "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                (self.run_id, self.seq, agent, kind, name, status, model,
                 itok, otok, cread, cwrite, cost, dur_ms, detail))

    @contextmanager
    def phase(self, agent: str, name: str, detail_fn=None):
        """Trace a deterministic phase (pre-pass, gate, cart staging). The
        with-block may set ctx['detail'] for the journal."""
        t0 = time.monotonic()
        ctx: dict = {}
        try:
            yield ctx
            self._write_step(agent, "phase", name, "ok",
                             _clip(ctx.get("detail")), int((time.monotonic() - t0) * 1000))
        except Exception as e:
            self._write_step(agent, "phase", name, "error",
                             _clip({"error": str(e), **({"detail": ctx.get("detail")} if ctx.get("detail") else {})}),
                             int((time.monotonic() - t0) * 1000))
            raise

    def tool_call(self, agent: str, name: str, args: dict, result, dur_ms: int,
                  error: str | None = None):
        detail = {"args": args}
        if error:
            detail["error"] = error
        elif isinstance(result, list):
            detail["result_rows"] = len(result)
        elif isinstance(result, dict):
            detail["result_keys"] = list(result.keys())[:12]
            for k in ("count", "error"):
                if k in result:
                    detail[k] = result[k]
        self._write_step(agent, "tool_call", name, "error" if error else "ok",
                         _clip(detail), dur_ms)

    def llm_turn(self, agent: str, model: str, usage, dur_ms: int,
                 stop_reason: str | None = None):
        """Record one messages.create round trip. Returns its USD cost."""
        itok = getattr(usage, "input_tokens", 0) or 0
        otok = getattr(usage, "output_tokens", 0) or 0
        cread = getattr(usage, "cache_read_input_tokens", 0) or 0
        cwrite = getattr(usage, "cache_creation_input_tokens", 0) or 0
        cost = usd(model, itok, otok, cread, cwrite)
        self.input_tokens += itok + cread + cwrite
        self.output_tokens += otok
        self.cost += cost
        self._write_step(agent, "llm_turn", f"{agent} turn", "ok",
                         _clip({"stop_reason": stop_reason}), dur_ms,
                         model=model, itok=itok, otok=otok,
                         cread=cread, cwrite=cwrite, cost=cost)
        log_usage({"id": self.user_id, "email": self.user_email},
                  "procurement_agent", f"{agent} run {self.run_id}",
                  {"model": model, "input_tokens": itok + cread + cwrite,
                   "output_tokens": otok, "cost_usd": cost})
        return cost

    # ---- run lifecycle ------------------------------------------------------

    def finish(self, status: str, *, batch_id=None, candidates=0, kept=0,
               vetoed=0, est_total=0.0, est_savings=0.0, summary=None,
               error=None):
        with get_pg() as pg:
            pg.execute(
                "UPDATE agent_runs SET status=%s, batch_id=%s, candidates=%s, "
                "lines_kept=%s, lines_vetoed=%s, est_total_usd=%s, "
                "est_savings_usd=%s, input_tokens=%s, output_tokens=%s, "
                "cost_usd=%s, duration_ms=%s, summary=%s, error=%s, "
                "finished_at=TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') "
                "WHERE id=%s",
                (status, batch_id, candidates, kept, vetoed,
                 round(est_total, 2), round(est_savings, 2),
                 self.input_tokens, self.output_tokens, round(self.cost, 6),
                 int((time.monotonic() - self._t0) * 1000),
                 summary, error, self.run_id))
