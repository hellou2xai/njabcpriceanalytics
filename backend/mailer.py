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

import base64
import os
import httpx

RESEND_API_KEY = os.getenv("RESEND_API_KEY", "").strip()
MAIL_FROM = os.getenv("MAIL_FROM", "CELR <noreply@celr.ai>")
APP_BASE_URL = os.getenv("APP_BASE_URL", "https://nj.celr.ai").rstrip("/")
MAIL_ENABLED = bool(RESEND_API_KEY)

_RESEND_URL = "https://api.resend.com/emails"


def _send(to: str, subject: str, html: str,
          attachments: list[dict] | None = None,
          reply_to: str | None = None,
          cc: list[str] | None = None) -> bool:
    if not MAIL_ENABLED:
        print(f"[mail disabled] would send to {to}: {subject}")
        return False
    try:
        payload = {"from": MAIL_FROM, "to": [to], "subject": subject, "html": html}
        if attachments:
            payload["attachments"] = attachments
        if reply_to:
            payload["reply_to"] = reply_to
        if cc:
            payload["cc"] = cc
        r = httpx.post(
            _RESEND_URL,
            headers={"Authorization": f"Bearer {RESEND_API_KEY}"},
            json=payload,
            timeout=20,
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


def send_purchase_order(to: str, *, po_number: str, order_name: str,
                        buyer_name: str, distributor: str, pdf_bytes: bytes,
                        order_html: str = "", rep_name: str | None = None,
                        reply_to: str | None = None, cc: list[str] | None = None) -> bool:
    """Email a purchase order to a sales rep. The full order is written into the
    email body as a formatted summary (so the rep can read it without opening
    anything) AND attached as a PDF. Returns True only if Resend accepted the
    message. reply_to is set to the buyer so the rep can reply straight back."""
    greeting = f"Hi {rep_name}," if rep_name else "Hello,"
    body = (
        f"<p>{greeting}</p>"
        f"<p>{buyer_name} has submitted purchase order <strong>{po_number}</strong> "
        f"for {distributor}. The full order is below, and also attached as a PDF.</p>"
        f"{order_html}"
        f"<p style='margin-top:14px'>Please confirm availability and pricing, then process the order. "
        f"Reply to this email to reach the buyer directly.</p>"
    )
    attachment = {
        "filename": f"PO-{po_number}.pdf",
        "content": base64.b64encode(pdf_bytes).decode("ascii"),
    }
    subject = f"Purchase Order {po_number} from {buyer_name}"
    return _send(to, subject, _layout(f"Purchase Order {po_number}", body),
                 attachments=[attachment], reply_to=reply_to, cc=cc)


def send_po_cancellation(to: str, *, po_number: str, prior_revision: int,
                         new_revision: int, buyer_name: str, distributor: str,
                         rep_name: str | None = None, reply_to: str | None = None) -> bool:
    """Tell the rep a previously sent PO revision is cancelled because a revised
    version is being sent. Plain notice, no attachment."""
    greeting = f"Hi {rep_name}," if rep_name else "Hello,"
    body = (
        f"<p>{greeting}</p>"
        f"<p>Please disregard purchase order <strong>{po_number} (Revision {prior_revision})</strong> "
        f"for {distributor} from {buyer_name}. It has been cancelled.</p>"
        f"<p>A revised order, <strong>{po_number} (Revision {new_revision})</strong>, is being sent now and "
        f"replaces it. Please process only the revised version.</p>"
    )
    subject = f"CANCELLED: Purchase Order {po_number} (Rev {prior_revision}) from {buyer_name}"
    return _send(to, subject, _layout(f"Purchase Order {po_number} cancelled", body), reply_to=reply_to)
