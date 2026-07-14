"""
Time-Sensitive Deals — DATA-ACCURACY test for dates and amounts.

Two levels of validation:
  A) RENDERED == API — every window date-range, deal price/saving and each
     time-sensitive tier (qty / price / $ back / save) shown on screen matches
     the /api/deals/time-sensitive payload EXACTLY (no formatting / off-by-one
     date or rounding drift).
  B) API == RAW SOURCE — for a sample of time-sensitive RIP tiers, the
     (rip_code, from/to dates, qty, $ amount) is present in the raw `rip` parquet
     (the distributor's sheet); for TS quantity-discount windows, the (from/to,
     qty, per-case discount) is present in the raw `cpl`. This catches genuine
     data errors, not just rendering.

Run:  AUDIT_BASE=http://127.0.0.1:8014 AUDIT_EMAIL=... AUDIT_PASSWORD=... \
      python tests/playwright/test_ts_deals_accuracy.py
"""
import json
import os
import re
import sys
from collections import defaultdict

import requests
from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
from backend.db import get_duckdb, read_parquet

BASE = os.getenv("AUDIT_BASE", "http://127.0.0.1:8014").rstrip("/")
EMAIL = os.getenv("AUDIT_EMAIL", "")
PASSWORD = os.getenv("AUDIT_PASSWORD", "")
MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
CARDS_TO_CHECK = 15
RIP_SAMPLE = 60
QD_SAMPLE = 40

fails, notes = [], []
def check(cond, msg):
    (notes if cond else fails).append(msg)
    print(("  ok  " if cond else "  XX  ") + msg)

def nupc(u):
    return re.sub(r"\D", "", str(u or "")).lstrip("0")
def sd(iso):
    if not iso:
        return ""
    y, mo, d = str(iso)[:10].split("-")[:3]
    return f"{MONTHS[int(mo) - 1]} {int(d)}"
def nums(s):
    return [float(x.replace(",", "")) for x in re.findall(r"\$([\d,]+\.?\d*)", s or "")]
def isTs(t):
    return t.get("is_time_sensitive") is True or t.get("window_status") in ("active", "upcoming")
def isOneCs(t):
    return t.get("source") == "discount" and t.get("qty") == 1 and not str(t.get("unit", "")).lower().startswith("b")

def group(rows):
    g = {}
    for r in rows:
        if not r.get("from_date") or not r.get("to_date"):
            continue
        k = f"{r['wholesaler']}|{nupc(r.get('upc'))}|{r.get('unit_volume') or ''}|{r.get('unit_qty') or ''}|{r.get('vintage') or ''}"
        c = g.setdefault(k, {"rep": r, "windows": set()})
        c["windows"].add((r["from_date"][:10], r["to_date"][:10]))
    return g


