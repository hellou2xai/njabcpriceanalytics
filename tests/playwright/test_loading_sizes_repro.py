"""Repro: Product detail 'Loading sizes...' that never clears.
Captures the network requests to product-variant-upcs/search + console errors,
and reports whether the Deals panel still shows 'Loading sizes' after a wait.
Run: python tests/playwright/test_loading_sizes_repro.py
"""
import json, sys, requests
from playwright.sync_api import sync_playwright

API="http://127.0.0.1:8000"; WEB="http://localhost:5173"
tok=requests.post(f"{API}/api/auth/login",json={"email":"sambit.tripathy@gmail.com","password":"Cuttack10!"},timeout=20).json()
token,user=tok["token"],tok["user"]

# Product under test (from the screenshots).
W="allied"; N="GLENLIVET 12YR"
url=f"{WEB}/product?w={W}&n={N.replace(' ','%20')}"

net=[]; errs=[]
with sync_playwright() as pw:
    b=pw.chromium.launch(headless=True); ctx=b.new_context(viewport={"width":1600,"height":1000})
    ctx.add_init_script(
        f"localStorage.setItem('lpb_auth_token', {json.dumps(token)});"
        f"localStorage.setItem('lpb_auth_user', {json.dumps(json.dumps(user))});"
        "localStorage.setItem('celr_welcome_tour_never','1');"
        "localStorage.setItem('celr_cookie_consent','{\"necessary\":true,\"analytics\":false}');")
    page=ctx.new_page()
    page.on("console", lambda m: errs.append(f"{m.type}: {m.text}") if m.type in ("error","warning") else None)
    page.on("requestfailed", lambda r: net.append(f"FAILED {r.url} :: {r.failure}"))
    def on_resp(r):
        if "product-variant-upcs" in r.url or "/catalog/search" in r.url:
            net.append(f"{r.status} {r.url[:140]}")
    page.on("response", on_resp)
    page.goto(url, wait_until="domcontentloaded")
    page.wait_for_timeout(800)
    page.evaluate("document.querySelector('.cc')?.remove()")
    # Wait up to 15s for 'Loading sizes' to disappear.
    cleared=False
    for _ in range(30):
        page.wait_for_timeout(500)
        txt=page.locator(".pd-loading").count()
        if txt==0:
            cleared=True; break
    still=page.locator(".pd-loading").count()
    size_rows=page.locator(".pd-size-sec, .pd-size, [class*='size']").count()
    ctx.close(); b.close()

print("== network (variant-upcs / search) ==")
for n in net: print("  ", n)
print("== console errors/warnings ==")
for e in errs[:20]: print("  ", e)
print("== result ==")
print("  Loading-sizes cleared:", cleared, " | still showing:", still, " | size-ish els:", size_rows)
sys.exit(0 if cleared else 1)
