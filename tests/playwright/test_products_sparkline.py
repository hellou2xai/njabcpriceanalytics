"""Verify the Products-page sparkline (PriceSparklines) shows a lapsed-RIP hike.

AMRUT FUSION (Opici, UPC 836202000384) had a RIP in Apr/May (effective $334.54)
and none in June (effective back to list $354.54). The RIP row used to null
June and read "-"; it must now show the climb back to $355 in red.

Run: python tests/playwright/test_products_sparkline.py
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
    page.goto(f"{WEB}/products?q=amrut", wait_until="domcontentloaded")
    page.wait_for_timeout(6000)
    page.evaluate("document.querySelector('.cc')?.remove()")
    try:
        page.get_by_text("Amrut Fusion", exact=False).first.wait_for(timeout=30000)
        page.wait_for_timeout(3500)  # let the lazy priceHistory fetch land
        # find the Amrut Fusion card's RIP sparkline row
        data = page.evaluate("""() => {
          const heads = [...document.querySelectorAll('*')].filter(
            e => e.children.length === 0 && /Amrut Fusion/i.test(e.textContent || ''));
          if (!heads.length) return {err: 'no heading'};
          let card = heads[0];
          for (let k = 0; k < 8 && card; k++) {
            if (card.querySelector('.psk-row')) break;
            card = card.parentElement;
          }
          if (!card) return {err: 'no card'};
          const rows = [...card.querySelectorAll('.psk-row')].map(r => ({
            tag: (r.querySelector('.psk-tag')||{}).textContent,
            val: (r.querySelector('.psk-val')||{}).textContent,
            stroke: (r.querySelector('polyline')||{}).getAttribute
                    ? r.querySelector('polyline')?.getAttribute('stroke') : null,
          }));
          return {rows};
        }""")
        res["data"] = data
        rip = next((r for r in data.get("rows", []) if (r.get("tag") or "").upper() == "RIP"), None)
        res["rip_row"] = rip
        if rip:
            res["rip_shows_value"] = "355" in (rip.get("val") or "")
            res["rip_is_red"] = "red" in (rip.get("stroke") or "").lower()
        page.screenshot(path="tests/playwright/_products_sparkline_fixed.png")
    except Exception as e:
        res["error"] = f"{type(e).__name__}: {e}"
        page.screenshot(path="tests/playwright/_products_sparkline_err.png")
    ctx.close(); b.close()

print("== Products-page sparkline verification (Amrut Fusion) ==")
print(json.dumps(res, indent=2, default=str))
ok = res.get("rip_shows_value") and res.get("rip_is_red")
print("RESULT:", "PASS" if ok else "CHECK ABOVE")
sys.exit(0 if ok else 1)
