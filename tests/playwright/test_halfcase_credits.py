"""Case-credit (half-case RIP rule) verification: API + UI.

Verifies (June 2026 data):
  1. Grand Marnier 375ML x12 (allied, "12PK 375ML & 200ML 24PK = 1/2 CASE"):
     compare/rips tiers carry case_credit 0.5, cases_to_unlock = 2x raw_qty.
  2. Don Q 1.75L (allied, "3PK 1.75L = 1/2 CASE" split rule): catalog tiers
     carry split_pack=3 and NO case_credit (full case counts full).
  3. Regression: a no-rule RIP product's tiers carry no credit fields;
     catalog search + products page still render.
  4. UI: Compare RIPs page shows the half-case badge for Grand Marnier.

Run: python tests/playwright/test_halfcase_credits.py
"""
import json
import sys

import requests
from playwright.sync_api import sync_playwright

API = "http://127.0.0.1:8000"
WEB = "http://localhost:5173"

res = {}
tok = requests.post(f"{API}/api/auth/login",
                    json={"email": "sambit.tripathy@gmail.com",
                          "password": "Cuttack10!"}, timeout=30).json()
token, user = tok["token"], tok["user"]
H = {"Authorization": f"Bearer {token}"}


def get(path, **params):
    r = requests.get(f"{API}{path}", headers=H, params=params, timeout=180)
    r.raise_for_status()
    return r.json()


# ---- 1) Grand Marnier: credit 0.5 via compare/rips
gm = get("/api/compare/rips", wholesalers="allied,fedway",
         q="grand marn", cases=5)
gm_tiers = []
for row in gm.get("rows", []):
    d = (row.get("dists") or {}).get("allied") or {}
    for t in d.get("rip_tiers") or []:
        if t.get("case_credit") == 0.5:
            gm_tiers.append(t)
res["gm_credit_tiers_found"] = len(gm_tiers)
res["gm_doubled_unlock"] = any(
    t.get("raw_qty") and t.get("cases_to_unlock") == 2 * t["raw_qty"]
    for t in gm_tiers)

# ---- 2) Don Q 1.75L split rule via catalog tiers (allied-only product, so
#         it never appears on the two-distributor compare grid). The LITER
#         sits under a different no-rule RIP (100311) — only the 1.75L
#         carries "3PK 1.75L = 1/2 CASE".
dq = get("/api/catalog/search", q="don q gold", include_tiers=True, limit=10)
dq_rip = [t for it in (dq.get("items") or [])
          if "DON Q" in (it.get("product_name") or "")
          and str(it.get("unit_volume") or "") == "1.75L"
          for t in (it.get("tiers") or []) if t.get("source") == "rip"]
res["dq_rip_tiers"] = len(dq_rip)
res["dq_split_carried"] = any(t.get("split_pack") == 3 for t in dq_rip)
res["dq_no_doubling"] = all(t.get("case_credit") in (None, 1, 1.0)
                            and t.get("qualified_cases") is None
                            for t in dq_rip)

# ---- 3) Regression: a NO-rule RIP product's tiers untouched. (Laphroaig
#         is a bad control — its 10Y 6PK genuinely has a half-case rule.)
lp = get("/api/catalog/search", q="bowmore", include_tiers=True, limit=20)
lp_rip = [t for it in (lp.get("items") or [])
          for t in (it.get("tiers") or []) if t.get("source") == "rip"]
res["regress_rip_tiers"] = len(lp_rip)
res["regress_no_credit_fields"] = all(
    t.get("case_credit") in (None, 1, 1.0) and not t.get("split_pack")
    for t in lp_rip)
res["catalog_rows"] = len(dq.get("items") or [])

# ---- 4) UI: Compare RIPs shows the half-case badge
with sync_playwright() as pw:
    b = pw.chromium.launch(headless=True)
    ctx = b.new_context(viewport={"width": 1700, "height": 1000})
    ctx.add_init_script(
        f"localStorage.setItem('lpb_auth_token', {json.dumps(token)});"
        f"localStorage.setItem('lpb_auth_user', {json.dumps(json.dumps(user))});"
        "localStorage.setItem('celr_welcome_tour_never','1');"
        "localStorage.setItem('celr_cookie_consent','{\"necessary\":true,\"analytics\":false}');")
    page = ctx.new_page()
    page.goto(f"{WEB}/compare-rips?d=allied,fedway&q=grand%20marn",
              wait_until="domcontentloaded")
    page.wait_for_timeout(6000)
    page.evaluate("document.querySelector('.cc')?.remove()")
    try:
        # tier ladders live in the expanded product detail — click the row
        head = page.locator(".rip2-product-head").first
        head.wait_for(state="visible", timeout=60000)
        head.click()
        page.locator(".rip2-tier-table").first.wait_for(state="visible", timeout=30000)
        res["ui_tier_tables"] = page.locator(".rip2-tier-table").count()
        res["ui_halfcase_badges"] = page.locator(".rip2-halfcase").count()
        page.screenshot(path="tests/playwright/_halfcase_compare_rips.png")
    except Exception as e:
        res["ui_error"] = f"{type(e).__name__}: {e}"
        page.screenshot(path="tests/playwright/_halfcase_compare_rips_err.png")
    # regression: products grid renders
    page.goto(f"{WEB}/products?q=laphroaig", wait_until="domcontentloaded")
    page.wait_for_timeout(4500)
    res["ui_products_ok"] = page.locator("text=LAPH").count() > 0 or \
        page.locator("[class*=grid], table").count() > 0
    ctx.close()
    b.close()

print("== half-case credit verification ==")
for k, v in res.items():
    print(f"  {k}: {v}")
ok = (res.get("gm_credit_tiers_found", 0) > 0 and res.get("gm_doubled_unlock")
      and res.get("dq_rip_tiers", 0) > 0 and res.get("dq_split_carried")
      and res.get("dq_no_doubling")
      and res.get("regress_rip_tiers", 0) > 0
      and res.get("regress_no_credit_fields")
      and res.get("catalog_rows", 0) > 0
      and res.get("ui_halfcase_badges", 0) > 0
      and res.get("ui_products_ok"))
print("RESULT:", "PASS" if ok else "CHECK ABOVE")
sys.exit(0 if ok else 1)
