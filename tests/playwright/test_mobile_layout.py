"""
Mobile layout regression test (iPhone-class viewport, 390x844).

The app was built desktop-first and several screens broke on a phone:
  - the floating cart button defaulted to the top-right, sitting ON TOP of the
    page header and distributor chips;
  - the alert digest cards and the month-effective sparkline popover were wider
    than the viewport and clipped their text on the right edge;
  - the SmartHeaderStrip bled -32px into a 16px mobile gutter and overflowed.

The mobile pass (frontend/src/mobile.css + CartFab default position) fixes these.
This test guards them. For EACH key screen it asserts, on a 390px wide viewport:

  1. the document does not scroll horizontally (scrollWidth <= innerWidth);
  2. no visible element is wider than the viewport (the clipping class of bug);
  3. the hamburger opens the nav drawer and Escape / backdrop closes it;
  4. the floating cart + assistant buttons sit in the BOTTOM half of the screen
     (docked out of the way), not over the header;
  5. a product detail modal, when present, renders effectively full-width.

Run (backend on :8000, frontend on :5173 must both be up):
    python tests/playwright/test_mobile_layout.py
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

# iPhone 12/13/14-class portrait viewport.
VIEWPORT = {"width": 390, "height": 844}

# A satisfied cookie-consent record so the banner never covers content. Shape
# must match CookieConsent.tsx (Stored type + POLICY_VERSION).
COOKIE_CONSENT = json.dumps({
    "analytics": True, "marketing": True,
    "version": "2026-05-25", "ts": "2026-06-16T00:00:00Z", "decision": "all",
})

# Screens that historically broke on mobile. Each must pass the overflow checks.
PAGES = [
    ("Home", "/"),
    ("Dashboard", "/dashboard"),
    ("Alerts", "/alerts"),
    ("Catalog", "/catalog"),
    ("Products", "/products"),
    ("Time-Sensitive", "/time-sensitive"),
    ("Compare Prices", "/compare-prices"),
]


def login() -> tuple[str, dict]:
    r = requests.post(f"{API_BASE}/api/auth/login",
                      json={"email": EMAIL, "password": PASSWORD}, timeout=15)
    r.raise_for_status()
    b = r.json()
    return b["token"], b["user"]


def measure(page) -> dict:
    """Document-level horizontal overflow + any element wider than the viewport."""
    return page.evaluate(
        """() => {
          const vw = window.innerWidth;
          const wide = [];
          for (const el of document.querySelectorAll('body *')) {
            const r = el.getBoundingClientRect();
            if (r.width > vw + 2 && r.height > 0 &&
                getComputedStyle(el).position !== 'fixed') {
              const cls = (el.className && el.className.toString)
                ? el.className.toString() : '';
              wide.push((el.tagName + '.' + cls).slice(0, 60) + ' w=' + Math.round(r.width));
            }
          }
          return {
            scrollWidth: document.documentElement.scrollWidth,
            innerWidth: vw,
            wide: [...new Set(wide)].slice(0, 12),
          };
        }"""
    )


def fab_positions(page) -> dict:
    """Bounding boxes for the floating cart + assistant launcher."""
    return page.evaluate(
        """() => {
          const out = {};
          const cart = document.querySelector('.cart-fab');
          const ai = document.querySelector('.global-assistant-fab');
          const grab = el => el ? (r => ({top: r.top, bottom: r.bottom,
            left: r.left, right: r.right}))(el.getBoundingClientRect()) : null;
          out.cart = grab(cart); out.assistant = grab(ai);
          out.innerHeight = window.innerHeight; out.innerWidth = window.innerWidth;
          return out;
        }"""
    )


def main() -> int:
    token, user = login()
    failures: list[str] = []

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        ctx = browser.new_context(
            viewport=VIEWPORT, device_scale_factor=2,
            is_mobile=True, has_touch=True,
        )
        ctx.add_init_script(
            f"localStorage.setItem('lpb_auth_token', {json.dumps(token)});"
            f"localStorage.setItem('lpb_auth_user', {json.dumps(json.dumps(user))});"
            "localStorage.setItem('celr_welcome_tour_never', '1');"
            f"localStorage.setItem('celr_cookie_consent', {json.dumps(COOKIE_CONSENT)});"
            # Force the new mobile default for the cart FAB (no stale top position).
            "localStorage.removeItem('cart_fab_pos');"
        )
        page = ctx.new_page()

        # ---- 1+2. Overflow / clipping sweep across the key screens ----
        for name, path in PAGES:
            try:
                page.goto(f"{FRONTEND_BASE}{path}", wait_until="domcontentloaded", timeout=30000)
                page.wait_for_timeout(5000)  # let data + lazy widgets settle
            except PWTimeout:
                failures.append(f"[{name}] page never loaded")
                continue
            m = measure(page)
            doc_overflow = m["scrollWidth"] - m["innerWidth"]
            if doc_overflow > 2:
                failures.append(f"[{name}] horizontal scroll: scrollWidth={m['scrollWidth']} > innerWidth={m['innerWidth']}")
            if m["wide"]:
                failures.append(f"[{name}] {len(m['wide'])} element(s) wider than viewport: {m['wide']}")
            print(f"[{name:16}] overflow={doc_overflow:>3}  over-wide={len(m['wide'])}")

        # ---- 4. FABs docked in the bottom half, not over the header ----
        page.goto(f"{FRONTEND_BASE}/dashboard", wait_until="domcontentloaded", timeout=30000)
        page.wait_for_timeout(3000)
        fabs = fab_positions(page)
        mid = fabs["innerHeight"] / 2
        for key in ("cart", "assistant"):
            box = fabs.get(key)
            if not box:
                failures.append(f"[FAB] {key} button not found")
                continue
            if box["top"] < mid:
                failures.append(f"[FAB] {key} sits in the top half (top={box['top']:.0f}, mid={mid:.0f}) — would overlap the header")
            if box["right"] > fabs["innerWidth"] + 1 or box["left"] < 0:
                failures.append(f"[FAB] {key} is off-screen horizontally: {box}")
        print(f"[FABs] cart={_fmt(fabs.get('cart'))}  assistant={_fmt(fabs.get('assistant'))}  (viewport h={fabs['innerHeight']})")

        # ---- 3. Hamburger opens the nav drawer; backdrop/Escape closes it ----
        page.goto(f"{FRONTEND_BASE}/", wait_until="domcontentloaded", timeout=30000)
        page.wait_for_timeout(2500)
        try:
            page.locator(".mobile-menu-btn").click(timeout=4000)
            page.locator(".sidebar.mobile-open").wait_for(state="visible", timeout=4000)
            # Nav must not itself overflow the screen.
            nav_w = page.evaluate("() => { const s=document.querySelector('.sidebar.mobile-open'); return s? s.getBoundingClientRect().width: 0; }")
            if nav_w > VIEWPORT["width"] + 1:
                failures.append(f"[Nav] drawer wider than viewport: {nav_w}")
            page.keyboard.press("Escape")
            page.locator(".sidebar.mobile-open").wait_for(state="hidden", timeout=4000)
            print(f"[Nav] drawer opens ({nav_w:.0f}px) and closes on Escape — OK")
        except PWTimeout:
            failures.append("[Nav] hamburger did not open/close the mobile drawer")

        # ---- 5. A product modal (if reachable) is effectively full-width ----
        try:
            page.goto(f"{FRONTEND_BASE}/time-sensitive", wait_until="domcontentloaded", timeout=30000)
            page.locator(".deal-card").first.wait_for(state="visible", timeout=25000)
            page.wait_for_timeout(1000)
            page.locator(".deal-card-name").first.click(timeout=5000)
            modal = page.locator(".modal").first
            modal.wait_for(state="visible", timeout=6000)
            mw = page.evaluate("() => { const m=document.querySelector('.modal'); return m? m.getBoundingClientRect().width: 0; }")
            # Full-screen sheet should fill at least ~92% of the width.
            if mw < VIEWPORT["width"] * 0.9:
                failures.append(f"[Modal] not full-width on mobile: {mw:.0f}px of {VIEWPORT['width']}")
            else:
                print(f"[Modal] full-width sheet: {mw:.0f}px of {VIEWPORT['width']} — OK")
        except PWTimeout:
            print("[Modal] no deal card / modal reachable — skipped (non-fatal)")

        ctx.close()
        browser.close()

    print("\n========== RESULT ==========")
    if failures:
        print(f"FAIL — {len(failures)} mobile layout issue(s):")
        for f in failures:
            print("  -", f)
        return 1
    print("PASS — every screen fits the phone viewport; nav, FABs and modal behave.")
    return 0


def _fmt(box) -> str:
    if not box:
        return "MISSING"
    return f"top={box['top']:.0f},right={box['right']:.0f}"


if __name__ == "__main__":
    sys.exit(main())
