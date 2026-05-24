"""
Transactional email via Resend.

If RESEND_API_KEY is not set, email is DISABLED: sends are logged and skipped so
local dev and the deploy keep working. Account activation is only enforced when
email is enabled (see auth.py), so a missing key never locks anyone out.

Env:
  RESEND_API_KEY   Resend API key. Empty -> email disabled.
  MAIL_FROM        From address, e.g. "CELR <noreply@celr.ai>" (must be a
                   verified Resend domain).
  APP_BASE_URL     Base URL for links in emails (default https://nj.celr.ai).
"""

import os
import httpx

RESEND_API_KEY = os.getenv("RESEND_API_KEY", "").strip()
MAIL_FROM = os.getenv("MAIL_FROM", "CELR <noreply@celr.ai>")
APP_BASE_URL = os.getenv("APP_BASE_URL", "https://nj.celr.ai").rstrip("/")
MAIL_ENABLED = bool(RESEND_API_KEY)

_RESEND_URL = "https://api.resend.com/emails"


def _send(to: str, subject: str, html: str) -> bool:
    if not MAIL_ENABLED:
        print(f"[mail disabled] would send to {to}: {subject}")
        return False
    try:
        r = httpx.post(
            _RESEND_URL,
            headers={"Authorization": f"Bearer {RESEND_API_KEY}"},
            json={"from": MAIL_FROM, "to": [to], "subject": subject, "html": html},
            timeout=15,
        )
        if r.status_code >= 400:
            print(f"[mail error] {r.status_code}: {r.text[:300]}")
            return False
        return True
    except Exception as e:  # never let an email failure break the request
        print(f"[mail error] {e}")
        return False


def _layout(title: str, body_html: str, cta_text: str = "", cta_url: str = "") -> str:
    cta = ""
    if cta_text and cta_url:
        cta = (f'<a href="{cta_url}" style="display:inline-block;background:#2563eb;'
               f'color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;'
               f'font-weight:600">{cta_text}</a>'
               f'<p style="font-size:12px;color:#64748b;margin-top:14px">'
               f'Or paste this link into your browser:<br>{cta_url}</p>')
    return f"""<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#0f172a">
      <h2 style="color:#2563eb;margin:0 0 4px">CELR Retail Pricing Intelligence</h2>
      <h3 style="margin:16px 0 8px">{title}</h3>
      {body_html}
      <p style="margin:20px 0">{cta}</p>
      <p style="font-size:12px;color:#64748b">If you did not expect this email, you can safely ignore it.</p>
    </div>"""


def send_activation(to: str, token: str, name: str | None = None) -> bool:
    url = f"{APP_BASE_URL}/activate?token={token}"
    body = f"<p>Hi {name or 'there'}, confirm your email address to activate your account.</p>"
    return _send(to, "Activate your CELR account",
                 _layout("Confirm your email", body, "Activate account", url))


def send_welcome(to: str, name: str | None = None) -> bool:
    body = ("<p>Your account is active. Sign in to start finding the best NJ ABC "
            "wholesale deals across your distributors.</p>")
    title = f"Welcome{', ' + name if name else ''}"
    return _send(to, "Welcome to CELR Retail Pricing Intelligence",
                 _layout(title, body, "Open the app", APP_BASE_URL))


def send_password_reset(to: str, token: str, name: str | None = None) -> bool:
    url = f"{APP_BASE_URL}/reset-password?token={token}"
    body = "<p>We received a request to reset your password. This link expires in 1 hour.</p>"
    return _send(to, "Reset your CELR password",
                 _layout("Reset your password", body, "Reset password", url))
