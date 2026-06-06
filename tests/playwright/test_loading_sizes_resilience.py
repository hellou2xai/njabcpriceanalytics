"""Resilience: when the variant-upcs OPTIMISATION call fails (500), the detail
page must STILL load sizes via the name fallback — never hang on 'Loading
sizes...' forever. Proves the architecture fix.
Run: python tests/playwright/test_loading_sizes_resilience.py
"""
import json, sys, requests
from playwright.sync_api import sync_playwright

API="http://127.0.0.1:8000"; WEB="http://localhost:5173"
tok=requests.post(f"{API}/api/auth/login",json={"email":"sambit.tripathy@gmail.com","password":"Cuttack10!"},timeout=20).json()
token,user=tok["token"],tok["user"]

W="allied"; N="GLENLIVET 12YR"
url=f"{WEB}/product?w={W}&n={N.replace(' ','%20')}"

with sync_playwright() as pw:
    b=pw.chromium.launch(headless=True); ctx=b.new_context(viewport={"width":1600,"height":1000})
    ctx.add_init_script(
        f"localStorage.setItem('lpb_auth_token', {json.dumps(token)});"
        f"localStorage.setItem('lpb_auth_user', {json.dumps(json.dumps(user))});"
        "localStorage.setItem('celr_welcome_tour_never','1');"
        "localStorage.setItem('celr_cookie_consent','{\"necessary\":true,\"analytics\":false}');")
    page=ctx.new_page()
    # Force the OPTIMISATION call to fail — the page must degrade, not hang.
    page.route("**/product-variant-upcs/**", lambda r: r.fulfill(status=500, body="boom"))
    page.goto(url, wait_until="domcontentloaded")
    page.wait_for_timeout(800)
    page.evaluate("document.querySelector('.cc')?.remove()")
    cleared=False
    for _ in range(40):
        page.wait_for_timeout(500)
        if page.locator(".pd-loading").count()==0:
            cleared=True; break
    size_els=page.locator("[class*='pd-size']").count()
    ctx.close(); b.close()

print("== variant-upcs forced to 500 ==")
print("  Loading-sizes cleared:", cleared)
print("  pd-size els:", size_els)
# Pass = no infinite spinner AND sizes rendered via the name fallback.
ok = cleared and size_els>0
print("RESULT:", "PASS (degrades gracefully)" if ok else "FAIL (hung or empty)")
sys.exit(0 if ok else 1)
