"""Lists API — multiple named product lists per user (evolves Order Analysis).

A list is a reusable, named collection of products. Users add products from
anywhere, then select items (checkbox / right-click) to send into the Cart or
delete them. Lists persist server-side per user.
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from backend.pg import get_pg
from backend.db import get_duckdb, NOW_UTC
from backend.auth import get_current_user
from backend.enrichment_join import attach_enrichment_image

router = APIRouter(prefix="/api/lists", tags=["lists"])


class ListIn(BaseModel):
    name: str


class ListItemIn(BaseModel):
    product_name: str
    wholesaler: str
    upc: Optional[str] = None
    unit_volume: Optional[str] = None
    combo_code: Optional[str] = None
    notes: Optional[str] = None
    list_id: Optional[int] = None  # used by the "add to list" convenience endpoint


class MoveIn(BaseModel):
    item_ids: list[int]


def _owned(con, list_id: int, user_id: int):
    row = con.execute("SELECT id FROM lists WHERE id=%s AND user_id=%s", (list_id, user_id)).fetchone()
    if not row:
        raise HTTPException(404, "List not found")


@router.get("")
def list_lists(user: dict = Depends(get_current_user)):
    """All of the user's lists with item counts."""
    with get_pg() as con:
        rows = con.execute(
            """SELECT l.id, l.name, l.created_at, l.updated_at,
                      (SELECT count(*) FROM list_items li WHERE li.list_id = l.id) AS item_count
               FROM lists l WHERE l.user_id = %s ORDER BY l.created_at""",
            (user["id"],),
        ).fetchall()
    return [dict(r) for r in rows]


@router.post("")
def create_list(body: ListIn, user: dict = Depends(get_current_user)):
    name = (body.name or "").strip() or "Untitled list"
    with get_pg() as con:
        row = con.execute(
            "INSERT INTO lists (user_id, name) VALUES (%s, %s) RETURNING id, name, created_at, updated_at",
            (user["id"], name),
        ).fetchone()
    return dict(row)


@router.put("/{list_id}")
def rename_list(list_id: int, body: ListIn, user: dict = Depends(get_current_user)):
    with get_pg() as con:
        _owned(con, list_id, user["id"])
        con.execute(
            f"UPDATE lists SET name=%s, updated_at={NOW_UTC} WHERE id=%s",
            ((body.name or "").strip() or "Untitled list", list_id),
        )
    return {"status": "renamed"}


@router.delete("/{list_id}")
def delete_list(list_id: int, user: dict = Depends(get_current_user)):
    with get_pg() as con:
        con.execute("DELETE FROM lists WHERE id=%s AND user_id=%s", (list_id, user["id"]))
    return {"status": "deleted"}


@router.get("/{list_id}")
def get_list(list_id: int, user: dict = Depends(get_current_user)):
    """One list with its items, each carrying a Go-UPC image_url for thumbnails."""
    with get_pg() as con:
        lst = con.execute(
            "SELECT id, name, created_at, updated_at FROM lists WHERE id=%s AND user_id=%s",
            (list_id, user["id"]),
        ).fetchone()
        if not lst:
            raise HTTPException(404, "List not found")
        items = [dict(r) for r in con.execute(
            "SELECT * FROM list_items WHERE list_id=%s ORDER BY created_at DESC", (list_id,)
        ).fetchall()]
    if items:
        with get_duckdb() as dcon:
            attach_enrichment_image(dcon, items)
    return {**dict(lst), "items": items}


@router.post("/{list_id}/items")
def add_item(list_id: int, body: ListItemIn, user: dict = Depends(get_current_user)):
    with get_pg() as con:
        _owned(con, list_id, user["id"])
        con.execute(
            """INSERT INTO list_items
                 (list_id, product_name, wholesaler, upc, unit_volume, combo_code, notes)
               VALUES (%s,%s,%s,%s,%s,%s,%s)
               ON CONFLICT (list_id, product_name, wholesaler, unit_volume) DO NOTHING""",
            (list_id, body.product_name, body.wholesaler, body.upc,
             body.unit_volume, body.combo_code, body.notes),
        )
        con.execute(f"UPDATE lists SET updated_at={NOW_UTC} WHERE id=%s", (list_id,))
    return {"status": "added"}


@router.delete("/{list_id}/items/{item_id}")
def remove_item(list_id: int, item_id: int, user: dict = Depends(get_current_user)):
    with get_pg() as con:
        _owned(con, list_id, user["id"])
        con.execute("DELETE FROM list_items WHERE id=%s AND list_id=%s", (item_id, list_id))
    return {"status": "removed"}


@router.post("/{list_id}/items/delete")
def remove_items(list_id: int, body: MoveIn, user: dict = Depends(get_current_user)):
    """Bulk-delete selected items (checkbox selection)."""
    if not body.item_ids:
        return {"status": "removed", "count": 0}
    with get_pg() as con:
        _owned(con, list_id, user["id"])
        ph = ", ".join(["%s"] * len(body.item_ids))
        con.execute(
            f"DELETE FROM list_items WHERE list_id=%s AND id IN ({ph})",
            (list_id, *body.item_ids),
        )
    return {"status": "removed", "count": len(body.item_ids)}
