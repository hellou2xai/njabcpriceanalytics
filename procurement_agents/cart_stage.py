"""Stage the surviving lines as ONE labelled draft batch in the user's cart,
and notify through the existing alerts digest. Reuses the cart router's
insert + batch conventions; the batch shows up grouped on the Cart page and
DELETE /api/cart/batch/{batch_id} removes the whole proposal in one click.

Nothing here (or anywhere in this package) sends an order.
"""

import uuid

from backend.pg import get_pg
from backend.routers.cart import _default_rep_for, _insert_cart_item
from backend.routers.alerts import _rollup

BATCH_SOURCE = "agent_procurement"


def stage_draft(user_id: int, lines: list[dict], ym: str) -> str:
    batch_id = str(uuid.uuid4())
    label = f"Agent proposal · {ym}"
    with get_pg() as pg:
        # One proposal per month: a re-run replaces the previous unsent draft
        # instead of stacking a second one next to it.
        pg.execute(
            "DELETE FROM cart_items WHERE user_id=%s AND batch_source=%s "
            "AND batch_label=%s", (user_id, BATCH_SOURCE, label))
        for ln in lines:
            _insert_cart_item(pg, user_id, {
                "product_name": ln["product_name"],
                "wholesaler": ln["chosen_wholesaler"],
                "upc": ln["upc"],
                "unit_volume": ln.get("unit_volume"),
                "qty_cases": ln["cases"],
                "qty_units": 0,
                "batch_id": batch_id,
                "batch_label": label,
                "batch_source": BATCH_SOURCE,
            }, _default_rep_for(pg, user_id, ln["chosen_wholesaler"]))
    return batch_id


def notify(user_id: int, ym: str, kept: list[dict], vetoed: list[dict],
           est_total: float, est_savings: float) -> None:
    msg = (f"Draft order ready: {len(kept)} lines, ~${est_total:,.0f}. "
           f"Smart sourcing saves ~${est_savings:,.0f}. "
           f"{len(vetoed)} line(s) vetoed by the money gate. "
           f"Review it in your cart.")
    items = [{"product_name": l["product_name"], "wholesaler": l["chosen_wholesaler"],
              "qty_cases": l["cases"], "note": l.get("sourcing_note", "")[:120]}
             for l in kept[:10]]
    with get_pg() as pg:
        # priority is numeric (the engine uses ~95 for its top category);
        # the draft proposal should sit at the very top of the digest.
        _rollup(pg, user_id, ym, "agent_proposal", "proposal", msg, items, 99)
