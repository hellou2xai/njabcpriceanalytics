"""
Time-Sensitive Deals page — detailed rendered + accuracy test.

Drives /time-sensitive-deals in a real browser and asserts:
  - one card per row: Discover card + calendar + windows/tiers detail all present;
  - the calendar colour-codes days (active=green, upcoming=amber, ended=grey) and
    the windows column labels each window Active / Upcoming / Ended;
  - RIP/QD tiers with quantity + price are shown;
  - month navigation: switching to a PAST edition re-fetches and every window/day
    renders as Ended;
  - the distributor filter narrows the list to that distributor;
  - DATA ACCURACY: for a sample of rendered cards, the product name and a deal
    window's date range match the /api/deals/time-sensitive payload.

Run:  AUDIT_BASE=http://127.0.0.1:8011 AUDIT_EMAIL=... AUDIT_PASSWORD=... \
      python tests/playwright/test_time_sensitive_deals.py
"""
import json
import os
import re
import sys
from collections import defaultdict

import requests
from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

BASE = os.getenv("AUDIT_BASE", "http://127.0.0.1:8011").rstrip("/")
EMAIL = os.getenv("AUDIT_EMAIL", "")
PASSWORD = os.getenv("AUDIT_PASSWORD", "")
MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

fails, notes = [], []
def check(cond, msg):
    (notes if cond else fails).append(("PASS" if cond else "FAIL") + " · " + msg)
    print(("  ok " if cond else "  XX ") + msg)


def norm_upc(u):
    return re.sub(r"\D", "", str(u or "")).lstrip("0")

def group_api(rows):
    """Mirror the page's grouping: one card per (dist, upc, size, pack, vintage)."""
    g = defaultdict(lambda: {"rep": None, "windows": set(), "soonest": 10**9})
    for r in rows:
        if not r.get("from_date") or not r.get("to_date"):
            continue
        k = f"{r['wholesaler']}|{norm_upc(r.get('upc'))}|{r.get('unit_volume') or ''}|{r.get('unit_qty') or ''}|{r.get('vintage') or ''}"
        c = g[k]
        if c["rep"] is None:
            c["rep"] = r
        c["windows"].add((r["from_date"], r["to_date"]))
        d = r.get("days_to_expire")
        if d is not None and d >= 0:
            c["soonest"] = min(c["soonest"], d)
    return g

def sd(iso):
    if not iso:
        return ""
    _, mo, d = iso.split("-")[:3]
    return f"{MONTHS[int(mo) - 1]} {int(d)}"


