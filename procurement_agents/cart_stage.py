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


def stage_draft(user_id: int, lines: list[dict], ym: str,
                batch_id: str | None = None) -> str:
    """Write lines to the cart as one labelled agent batch.

    batch_id=None -> a fresh proposal push: replaces any previous unsent agent
    batch for the month. Passing an existing batch_id APPENDS to that batch
    (the user adding more lines from the same proposal) without wiping the
    lines they already accepted."""
    label = f"Agent proposal · {ym}"
    with get_pg() as pg:
        if batch_id is None:
            batch_id = str(uuid.uuid4())
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
    msg = (f"Order proposal ready for review: {len(kept)} lines, ~${est_total:,.0f}. "
           f"Smart sourcing saves ~${est_savings:,.0f}; "
           f"{len(vetoed)} line(s) vetoed by the money gate. "
           f"Nothing is in your cart yet - review each line's full reasoning "
           f"under Celr AI Agents > Order Proposals and add what you approve.")
    items = [{"product_name": l["product_name"], "wholesaler": l["chosen_wholesaler"],
              "qty_cases": l["cases"], "note": l.get("sourcing_note", "")[:120]}
             for l in kept[:10]]
    with get_pg() as pg:
        # priority is numeric (the engine uses ~95 for its top category);
        # the draft proposal should sit at the very top of the digest.
        _rollup(pg, user_id, ym, "agent_proposal", "proposal", msg, items, 99)
