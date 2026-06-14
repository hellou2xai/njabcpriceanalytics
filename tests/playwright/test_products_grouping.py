"""Verify the Products-page 'Group products' toggle (off by default).

Off (default): one card per distributor + size, UPC variants collapsed to the
best price (Fedway Casal White Verde regular $68 + old-lot $52 -> one $52 row
badged 'best of N'). On: cross-distributor family cards return.

Run: python tests/playwright/test_products_grouping.py
"""
import json
import sys

import requests
from playwright.sync_api import sync_playwright

API = "http://127.0.0.1:8000"
WEB = "http://localhost:5173"

tok = requests.post(f"{API}/api/auth/login",
                    json={"email": "sambit.tripathy@gmail.com",
                          "password": "Cuttack10!"}, timeout=30).json()
token, user = tok["token"], tok["user"]

res = {}
with sync_playwright() as pw:
    b = pw.chromium.launch(headless=True)
    ctx = b.new_context(viewport={"width": 1600, "height": 1000})
    ctx.add_init_script(
        f"localStorage.setItem('lpb_auth_token', {json.dumps(token)});"
        f"localStorage.setItem('lpb_auth_user', {json.dumps(json.dumps(user))});"
        "localStorage.setItem('celr_welcome_tour_never','1');"
        "localStorage.setItem('celr_cookie_consent','{\"necessary\":true,\"analytics\":false}');")
    page = ctx.new_page()
    page.goto(f"{WEB}/products?q=casal garcia", wait_until="domcontentloaded")
    page.wait_for_timeout(6000)
    page.evaluate("document.querySelector('.cc')?.remove()")
    try:
        page.locator(".prod-card").first.wait_for(timeout=30000)
        # default OFF
        res["toggle_checked_default"] = page.locator(".products-group-toggle input").is_checked()
        res["header_default"] = page.locator(".products-showing").inner_text().replace("\n", " ")
        res["cards_default"] = page.locator(".prod-card").count()
        res["sold_by_default"] = page.get_by_text("Sold by", exact=False).count()
        res["collapse_badges"] = page.locator(".prod-card-collapsed").count()
        page.screenshot(path="tests/playwright/_products_ungrouped.png")
        # turn grouping ON
        page.locator(".products-group-toggle input").check()
        page.wait_for_timeout(2500)
        res["header_grouped"] = page.locator(".products-showing").inner_text().replace("\n", " ")
        res["cards_grouped"] = page.locator(".prod-card").count()
        res["sold_by_grouped"] = page.get_by_text("Sold by", exact=False).count()
        page.screenshot(path="tests/playwright/_products_grouped.png")
    except Exception as e:
        res["error"] = f"{type(e).__name__}: {e}"
        page.screenshot(path="tests/playwright/_products_grouping_err.png")
    ctx.close(); b.close()

print("== Products grouping toggle verification ==")
print(json.dumps(res, indent=2, default=str))
ok = (res.get("toggle_checked_default") is False
      and "listing" in (res.get("header_default") or "")
      and "by size" in (res.get("header_default") or "")
      and "product" in (res.get("header_grouped") or "")
      and res.get("cards_default", 0) >= res.get("cards_grouped", 0)
      and "error" not in res)
print("RESULT:", "PASS" if ok else "CHECK ABOVE")
sys.exit(0 if ok else 1)
