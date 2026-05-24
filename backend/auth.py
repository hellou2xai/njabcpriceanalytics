"""
Authentication for the multi-owner (SaaS) deployment.

Real signup/signin, replacing the old client-side demo token. Passwords are
hashed with PBKDF2-HMAC-SHA256 (Python stdlib, no extra dependency). Sessions
are random bearer tokens stored in Postgres and sent as
``Authorization: Bearer <token>``.

Every per-user table is scoped by the ``user_id`` returned from
``get_current_user`` so one owner never sees another owner's data.
"""

import hashlib
import os
import re
import secrets
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Header, Body
from pydantic import BaseModel, field_validator
from typing import Optional

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

from backend.pg import get_pg
from backend import mailer

# Token lifetime. Owners stay signed in for 30 days, then re-authenticate.
TOKEN_TTL_DAYS = 30

# PBKDF2 cost. High enough to be slow for an attacker, cheap for one login.
_PBKDF2_ITERATIONS = 200_000

# Admin allowlist. Comma-separated emails in ADMIN_EMAILS; defaults to the owner.
ADMIN_EMAILS = {
    e.strip().lower()
    for e in os.getenv("ADMIN_EMAILS", "sambit.tripathy@gmail.com").split(",")
    if e.strip()
}


def _is_admin(email) -> bool:
    return bool(email) and str(email).strip().lower() in ADMIN_EMAILS


# ---- Password hashing ----

def hash_password(password: str) -> str:
    """Return a self-describing ``pbkdf2_sha256$iters$salt$hash`` string."""
    salt = secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"),
                             salt.encode("utf-8"), _PBKDF2_ITERATIONS)
    return f"pbkdf2_sha256${_PBKDF2_ITERATIONS}${salt}${dk.hex()}"


def verify_password(password: str, stored: str) -> bool:
    """Constant-time check of a plaintext password against the stored hash."""
    try:
        algo, iters, salt, expected = stored.split("$")
        if algo != "pbkdf2_sha256":
            return False
        dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"),
                                 salt.encode("utf-8"), int(iters))
        return secrets.compare_digest(dk.hex(), expected)
    except (ValueError, AttributeError):
        return False


# ---- Token sessions ----

def _new_token(con, user_id: int) -> str:
    token = secrets.token_urlsafe(32)
    expires = datetime.now(timezone.utc) + timedelta(days=TOKEN_TTL_DAYS)
    con.execute(
        "INSERT INTO auth_tokens (token, user_id, expires_at) VALUES (%s, %s, %s)",
        (token, user_id, expires.isoformat()),
    )
    return token


def _new_email_token(con, user_id: int, purpose: str, ttl_hours: int) -> str:
    token = secrets.token_urlsafe(32)
    expires = datetime.now(timezone.utc) + timedelta(hours=ttl_hours)
    con.execute(
        "INSERT INTO email_tokens (token, user_id, purpose, expires_at) VALUES (%s, %s, %s, %s)",
        (token, user_id, purpose, expires.isoformat()),
    )
    return token


def _consume_email_token(con, token: str, purpose: str) -> Optional[int]:
    """Return the user_id for a valid, unexpired token of this purpose, then
    delete it (single use). None if invalid or expired."""
    row = con.execute(
        "SELECT user_id, expires_at FROM email_tokens WHERE token = %s AND purpose = %s",
        (token, purpose),
    ).fetchone()
    if not row:
        return None
    try:
        expired = datetime.fromisoformat(row["expires_at"]) < datetime.now(timezone.utc)
    except (ValueError, TypeError):
        expired = True
    con.execute("DELETE FROM email_tokens WHERE token = %s", (token,))
    return None if expired else row["user_id"]


def _user_for_token(con, token: str) -> Optional[dict]:
    row = con.execute(
        """SELECT u.id, u.email, u.full_name, t.expires_at
           FROM auth_tokens t JOIN users u ON u.id = t.user_id
           WHERE t.token = %s""",
        (token,),
    ).fetchone()
    if not row:
        return None
    try:
        if datetime.fromisoformat(row["expires_at"]) < datetime.now(timezone.utc):
            con.execute("DELETE FROM auth_tokens WHERE token = %s", (token,))
            return None
    except (ValueError, TypeError):
        return None
    return {"id": row["id"], "email": row["email"], "full_name": row["full_name"],
            "is_admin": _is_admin(row["email"])}


def _token_from_header(authorization: Optional[str]) -> Optional[str]:
    if not authorization:
        return None
    parts = authorization.split(" ", 1)
    if len(parts) == 2 and parts[0].lower() == "bearer":
        return parts[1].strip()
    return authorization.strip()


# ---- FastAPI dependencies ----