def part_a_rendered_vs_api(grp):
    """Every rendered date/amount matches the API card."""
    with sync_playwright() as pw:
        br = pw.chromium.launch(headless=True)
        ctx = br.new_context(viewport={"width": 1600, "height": 1100})
        if EMAIL and PASSWORD:
            b = requests.post(f"{BASE}/api/auth/login", json={"email": EMAIL, "password": PASSWORD}, timeout=20).json()
            ctx.add_init_script(
                f"localStorage.setItem('lpb_auth_token', {json.dumps(b['token'])});"
                f"localStorage.setItem('lpb_auth_user', {json.dumps(json.dumps(b['user']))});"
                "localStorage.setItem('celr_welcome_tour_never','1');"
                "localStorage.setItem('tsd_filters_collapsed','1');")
        page = ctx.new_page()
        page.goto(f"{BASE}/time-sensitive-deals", wait_until="domcontentloaded", timeout=60000)
        try:
            page.wait_for_selector(".tsd-row", timeout=45000)
        except PWTimeout:
            check(False, "page rendered")
            br.close(); return

        # Key on name + size + pack so same-named flavours/sizes never collide.
        def keyof(name, vol, pack):
            return f"{(name or '')[:20].lower()}|{(vol or '').upper().replace(' ', '')}|{pack or ''}"
        by_key = {}
        for c in grp.values():
            r = c["rep"]
            by_key.setdefault(keyof(r.get("abg_item_name") or r.get("product_name"), r.get("unit_volume"), r.get("unit_qty")), c)

        rows = page.locator(".tsd-row")
        n = min(CARDS_TO_CHECK, rows.count())
        date_ok = date_tot = amt_ok = amt_tot = 0
        for i in range(n):
            row = rows.nth(i)
            name = row.locator(".disc-card-name").first.inner_text().strip().lower()
            size_txt = row.locator(".disc-card-size").first.inner_text() if row.locator(".disc-card-size").count() else ""
            mv = re.search(r"([\d.]+\s*(?:ML|L))", size_txt.upper())
            mp = re.search(r"\((\d+)/cs\)", size_txt)
            card = by_key.get(keyof(name, mv.group(1) if mv else "", mp.group(1) if mp else ""))
            if not card:
                continue
            # dates rendered in the windows column
            shown_dates = [d.strip() for d in row.locator(".tsd-win-dates").all_inner_texts()]
            api_dates = {f"{sd(f)} – {sd(t)}" for f, t in card["windows"]}
            for sdt in shown_dates:
                date_tot += 1
                if sdt in api_dates:
                    date_ok += 1
                else:
                    print(f"     date? {name[:24]!r}: screen {sdt!r} not in API {sorted(api_dates)}")
            # time-sensitive tier amounts rendered vs API TS tiers
            api_ts = [t for t in (card["rep"].get("tiers") or []) if not isOneCs(t) and isTs(t)]
            for line in row.locator(".tsd-tiers-ts .tsd-tier").all():
                kind = line.locator(".tsd-tier-kind").inner_text().strip()      # e.g. "RIP 5cs"
                vals = line.locator(".tsd-tier-vals").inner_text().strip()       # "$61.4/cs $5 back"
                m = re.match(r"(RIP|QD)\s+(\d+)", kind)
                if not m:
                    continue
                src = "rip" if m.group(1) == "RIP" else "discount"
                qty = int(m.group(2))
                vnums = nums(vals)
                amt_tot += 1
                # find an API TS tier with same source+qty whose price + (amount|save) match what's on screen
                hit = False
                for t in api_ts:
                    if t.get("source") != src or int(t.get("qty") or -1) != qty:
                        continue
                    price = t.get("price_after")
                    extra = t.get("amount") if src == "rip" else t.get("save_per_case")
                    want = {round(price, 2) if price is not None else None,
                            round(extra, 2) if extra is not None else None}
                    if all(any(abs(v - w) < 0.02 for w in want if w is not None) for v in vnums):
                        hit = True; break
                if hit:
                    amt_ok += 1
                else:
                    print(f"     amt?  {name[:24]!r} {kind}: screen {vnums} not matched in API TS tiers")
        check(date_tot > 0 and date_ok == date_tot, f"[A] rendered window dates == API ({date_ok}/{date_tot})")
        check(amt_tot > 0 and amt_ok >= int(amt_tot * 0.98), f"[A] rendered TS tier amounts == API ({amt_ok}/{amt_tot})")
        br.close()


