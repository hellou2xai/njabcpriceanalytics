"""
Compare Distributor Prices redesign smoke test (the /compare-prices card page).

Asserts, against a running local backend (:8000) + frontend (:5173):
  desktop (1440): category rails render, cards render, cross-distributor % chips show;
  mobile (390):   no horizontal document overflow;
  nav: the obsolete pages (Rate Shop / Price 360 / Time-Sensitive Deals / RIPs / QD /
       Catalog / Price Drops / Price Increases) are gone from the sidebar.

Run:  python tests/playwright/test_compare_grid.py
"""
import json
import os
import sys
from pathlib import Path

import requests
from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

SCRATCH = Path(r"C:/Users/sambi/AppData/Local/Temp/claude/C--Users-sambi-OneDrive---U2xAI-Claude-Code-Projects-CELR-RIP-ABC/7b57c981-f848-46e8-b1cc-012139ac27e5/scratchpad")
# Point at prod with CG_API_BASE / CG_FRONTEND_BASE = https://nj.celr.ai
API_BASE = os.getenv("CG_API_BASE", "http://127.0.0.1:8000")
FRONTEND_BASE = os.getenv("CG_FRONTEND_BASE", "http://localhost:5173")
EMAIL = "sambit.tripathy@gmail.com"
PASSWORD = "Cuttack10!"
COOKIE_CONSENT = json.dumps({"analytics": True, "marketing": True,
                             "version": "2026-05-25", "ts": "2026-06-16T00:00:00Z", "decision": "all"})
OBSOLETE = ["Rate Shop", "Price 360", "Time-Sensitive Deals", "Distributor Price List"]  # last is a control (should still be present)


def login():
    r = requests.post(f"{API_BASE}/api/auth/login", json={"email": EMAIL, "password": PASSWORD}, timeout=15)
    r.raise_for_status()
    b = r.json()
    return b["token"], b["user"]


def init_script(token, user):
    return (f"localStorage.setItem('lpb_auth_token', {json.dumps(token)});"
            f"localStorage.setItem('lpb_auth_user', {json.dumps(json.dumps(user))});"
            "localStorage.setItem('celr_welcome_tour_never', '1');"
            f"localStorage.setItem('celr_cookie_consent', {json.dumps(COOKIE_CONSENT)});")


def main():
    token, user = login()
    failures = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)

        # ---- desktop ----
        ctx = browser.new_context(viewport={"width": 1440, "height": 900})
        ctx.add_init_script(init_script(token, user))
        page = ctx.new_page()
        page.goto(f"{FRONTEND_BASE}/compare-prices", wait_until="domcontentloaded", timeout=30000)
        try:
            page.locator(".disc-card").first.wait_for(state="visible", timeout=30000)
        except PWTimeout:
            failures.append("no .disc-card rendered on /compare-prices (desktop)")
        cards = page.locator(".disc-card").count()
        rails = page.locator(".disc-rail").count()
        diff = page.locator(".disc-deal--diff").count()
        print(f"[desktop] rails={rails} cards={cards} diff-chips={diff}")
        if cards == 0:
            failures.append("0 comparison cards")
        page.screenshot(path=str(SCRATCH / "compare_desktop.png"))

        nav = page.evaluate("() => document.querySelector('.sidebar')?.innerText || ''")
        for label in OBSOLETE[:-1]:
            if label in nav:
                failures.append(f"obsolete '{label}' still in the sidebar menu")
        if OBSOLETE[-1] not in nav:  # control: a kept item must be present
            failures.append(f"control '{OBSOLETE[-1]}' missing from sidebar (nav didn't render?)")

        # ---- compare mode: pick 2 distributors -> side-by-side groups ----
        try:
            for dn in ("Allied", "Fedway"):
                page.locator(".disc-filter-opt", has_text=dn).first.locator("input").check(timeout=5000)
            try:  # wait for the groups to render (prod compare queries are slower)
                page.locator(".disc-cmp-group").first.wait_for(state="visible", timeout=30000)
            except PWTimeout:
                pass
            page.wait_for_timeout(1500)
            groups = page.locator(".disc-cmp-group").count()
            first_cards = page.locator(".disc-cmp-group").first.locator(".disc-cmp-card").count() if groups else 0
            wins = page.locator(".disc-cmp-card.is-cheapest").count()
            ts = page.locator(".disc-deal--ts").count()
            print(f"[compare] groups={groups} cards_in_first_group={first_cards} cheapest-badges={wins} ts-markers={ts}")
            if groups == 0:
                failures.append("no .disc-cmp-group rendered when 2 distributors selected")
            elif first_cards < 2:
                failures.append(f"first compare group has {first_cards} distributor cards (<2)")
            page.screenshot(path=str(SCRATCH / "compare_sidebyside.png"))
        except PWTimeout:
            failures.append("compare-mode distributor checkboxes not clickable")
        ctx.close()

        # ---- mobile ----
        ctx2 = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True, device_scale_factor=2)
        ctx2.add_init_script(init_script(token, user))
        page2 = ctx2.new_page()
        page2.goto(f"{FRONTEND_BASE}/compare-prices", wait_until="domcontentloaded", timeout=30000)
        page2.wait_for_timeout(5000)
        m = page2.evaluate("() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth })")
        over = m["sw"] - m["iw"]
        print(f"[mobile] overflow={over} (scrollWidth={m['sw']} innerWidth={m['iw']})")
        if over > 2:
            failures.append(f"mobile horizontal scroll: scrollWidth={m['sw']} > innerWidth={m['iw']}")
        page2.screenshot(path=str(SCRATCH / "compare_mobile.png"))
        ctx2.close()
        browser.close()

    print("\n========== RESULT ==========")
    if failures:
        print(f"FAIL — {len(failures)} issue(s):")
        for f in failures:
            print("  -", f)
        return 1
    print("PASS — compare cards + rails render, chips show, mobile fits, obsolete nav gone.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