def get_current_user(authorization: Optional[str] = Header(None)) -> dict:
    """Require a valid bearer token. Raises 401 otherwise. Returns the user."""
    token = _token_from_header(authorization)
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")
    with get_pg() as con:
        user = _user_for_token(con, token)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid or expired session")
    return user


def get_optional_user(authorization: Optional[str] = Header(None)) -> Optional[dict]:
    """Like get_current_user but returns None instead of raising. Used by
    shared pricing endpoints that personalise a slice of their output (e.g.
    the 'tracked only' filter) but should still work while loading."""
    token = _token_from_header(authorization)
    if not token:
        return None
    with get_pg() as con:
        return _user_for_token(con, token)


def require_admin(user: dict = Depends(get_current_user)) -> dict:
    """Require an admin (email in ADMIN_EMAILS). 403 otherwise."""
    if not user.get("is_admin"):
        raise HTTPException(status_code=403, detail="Admin access required")
    return user


# ---- Router ----

router = APIRouter(prefix="/api/auth", tags=["auth"])


class SignupRequest(BaseModel):
    email: str
    password: str
    full_name: Optional[str] = None

    @field_validator("email")
    @classmethod
    def _valid_email(cls, v: str) -> str:
        v = v.strip().lower()
        if not _EMAIL_RE.match(v):
            raise ValueError("Enter a valid email address")
        return v

    @field_validator("password")
    @classmethod
    def _min_len(cls, v: str) -> str:
        if len(v) < 8:
            raise ValueError("Password must be at least 8 characters")
        return v


class LoginRequest(BaseModel):
    email: str
    password: str


def _claim_orphan_data(con, user_id: int):
    """When the first owner signs up, hand them any pre-existing global rows
    (data created before accounts existed) so nothing is lost on migration."""
    user_count = con.execute("SELECT COUNT(*) AS n FROM users").fetchone()["n"]
    if user_count != 1:
        return
    for table in ("watchlist", "orders", "user_notes", "user_ratings",
                  "alerts", "sales_reps", "stores"):
        con.execute(
            f"UPDATE {table} SET user_id = %s WHERE user_id IS NULL",
            (user_id,),
        )


@router.post("/signup")
def signup(req: SignupRequest):
    email = req.email.lower().strip()
    full_name = (req.full_name or "").strip() or None
    # When email is enabled, the account starts unactivated and must verify via
    # the emailed link. When email is off, auto-activate so nobody is locked out.
    activated = 0 if mailer.MAIL_ENABLED else 1
    with get_pg() as con:
        if con.execute("SELECT 1 FROM users WHERE email = %s", (email,)).fetchone():
            raise HTTPException(status_code=409, detail="An account with that email already exists")
        cur = con.execute(
            "INSERT INTO users (email, password_hash, full_name, activated) VALUES (%s, %s, %s, %s) RETURNING id",
            (email, hash_password(req.password), full_name, activated),
        )
        user_id = cur.fetchone()["id"]
        _claim_orphan_data(con, user_id)
        if mailer.MAIL_ENABLED:
            activate_token = _new_email_token(con, user_id, "activate", 48)
        else:
            session_token = _new_token(con, user_id)

    if mailer.MAIL_ENABLED:
        mailer.send_activation(email, activate_token, full_name)
        return {"status": "activation_required", "email": email}
    mailer.send_welcome(email, full_name)  # no-op while email is disabled
    return {"token": session_token, "user": {"id": user_id, "email": email, "full_name": full_name,
                                             "is_admin": _is_admin(email)}}


@router.post("/login")
def login(req: LoginRequest):
    email = req.email.lower().strip()
    with get_pg() as con:
        row = con.execute(
            "SELECT id, email, password_hash, full_name, activated FROM users WHERE email = %s",
            (email,),
        ).fetchone()
        if not row or not verify_password(req.password, row["password_hash"]):
            raise HTTPException(status_code=401, detail="Incorrect email or password")
        if mailer.MAIL_ENABLED and not row["activated"]:
            raise HTTPException(status_code=403,
                                detail="Please verify your email to activate your account. Check your inbox for the activation link.")
        token = _new_token(con, row["id"])
        user = {"id": row["id"], "email": row["email"], "full_name": row["full_name"],
                "is_admin": _is_admin(row["email"])}
    return {"token": token, "user": user}


@router.post("/logout")
def logout(authorization: Optional[str] = Header(None)):
    token = _token_from_header(authorization)
    if token:
        with get_pg() as con:
            con.execute("DELETE FROM auth_tokens WHERE token = %s", (token,))
    return {"status": "logged_out"}


@router.get("/me")
def me(user: dict = Depends(get_current_user)):
    return {"user": user}


