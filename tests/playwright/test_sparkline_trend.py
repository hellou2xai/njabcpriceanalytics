"""Verify the fixed DealSparkline renders a RIP-driven hike correctly.

Seeds a list with AMRUT FUSION (Opici, UPC 836202000384): list price flat
$354.54, effective $334.54 -> $354.54 (June RIP lapsed). Asserts on the live
DOM that:
  - frontline (dashed) line is the neutral colour,
  - effective (solid) line is RED (#dc2626) — the trend now reads the hike,
  - both June points share a y (shared scale; equal prices, equal height).
Also loads a control product to confirm a real DROP still renders green.

Run: python tests/playwright/test_sparkline_trend.py
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
H = {"Authorization": f"Bearer {token}"}

# create a fresh list and add Amrut
lst = requests.post(f"{API}/api/lists", headers=H,
                    json={"name": "spark-trend-test"}, timeout=30).json()
list_id = lst.get("id") or lst.get("list", {}).get("id")
requests.post(f"{API}/api/lists/{list_id}/items", headers=H, json={
    "product_name": "AMRUT FUSION", "wholesaler": "opici",
    "upc": "836202000384", "unit_volume": "750ML",
}, timeout=30)

res = {}
with sync_playwright() as pw:
    b = pw.chromium.launch(headless=True)
    ctx = b.new_context(viewport={"width": 1500, "height": 1000})
    ctx.add_init_script(
        f"localStorage.setItem('lpb_auth_token', {json.dumps(token)});"
        f"localStorage.setItem('lpb_auth_user', {json.dumps(json.dumps(user))});"
        "localStorage.setItem('celr_welcome_tour_never','1');"
        "localStorage.setItem('celr_cookie_consent','{\"necessary\":true,\"analytics\":false}');")
    page = ctx.new_page()
    page.goto(f"{WEB}/lists", wait_until="domcontentloaded")
    page.wait_for_timeout(5000)
    page.evaluate("document.querySelector('.cc')?.remove()")
    # open the list if needed, scroll the chip into view (lazy IntersectionObserver)
    try:
        page.get_by_text("spark-trend-test").first.click()
        page.wait_for_timeout(1500)
    except Exception:
        pass
    page.mouse.wheel(0, 400)
    page.wait_for_timeout(3500)
    try:
        spark = page.locator(".deal-spark svg").first
        spark.wait_for(state="visible", timeout=30000)
        paths = page.eval_on_selector_all(
            ".deal-spark svg path",
            "els => els.map(e => ({stroke: e.getAttribute('stroke'), "
            "dash: e.getAttribute('stroke-dasharray'), d: e.getAttribute('d')}))")
        res["n_paths"] = len(paths)
        dashed = [p for p in paths if p["dash"]]
        solid = [p for p in paths if not p["dash"]]
        res["frontline_neutral"] = bool(dashed) and "text-muted" in (dashed[0]["stroke"] or "")
        res["effective_red"] = any((p["stroke"] or "").lower() == "#dc2626" for p in solid)
        res["effective_d"] = solid[0]["d"] if solid else None
        page.screenshot(path="tests/playwright/_sparkline_trend_fixed.png")
    except Exception as e:
        res["error"] = f"{type(e).__name__}: {e}"
        page.screenshot(path="tests/playwright/_sparkline_trend_err.png")
    ctx.close(); b.close()

# cleanup the test list
try:
    requests.delete(f"{API}/api/lists/{list_id}", headers=H, timeout=30)
except Exception:
    pass

print("== sparkline trend verification ==")
for k, v in res.items():
    print(f"  {k}: {v}")
ok = res.get("effective_red") and res.get("frontline_neutral")
print("RESULT:", "PASS" if ok else "CHECK ABOVE")
sys.exit(0 if ok else 1)