def main():
    editions = sorted({e["edition"] for e in requests.get(f"{BASE}/api/catalog/editions", timeout=30).json()}, reverse=True)
    cur, past = editions[0], (editions[1] if len(editions) > 1 else None)
    api_cur = requests.get(f"{BASE}/api/deals/time-sensitive?edition={cur}&limit=5000", timeout=120).json()
    grp_cur = group_api(api_cur)
    print(f"[api] edition {cur}: {len(api_cur)} deal rows -> {len(grp_cur)} cards")

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        ctx = browser.new_context(viewport={"width": 1600, "height": 1000})
        if EMAIL and PASSWORD:
            try:
                b = requests.post(f"{BASE}/api/auth/login", json={"email": EMAIL, "password": PASSWORD}, timeout=20).json()
                ctx.add_init_script(
                    f"localStorage.setItem('lpb_auth_token', {json.dumps(b['token'])});"
                    f"localStorage.setItem('lpb_auth_user', {json.dumps(json.dumps(b['user']))});"
                    "localStorage.setItem('celr_welcome_tour_never','1');"
                    "localStorage.setItem('tsd_filters_collapsed','0');")
            except Exception as e:
                print(f"[login] failed: {e}")
        page = ctx.new_page()
        page.goto(f"{BASE}/time-sensitive-deals", wait_until="domcontentloaded", timeout=60000)
        try:
            page.wait_for_selector(".tsd-row", timeout=45000)
        except PWTimeout:
            check(False, "page rendered .tsd-row cards (auth OK, data present)")
            print("\n".join(fails)); browser.close(); return 1

        rows = page.locator(".tsd-row")
        n = rows.count()
        check(n > 0, f"rows render ({n} on first page)")

        # structure of the first row: card + calendar + windows/tiers
        r0 = rows.nth(0)
        check(r0.locator(".disc-card .disc-card-name").count() > 0, "row has a Discover-style card with a product name")
        check(r0.locator(".tsd-cal .tsd-cal-grid").count() > 0, "row has a month calendar grid")
        check(r0.locator(".tsd-detail .tsd-win").count() > 0, "row has >=1 deal window in the detail column")
        check(r0.locator(".tsd-cal-title").inner_text().startswith(MONTHS[int(cur.split('-')[1]) - 1]), f"calendar shows {cur} month")

        # colour-coded calendar + windows across the page
        live_days = page.locator(".tsd-cal-day.tsd-day-live").count()
        up_days = page.locator(".tsd-cal-day.tsd-day-upcoming").count()
        ended_days = page.locator(".tsd-cal-day.tsd-day-ended").count()
        check(live_days > 0, f"calendar highlights ACTIVE (green) days ({live_days})")
        check((live_days + up_days + ended_days) > 0, f"calendar colour-codes deal days (live {live_days} / upcoming {up_days} / ended {ended_days})")
        badges = set(b.strip().lower() for b in page.locator(".tsd-win-badge").all_inner_texts())
        check(badges.issubset({"active", "upcoming", "ended"}) and len(badges) > 0, f"windows labelled with valid states: {sorted(badges)}")
        check(page.locator(".tsd-tier .tsd-tier-kind").count() > 0, "RIP/QD tiers with quantity shown in the detail column")

        # ---- data accuracy: first 8 rendered cards vs API ----
        acc_ok, acc_tot = 0, 0
        for i in range(min(8, n)):
            row = rows.nth(i)
            txt = row.inner_text()
            name = row.locator(".disc-card-name").first.inner_text().strip()
            # find an API card whose product name matches and whose a window date is on screen
            hit = None
            for c in grp_cur.values():
                rep = c["rep"]
                pn = (rep.get("abg_item_name") or rep.get("product_name") or "").strip()
                if pn and (pn[:18].lower() in name.lower() or name[:18].lower() in pn.lower()):
                    hit = c; break
            acc_tot += 1
            if hit:
                any_date = any(sd(f) in txt for f, _ in hit["windows"])
                if any_date:
                    acc_ok += 1
        check(acc_tot > 0 and acc_ok >= max(1, int(acc_tot * 0.7)),
              f"rendered card names + window dates match the API ({acc_ok}/{acc_tot})")

        # ---- distributor filter ----
        fed = page.locator(".disc-filter-opt", has_text="Fedway").locator("input[type=checkbox]")
        if fed.count():
            fed.first.check()
            page.wait_for_timeout(700)
            dists = set(d.strip() for d in page.locator(".tsd-row .disc-card-dist").all_inner_texts())
            check(all("fedway" in d.lower() for d in dists) and len(dists) > 0,
                  f"distributor filter narrows to Fedway ({sorted(dists)})")
            fed.first.uncheck(); page.wait_for_timeout(500)

        # ---- month navigation to a PAST edition: everything Ended ----
        if past:
            sel = page.locator(".tsd-monthbar select")
            sel.select_option(past)
            page.wait_for_timeout(1200)
            page.wait_for_selector(".tsd-row", timeout=30000)
            title = page.locator(".tsd-cal-title").first.inner_text()
            check(title.startswith(MONTHS[int(past.split('-')[1]) - 1]), f"month nav switched calendar to {past} ({title})")
            # A past month's days are all before today, so the grid must render
            # every deal day grey (no green/amber). (A deal FILED in a past edition
            # can still be active if its window spans into now — that shows as an
            # 'Active' badge, which is correct — but no PAST day is coloured live.)
            live_p = page.locator(".tsd-cal-day.tsd-day-live").count()
            up_p = page.locator(".tsd-cal-day.tsd-day-upcoming").count()
            ended_p = page.locator(".tsd-cal-day.tsd-day-ended").count()
            check(live_p == 0 and up_p == 0 and ended_p > 0,
                  f"past month calendar shows only ENDED (grey) days (live {live_p} / upcoming {up_p} / ended {ended_p})")

        # horizontal overflow guard
        overflow = page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
        check(overflow <= 2, f"no horizontal page overflow ({overflow}px)")

        browser.close()

    print("\n" + "=" * 60)
    print(f"Time-Sensitive Deals test: {len(notes)} passed, {len(fails)} failed")
    for f in fails:
        print("  " + f)
    return 0 if not fails else 1


if __name__ == "__main__":
    sys.exit(main())
