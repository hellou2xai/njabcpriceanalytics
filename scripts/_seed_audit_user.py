"""Seed a local test user (+ store, to pass StoreGate) for the Playwright
price audit. Local dev DB only; idempotent."""
from backend.auth import hash_password
from backend.pg import get_pg

EMAIL = "audit@celr.test"
PASSWORD = "AuditPass123!"

with get_pg() as con:
    row = con.execute("SELECT id FROM users WHERE email=%s", (EMAIL,)).fetchone()
    if row:
        uid = row["id"] if isinstance(row, dict) else row[0]
        con.execute("UPDATE users SET password_hash=%s, activated=1 WHERE id=%s",
                    (hash_password(PASSWORD), uid))
    else:
        con.execute(
            "INSERT INTO users (email, password_hash, full_name, phone, activated, tos_accepted_at) "
            "VALUES (%s, %s, %s, %s, 1, '2026-06-11 00:00:00')",
            (EMAIL, hash_password(PASSWORD), "Price Audit", "0000000000"),
        )
        row = con.execute("SELECT id FROM users WHERE email=%s", (EMAIL,)).fetchone()
        uid = row["id"] if isinstance(row, dict) else row[0]
    st = con.execute("SELECT id FROM stores WHERE user_id=%s", (uid,)).fetchone()
    if not st:
        con.execute("INSERT INTO stores (user_id, name, city, state) VALUES (%s, %s, %s, %s)",
                    (uid, "Audit Test Store", "Metuchen", "NJ"))
    print(f"seeded user id={uid} email={EMAIL}")