class ProfileUpdate(BaseModel):
    full_name: Optional[str] = None
    email: Optional[str] = None

    @field_validator("email")
    @classmethod
    def _valid_email(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        v = v.strip().lower()
        if not _EMAIL_RE.match(v):
            raise ValueError("Enter a valid email address")
        return v


class PasswordChange(BaseModel):
    current_password: str
    new_password: str

    @field_validator("new_password")
    @classmethod
    def _min_len(cls, v: str) -> str:
        if len(v) < 8:
            raise ValueError("New password must be at least 8 characters")
        return v


@router.put("/profile")
def update_profile(req: ProfileUpdate, user: dict = Depends(get_current_user)):
    with get_pg() as con:
        if req.email and req.email != user["email"]:
            taken = con.execute(
                "SELECT 1 FROM users WHERE email = %s AND id != %s", (req.email, user["id"])
            ).fetchone()
            if taken:
                raise HTTPException(status_code=409, detail="That email is already in use")
        fields, vals = [], []
        if req.email is not None:
            fields.append("email = %s"); vals.append(req.email)
        if req.full_name is not None:
            fields.append("full_name = %s"); vals.append(req.full_name.strip() or None)
        if fields:
            vals.append(user["id"])
            con.execute(f"UPDATE users SET {', '.join(fields)} WHERE id = %s", vals)
        row = con.execute(
            "SELECT id, email, full_name FROM users WHERE id = %s", (user["id"],)
        ).fetchone()
    return {"user": {"id": row["id"], "email": row["email"], "full_name": row["full_name"]}}


@router.post("/change-password")
def change_password(req: PasswordChange, user: dict = Depends(get_current_user)):
    with get_pg() as con:
        row = con.execute(
            "SELECT password_hash FROM users WHERE id = %s", (user["id"],)
        ).fetchone()
        if not row or not verify_password(req.current_password, row["password_hash"]):
            raise HTTPException(status_code=403, detail="Current password is incorrect")
        con.execute(
            "UPDATE users SET password_hash = %s WHERE id = %s",
            (hash_password(req.new_password), user["id"]),
        )
    return {"status": "password_changed"}


# ---- Email verification + password reset ----

class ResetPassword(BaseModel):
    token: str
    new_password: str

    @field_validator("new_password")
    @classmethod
    def _min_len(cls, v: str) -> str:
        if len(v) < 8:
            raise ValueError("New password must be at least 8 characters")
        return v


@router.post("/activate")
def activate(token: str = Body(..., embed=True)):
    """Verify an emailed activation token, mark the account active, and return a
    session so the link logs the user in."""
    with get_pg() as con:
        user_id = _consume_email_token(con, token, "activate")
        if not user_id:
            raise HTTPException(status_code=400, detail="This activation link is invalid or has expired.")
        con.execute("UPDATE users SET activated = 1 WHERE id = %s", (user_id,))
        row = con.execute("SELECT id, email, full_name FROM users WHERE id = %s", (user_id,)).fetchone()
        session = _new_token(con, user_id)
    mailer.send_welcome(row["email"], row["full_name"])
    return {"token": session, "user": {"id": row["id"], "email": row["email"],
                                       "full_name": row["full_name"], "is_admin": _is_admin(row["email"])}}


@router.post("/resend-activation")
def resend_activation(email: str = Body(..., embed=True)):
    """Resend the activation email. Always returns ok (never reveals whether the
    address exists)."""
    email = (email or "").lower().strip()
    send = None
    with get_pg() as con:
        row = con.execute("SELECT id, full_name, activated FROM users WHERE email = %s", (email,)).fetchone()
        if row and not row["activated"] and mailer.MAIL_ENABLED:
            tok = _new_email_token(con, row["id"], "activate", 48)
            send = (email, tok, row["full_name"])
    if send:
        mailer.send_activation(*send)
    return {"status": "sent"}


@router.post("/forgot-password")
def forgot_password(email: str = Body(..., embed=True)):
    """Email a password-reset link. Always returns ok (never reveals whether the
    address exists)."""
    email = (email or "").lower().strip()
    send = None
    with get_pg() as con:
        row = con.execute("SELECT id, full_name FROM users WHERE email = %s", (email,)).fetchone()
        if row:
            tok = _new_email_token(con, row["id"], "reset", 1)  # 1-hour expiry
            send = (email, tok, row["full_name"])
    if send:
        mailer.send_password_reset(*send)
    return {"status": "sent"}


@router.post("/reset-password")
def reset_password(req: ResetPassword):
    with get_pg() as con:
        user_id = _consume_email_token(con, req.token, "reset")
        if not user_id:
            raise HTTPException(status_code=400, detail="This reset link is invalid or has expired.")
        con.execute("UPDATE users SET password_hash = %s WHERE id = %s",
                    (hash_password(req.new_password), user_id))
    return {"status": "password_reset"}
