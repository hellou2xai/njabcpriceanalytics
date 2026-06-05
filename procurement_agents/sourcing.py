"""Agent 2: the Sourcing Planner, plus the deterministic price-compare
pre-pass that does the expensive part for free.

The pre-pass attaches every distributor's current price per candidate UPC
(plain SQL); the agent only makes the judgement calls: which source, whether
a tier stretch pays, when consolidating onto one rep beats pennies saved."""

import json

from backend.db import get_duckdb

from .config import SOURCING_MODEL
from .registry import ToolBox
from .runner import run_agent
from .schemas import SOURCING_PLAN

ASSISTANT_TOOLS = [
    "compare_distributors",  # per-UPC cross-distributor detail when needed
    "rip_lookup",            # rebate codes + tiers per distributor
    "rip_tier_gap",          # cases to the next rebate tier
    "price_details",         # full breakdown when something looks off
]

SYSTEM = """You are the Sourcing Planner for a New Jersey liquor retailer.
You receive scouted candidates, each pre-annotated with EVERY distributor's
current effective case price for that UPC (the per_distributor list).

For each candidate pick the source and final case quantity. Rules (these are
ALSO enforced downstream in code, so do not fight them):
- Choose the cheapest reliable source, BUT prefer consolidating lines onto
  fewer distributors when the spread is under $2/case - the rep relationship
  is worth more than pennies.
- If adding 1-3 cases unlocks the next RIP tier (rip_tier_gap), adjust cases
  and say so in sourcing_note - but never more than double the scouted
  quantity.
- Copy effective_case_price exactly from the annotation data; never estimate.
- Copy each line's upc CHARACTER-FOR-CHARACTER from the candidate data. Never
  retype, shorten, zero-pad or substitute another identifier (distributor SKUs
  are NOT UPCs). A mangled upc gets the line vetoed downstream.
- alt_wholesaler/alt_effective_price = the best source you did NOT choose
  (null if single-sourced). savings_vs_alt = (alt - chosen) x cases when you
  chose the cheaper one, else negative (a deliberate consolidation cost).
- Drop a candidate entirely (omit it) only if it has no available source.
The pre-annotation usually suffices; call tools only when you genuinely need
more depth (tier ladders, suspicious prices). Return the structured plan and
nothing else."""


def annotate_candidates(candidates: list[dict]) -> list[dict]:
    """Deterministic pre-pass: all current sources per candidate UPC. Joined
    on the house-normalized UPC (leading zeros stripped) so a scout-echoed
    identifier still matches the catalog."""
    norm = lambda u: str(u or "").strip().lstrip("0")
    upcs = sorted({norm(c["upc"]) for c in candidates if norm(c["upc"])})
    if not upcs:
        return candidates
    ph = ",".join("?" * len(upcs))
    with get_duckdb() as con:
        rows = con.execute(f"""
            SELECT LTRIM(CAST(upc AS VARCHAR),'0') un, wholesaler,
                   effective_case_price, frontline_case_price,
                   rip_code, unit_qty bottles_per_case, has_rip, has_discount
            FROM cpl_enriched
            WHERE edition = (SELECT MAX(edition) FROM cpl_enriched)
              AND LTRIM(CAST(upc AS VARCHAR),'0') IN ({ph})
            ORDER BY 1, effective_case_price""", upcs).fetchall()
    cols = ["un", "wholesaler", "effective_case_price", "frontline_case_price",
            "rip_code", "bottles_per_case", "has_rip", "has_discount"]
    by_upc: dict[str, list] = {}
    for r in rows:
        d = dict(zip(cols, r))
        by_upc.setdefault(d.pop("un"), []).append(d)
    return [{**c, "per_distributor": by_upc.get(norm(c["upc"]), [])} for c in candidates]


def run_sourcing(trace, user_id: int, store_id: int, candidates: list[dict]) -> dict:
    with trace.phase("sourcing", "price_compare_pre_pass") as ctx:
        annotated = annotate_candidates(candidates)
        sourced = sum(1 for c in annotated if c["per_distributor"])
        multi = sum(1 for c in annotated if len(c["per_distributor"]) > 1)
        ctx["detail"] = {"candidates": len(annotated), "with_source": sourced,
                         "multi_distributor": multi}
    box = ToolBox(ASSISTANT_TOOLS, {}, ctx={"user_id": user_id, "store_id": store_id},
                  trace=trace, agent="sourcing")
    return run_agent(
        trace, "sourcing", SOURCING_MODEL, SYSTEM, box,
        "Scouted candidates with per-distributor pricing:\n\n"
        + json.dumps(annotated, default=str),
        SOURCING_PLAN)
