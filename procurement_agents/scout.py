"""Agent 1: the Deal Scout. Finds this month's buying opportunities for ONE
store, grounded in its own POS sell-through plus the user's CELR footprint."""

from .config import MAX_CANDIDATES, SCOUT_MODEL
from .pos_signals import SPECS as POS_SPECS
from .registry import ToolBox
from .runner import run_agent
from .schemas import SCOUT_REPORT

ASSISTANT_TOOLS = [
    "edition_changes",       # what changed this edition for the user's footprint
    "deal_changes",          # gained/lost RIP / discount / combo month-over-month
    "best_to_buy",           # buy-now vs wait timing
    "dated_deal_reminders",  # short-window promos ending soon
    "best_one_case_rip",     # RIPs worth it at a single case
    "order_history",         # past CELR orders + frequently-ordered rollup
    "lapsed_items",          # CELR-side win-backs
]

SYSTEM = f"""You are the Deal Scout for one New Jersey liquor retailer on CELR.
A new monthly price edition has landed. Build the {MAX_CANDIDATES}-item (max)
candidate list of what this store should buy THIS month.

Priority order:
1. pos_low_stock: items selling now with under ~2 weeks of cover. These are
   near-certain orders; set suggested_cases to roughly cover 30 days of
   demand (units_per_day x 30 / bottles_per_case, rounded, minimum 1).
2. pos_velocity movers that currently carry a deal (has_rip or has_discount,
   or a price drop in edition_changes/deal_changes): reorder while it's cheap.
3. pos_lapsed with still_available=true: win-backs worth restocking.
4. Catalog opportunities (expiring deals, closeouts, one-case RIPs) ONLY when
   they fit this store's mix - it is wine-forward; do not propose categories
   it barely sells.

Rules:
- Only items returned by your tools; never invent products, UPCs or prices.
- Ground every suggested_cases in POS evidence when it exists; without
  evidence stay at 1-2 cases.
- One candidate per UPC. Cite the concrete reason in rationale (numbers, not
  vibes: units/day, days of cover, $ change).
- Be selective. A short, high-conviction list beats a padded one.
Return the structured report and nothing else."""


def run_scout(trace, user_id: int, store_id: int) -> dict:
    box = ToolBox(ASSISTANT_TOOLS, POS_SPECS,
                  ctx={"user_id": user_id, "store_id": store_id},
                  trace=trace, agent="scout")
    report = run_agent(
        trace, "scout", SCOUT_MODEL, SYSTEM, box,
        "New edition is live. Build this month's candidate list for the store.",
        SCOUT_REPORT)
    report["candidates"] = report.get("candidates", [])[:MAX_CANDIDATES]
    return report
