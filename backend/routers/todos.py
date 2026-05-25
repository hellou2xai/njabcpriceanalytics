"""
To-Do board. Items are created by right-clicking a product anywhere in the app
(with a note and a due date) and reviewed on the To-Do page, grouped by date.
Each item keeps the product context and the page it came from (the "source").
"""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional

from backend.pg import get_pg
from backend.db import NOW_UTC
from backend.auth import get_current_user

router = APIRouter(prefix="/api/todos", tags=["todos"])


class TodoIn(BaseModel):
    title: str
    note: Optional[str] = None
    due_date: Optional[str] = None
    product_name: Optional[str] = None
    wholesaler: Optional[str] = None
    upc: Optional[str] = None
    unit_volume: Optional[str] = None
    source_page: Optional[str] = None


class TodoUpdate(BaseModel):
    title: Optional[str] = None
    note: Optional[str] = None
    due_date: Optional[str] = None
    status: Optional[str] = None


@router.get("")
def list_todos(user: dict = Depends(get_current_user)):
    """All of the user's to-dos. Open items first, then by due date (no date last)."""
    with get_pg() as con:
        rows = con.execute(
            """SELECT * FROM todos WHERE user_id = %s
               ORDER BY (status = 'done'),
                        (due_date IS NULL),
                        due_date ASC,
                        created_at DESC""",
            (user["id"],),
        ).fetchall()
    return [dict(r) for r in rows]


@router.post("")
def create_todo(t: TodoIn, user: dict = Depends(get_current_user)):
    title = (t.title or "").strip()
    if not title:
        raise HTTPException(status_code=422, detail="A short description of what to do is required.")
    with get_pg() as con:
        cur = con.execute(
            """INSERT INTO todos
               (user_id, title, note, due_date, product_name, wholesaler, upc, unit_volume, source_page)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING id""",
            (
                user["id"], title[:300], (t.note or None), (t.due_date or None),
                (t.product_name or None), (t.wholesaler or None), (t.upc or None),
                (t.unit_volume or None), (t.source_page or None),
            ),
        )
        new_id = cur.fetchone()["id"]
    return {"id": new_id}


@router.put("/{todo_id}")
def update_todo(todo_id: int, u: TodoUpdate, user: dict = Depends(get_current_user)):
    fields, vals = [], []
    if u.title is not None:
        fields.append("title = %s"); vals.append(u.title.strip()[:300])
    if u.note is not None:
        fields.append("note = %s"); vals.append(u.note or None)
    if u.due_date is not None:
        fields.append("due_date = %s"); vals.append(u.due_date or None)
    if u.status is not None:
        if u.status not in ("open", "done"):
            raise HTTPException(status_code=422, detail="Invalid status")
        fields.append("status = %s"); vals.append(u.status)
        fields.append(f"completed_at = {NOW_UTC}" if u.status == "done" else "completed_at = NULL")
    if not fields:
        return {"status": "noop"}
    vals.extend([todo_id, user["id"]])
    with get_pg() as con:
        con.execute(f"UPDATE todos SET {', '.join(fields)} WHERE id = %s AND user_id = %s", vals)
    return {"status": "updated"}


@router.delete("/{todo_id}")
def delete_todo(todo_id: int, user: dict = Depends(get_current_user)):
    with get_pg() as con:
        con.execute("DELETE FROM todos WHERE id = %s AND user_id = %s", (todo_id, user["id"]))
    return {"status": "deleted"}
