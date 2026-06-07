"""Compare Prices page: picker, summary scoreboard, 3-layer grid, winner
highlighting, deal-flip badge, expandable side-by-side QD/RIP ladders.
Run: python tests/playwright/test_compare_prices.py  (backend on 8124 by
default; override with API/WEB env vars)
"""
import json, os, sys, requests
from playwright.sync_api import sync_playwright

API = os.environ.get("API", "http://127.0.0.1:8124")
WEB = os.environ.get("WEB", "http://localhost:5199")
tok = requests.post(f"{API}/api/auth/login",
                    json={"email": "sambit.tripathy@gmail.com", "password": "Cuttack10!"},
                    timeout=20).json()
token, user = tok["token"], tok["user"]

res = {}
with sync_playwright() as pw:
    b = pw.chromium.launch(headless=True)
    ctx = b.new_context(viewport={"width": 1700, "height": 1100})
    ctx.add_init_script(
        f"localStorage.setItem('lpb_auth_token', {json.dumps(token)});"
        f"localStorage.setItem('lpb_auth_user', {json.dumps(json.dumps(user))});"
        "localStorage.setItem('celr_welcome_tour_never','1');"
        "localStorage.setItem('celr_cookie_consent','{\"necessary\":true,\"analytics\":false}');")
    page = ctx.new_page()
    page.goto(f"{WEB}/compare-prices?d=kramer,shore_point", wait_until="domcontentloaded")
    page.wait_for_timeout(600)
    page.evaluate("document.querySelector('.cc')?.remove()")
    try:
        page.locator("table.cmp-table tbody tr").first.wait_for(state="visible", timeout=30000)
        res["grid"] = True
        res["rows"] = page.locator("table.cmp-table tbody tr").count()
        res["picker_chips"] = page.locator(".cmp-chip").count()
        res["cards"] = page.locator(".cmp-card").count()
        res["insights"] = page.locator(".cmp-insight").count()
        res["winner_cells"] = page.locator("td.cmp-win").count()
        res["flip_badges"] = page.locator(".cmp-flip").count()
        # expand first row -> side-by-side ladders
        page.locator("table.cmp-table tbody tr").first.click()
        page.locator(".cmp-ladder").first.wait_for(state="visible", timeout=20000)
        res["ladders"] = page.locator(".cmp-ladder").count()
        res["ladder_tiers"] = page.locator(".cmp-ladder-line").count()
        page.wait_for_timeout(400)
        page.screenshot(path="tests/playwright/_compare_prices.png", full_page=False)
        # add a third distributor -> grid re-renders with 3 column groups
        page.locator(".cmp-chip", has_text="Peerless").click()
        page.wait_for_timeout(2500)
        res["three_way_groups"] = page.locator("th.cmp-group-head").count()
        page.screenshot(path="tests/playwright/_compare_prices_3way.png", full_page=False)
    except Exception as e:
        res["error"] = f"{type(e).__name__}: {e}"
        page.screenshot(path="tests/playwright/_compare_prices_err.png", full_page=True)
    ctx.close(); b.close()

print("== compare prices ==")
for k, v in res.items():
    print(f"  {k}: {v}")
ok = (res.get("grid") and (res.get("rows") or 0) > 5 and (res.get("winner_cells") or 0) > 0
      and (res.get("ladders") or 0) >= 2 and res.get("three_way_groups") == 3)
print("RESULT:", "PASS" if ok else "CHECK ABOVE")
sys.exit(0 if ok else 1)