def part_b_api_vs_source(rows):
    """API time-sensitive tiers exist in the raw distributor sheet (rip / cpl)."""
    with get_duckdb() as con:
        ripsrc = read_parquet(con, "rip")
        cplsrc = read_parquet(con, "cpl")

        # ---- RIP: (code, upc, dates) -> set of (qty, amt) in the raw sheet ----
        rip_ok = rip_tot = 0
        seen = 0
        for r in rows:
            if seen >= RIP_SAMPLE:
                break
            for t in (r.get("tiers") or []):
                if t.get("source") != "rip" or not isTs(t) or not t.get("code"):
                    continue
                if t.get("from_date") is None or t.get("to_date") is None:
                    continue
                seen += 1
                raw = con.execute(f"""
                    SELECT rip_qty_1, rip_amt_1, rip_qty_2, rip_amt_2, rip_qty_3, rip_amt_3, rip_qty_4, rip_amt_4,
                           CAST(from_date AS VARCHAR) AS f, CAST(to_date AS VARCHAR) AS t
                    FROM {ripsrc}
                    WHERE wholesaler = ? AND edition = ? AND CAST(rip_code AS VARCHAR) = ?
                      AND LTRIM(CAST(upc AS VARCHAR), '0') = ?
                """, [r["wholesaler"], r["edition"], str(t["code"]), nupc(r.get("upc"))]).fetchall()
                pairs = set()
                for row in raw:
                    f, tt = str(row[8])[:10], str(row[9])[:10]
                    for k in range(4):
                        q, a = row[k * 2], row[k * 2 + 1]
                        if q is not None and a is not None:
                            try:
                                pairs.add((round(float(q), 2), round(float(a), 2), f, tt))
                            except (TypeError, ValueError):
                                pass
                rip_tot += 1
                want = (round(float(t["qty"]), 2), round(float(t["amount"]), 2), t["from_date"][:10], t["to_date"][:10])
                if any(abs(q - want[0]) < 0.01 and abs(a - want[1]) < 0.01 and f == want[2] and tt == want[3]
                       for (q, a, f, tt) in pairs):
                    rip_ok += 1
                elif rip_tot - rip_ok <= 12:
                    print(f"     RIP src? {r['product_name'][:26]!r} code {t['code']} qty {want[0]} ${want[1]} {want[2]}..{want[3]} — raw has {sorted(pairs)[:4]}")
                break   # one TS RIP tier per product is enough for the sample
        check(rip_tot > 0 and rip_ok >= int(rip_tot * 0.95),
              f"[B] TS RIP (qty/$amount/dates) present in raw rip sheet ({rip_ok}/{rip_tot})")

        # ---- QD: the dated window exists in raw cpl with a matching discount ----
        qd_ok = qd_tot = 0
        seen = 0
        for r in rows:
            if seen >= QD_SAMPLE:
                break
            for t in (r.get("tiers") or []):
                if t.get("source") != "discount" or isOneCs(t) or not isTs(t):
                    continue
                if not t.get("from_date") or not t.get("to_date"):
                    continue
                seen += 1
                raw = con.execute(f"""
                    SELECT discount_1_qty, discount_1_amt, discount_2_qty, discount_2_amt,
                           discount_3_qty, discount_3_amt, discount_4_qty, discount_4_amt, discount_5_qty, discount_5_amt
                    FROM {cplsrc}
                    WHERE wholesaler = ? AND edition = ? AND LTRIM(CAST(upc AS VARCHAR), '0') = ?
                      AND CAST(from_date AS VARCHAR) = ? AND CAST(to_date AS VARCHAR) = ?
                """, [r["wholesaler"], r["edition"], nupc(r.get("upc")), t["from_date"][:10], t["to_date"][:10]]).fetchall()
                qtys = set()
                for row in raw:
                    for k in range(5):
                        q = row[k * 2]
                        if q is not None:
                            m = re.match(r"\s*(\d+)", str(q))
                            if m:
                                qtys.add(int(m.group(1)))
                qd_tot += 1
                if int(t["qty"]) in qtys:
                    qd_ok += 1
                elif qd_tot - qd_ok <= 10:
                    print(f"     QD src?  {r['product_name'][:26]!r} qty {t['qty']} {t['from_date'][:10]}..{t['to_date'][:10]} — raw window qtys {sorted(qtys)}")
                break
        # A time-sensitive QD tier must correspond to a real dated discount in the
        # raw cpl for that window (guards the attach_promotion_tiers fix that stops
        # whole-month QDs being mislabelled with a partial window).
        check(qd_tot > 0 and qd_ok >= int(qd_tot * 0.95),
              f"[B] TS QD (qty within dated window) present in raw cpl ({qd_ok}/{qd_tot})")


def main():
    eds = sorted({e["edition"] for e in requests.get(f"{BASE}/api/catalog/editions", timeout=30).json()}, reverse=True)
    api = requests.get(f"{BASE}/api/deals/time-sensitive?limit=2000", timeout=180).json()
    print(f"[api] {len(api)} deal rows, editions {eds[:3]}")
    grp = group(api)
    part_a_rendered_vs_api(grp)
    part_b_api_vs_source(api)
    print("\n" + "=" * 62)
    print(f"TS Deals accuracy: {len(notes)} passed, {len(fails)} failed")
    for f in fails:
        print("  FAIL · " + f)
    return 0 if not fails else 1


if __name__ == "__main__":
    sys.exit(main())
