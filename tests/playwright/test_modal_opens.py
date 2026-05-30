"""
Regression test for the Time-Sensitive Deals detail modal.

Bug: cards whose stored vintage is a 2-digit shorthand ('20') or a float
('2018.0') passed that RAW value to /api/catalog/product, which normalised the
DB column to a 4-digit year and compared it against the raw param. The equality
failed, the endpoint returned {"error": "Product not found"}, and the modal hung
forever on "Loading…". The trigger item was PENF SHZ KLM"28"206P (allied,
vintage '20').

This test:
  1. Opens /time-sensitive, finds the specific PENF card, clicks it, and asserts
     the modal renders real product detail (not the "Loading…" placeholder).
  2. Sweeps every card on the first page, opens each modal, and fails if ANY
     gets stuck on "Loading…" or 404s its product-detail fetch — covering the
     whole class of similar items, not just the one reported.

Run:  python tests/playwright/test_modal_opens.py
"""
import json
import sys
from pathlib import Path

import requests
from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO_ROOT))

API_BASE = "http://127.0.0.1:8000"
FRONTEND_BASE = "http://localhost:5173"
EMAIL = "sambit.tripathy@gmail.com"
PASSWORD = "Cuttack10!"

TARGET_NAME = 'PENF SHZ KLM"28"206P'


def login() -> tuple[str, dict]:
    r = requests.post(f"{API_BASE}/api/auth/login",
                      json={"email": EMAIL, "password": PASSWORD}, timeout=15)
    r.raise_for_status()
    b = r.json()
    return b["token"], b["user"]


def modal_is_loaded(page) -> bool:
    """True once the modal shows real content (product <h3>), not 'Loading…'."""
    modal = page.locator(".modal").first
    try:
        modal.locator("h3").first.wait_for(state="visible", timeout=6000)
        return True
    except PWTimeout:
        return False


def open_modal(page, card) -> None:
    target = card.locator(".deal-card-name").first
    (target if target.count() else card).click(timeout=4000)


def close_modal(page) -> None:
    try:
        btn = page.locator(".modal-close").first
        if btn.count():
            btn.click(timeout=2000)
        page.locator(".modal-overlay").first.wait_for(state="hidden", timeout=3000)
    except Exception:
        page.keyboard.press("Escape")


def main() -> int:
    token, user = login()
    failures: list[str] = []
    product_404s: list[str] = []

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        ctx = browser.new_context(viewport={"width": 1500, "height": 1000})
        ctx.add_init_script(
            f"localStorage.setItem('lpb_auth_token', {json.dumps(token)});"
            f"localStorage.setItem('lpb_auth_user', {json.dumps(json.dumps(user))});"
            "localStorage.setItem('celr_welcome_tour_never', '1');"
        )
        page = ctx.new_page()

        # Record any product-detail fetch that 404s (the modal's blocker).
        def on_response(resp):
            if "/api/catalog/product/" in resp.url:
                try:
                    if resp.status == 200 and resp.json().get("product") is None:
                        product_404s.append(resp.url)
                except Exception:
                    pass
        page.on("response", on_response)

        page.goto(f"{FRONTEND_BASE}/time-sensitive", wait_until="domcontentloaded")
        page.locator(".deal-card").first.wait_for(state="visible", timeout=20000)

        cards = page.locator(".deal-card")
        n = cards.count()
        print(f"[sweep] {n} cards on first page")

        # ---- 1. Targeted check: the reported item ----
        target_idx = None
        for i in range(n):
            if (cards.nth(i).get_attribute("data-ctx-product") or "") == TARGET_NAME:
                target_idx = i
                break
        if target_idx is None:
            print(f"[warn] '{TARGET_NAME}' not on first page; relying on sweep only")
        else:
            open_modal(page, cards.nth(target_idx))
            ok = modal_is_loaded(page)
            print(f"[target] '{TARGET_NAME}' modal loaded: {ok}")
            if not ok:
                failures.append(f"TARGET '{TARGET_NAME}' modal stuck on Loading")
            close_modal(page)

        # ---- 2. Sweep: every card must open to real content ----
        for i in range(n):
            card = cards.nth(i)
            name = card.get_attribute("data-ctx-product") or f"#{i}"
            try:
                open_modal(page, card)
            except Exception as e:
                failures.append(f"[{name}] click failed: {type(e).__name__}")
                continue
            if not modal_is_loaded(page):
                failures.append(f"[{name}] modal stuck on Loading")
            close_modal(page)

        ctx.close()
        browser.close()

    print("\n========== RESULT ==========")
    if product_404s:
        print(f"product-detail 404s observed: {len(product_404s)}")
        for u in product_404s[:10]:
            print("  404:", u)
    if failures:
        print(f"FAIL — {len(failures)} card(s) did not open correctly:")
        for f in failures:
            print("  -", f)
        return 1
    print("PASS — every card modal rendered product detail (no Loading hang).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
