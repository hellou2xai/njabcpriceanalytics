"""
Production smoke QA against https://nj.celr.ai (Playwright, headless).

Logs in with the owner account, visits every protected route, and reports:
  - JavaScript console errors / page exceptions
  - failed network calls (HTTP >= 400) to our own API
  - routes whose app shell never rendered (blank / crashed page)

It is intentionally deterministic (no LLM calls). Drive the assistant separately
if you want to exercise the chat. Exit code 0 = clean, 1 = problems found.

Run:  python tests/playwright/qa_prod_smoke.py
"""
import json
import sys

import requests
from playwright.sync_api import sync_playwright

BASE = "https://nj.celr.ai"
EMAIL = "sambit.tripathy@gmail.com"
PASSWORD = "Cuttack10!"

ROUTES = [
    "/", "/catalog", "/assistant", "/new-items", "/time-sensitive",
    "/price-drops", "/price-increases", "/major-discounts", "/discounts",
    "/clearance", "/combos", "/rips", "/rip-products", "/analytics",
    "/watchlist", "/orders", "/alerts",
]

# Console noise that isn't a real defect.
IGNORE_SUBSTR = ("favicon", "Download the React DevTools", "ResizeObserver loop")


def login() -> tuple[str, dict]:
    r = requests.post(f"{BASE}/api/auth/login",
                      json={"email": EMAIL, "password": PASSWORD}, timeout=30)
    r.raise_for_status()
    b = r.json()
    return b["token"], b["user"]


def main() -> int:
    print(f"[ready] {requests.get(f'{BASE}/api/ready', timeout=30).text[:80]}")
    token, user = login()
    problems: list[str] = []

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        ctx = browser.new_context(viewport={"width": 1500, "height": 1000})
        ctx.add_init_script(
            f"localStorage.setItem('lpb_auth_token', {json.dumps(token)});"
            f"localStorage.setItem('lpb_auth_user', {json.dumps(json.dumps(user))});"
            "localStorage.setItem('celr_welcome_tour_never', '1');"
        )
        page = ctx.new_page()

        cur = {"route": ""}
        errors: list[str] = []
        bad_api: list[str] = []

        def on_console(msg):
            if msg.type == "error" and not any(s in msg.text for s in IGNORE_SUBSTR):
                errors.append(f"[{cur['route']}] console: {msg.text[:200]}")

        def on_pageerror(exc):
            errors.append(f"[{cur['route']}] pageerror: {str(exc)[:200]}")

        def on_response(resp):
            if "/api/" in resp.url and resp.status >= 400:
                bad_api.append(f"[{cur['route']}] {resp.status} {resp.url}")

        page.on("console", on_console)
        page.on("pageerror", on_pageerror)
        page.on("response", on_response)

        for route in ROUTES:
            cur["route"] = route
            try:
                page.goto(f"{BASE}{route}", wait_until="networkidle", timeout=45000)
            except Exception as e:
                problems.append(f"[{route}] navigation failed: {type(e).__name__}")
                continue
            # App shell present? (the sidebar / main content render for any signed-in route)
            try:
                page.locator("body").wait_for(state="visible", timeout=5000)
                txt = (page.locator("body").inner_text(timeout=5000) or "").strip()
                if len(txt) < 40:
                    problems.append(f"[{route}] page looks blank ({len(txt)} chars)")
            except Exception as e:
                problems.append(f"[{route}] shell check failed: {type(e).__name__}")
            print(f"[ok] {route}")

        ctx.close()
        browser.close()

    problems = problems + errors + bad_api
    print("\n========== QA RESULT ==========")
    if problems:
        print(f"FAIL — {len(problems)} issue(s):")
        for p in problems:
            print("  -", p)
        return 1
    print("PASS — all routes rendered, no console errors or API failures.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
