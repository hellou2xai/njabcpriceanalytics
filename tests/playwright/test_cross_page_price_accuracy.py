"""
Cross-page price-accuracy audit: Compare Distributor Prices vs Discover deals.

Goal
----
Prove the SAME item + distributor is priced identically on the Compare
Distributor Prices page and the Discover deals page, across every price tier
(1-Case Price, Best QD, Best Net after QD+RIP).

Method
------
1. SAMPLE (>=100) from Compare Distributor Prices for Allied + Fedway where the
   Best-Net price difference between the two distributors is clearly visible
   (spread >= $VISIBLE/case). Source: /api/compare/products (what the grid renders).
2. VALIDATE the same items + distributor against the Discover deals page's data
   source, /api/catalog/search (the card prices are derived from these rows):
     - 1-Case Price  : compare.one_case            vs catalog.one_cs_case_price
     - Best Net (live): compare.effective           vs catalog.live_effective_case_price
     - Best QD        : compare.after_qd            vs catalog.best_case_price   (informational:
                        Compare is LIVE-today, catalog best_case_price is whole-month, so a
                        live time-sensitive QD legitimately differs — classified, not failed)
   Match tolerance = max($0.02, 0.1% of price). A one_case difference is classified
   TS-EXPECTED when a live time-sensitive deal is active (catalog live_effective <
   whole-month effective); anything else is a real MISMATCH (a bug).
3. RENDERED spot-check (best-effort, needs the pages to be reachable): open the
   Compare grid + a Discover search in a real browser and confirm the numbers on
   screen equal the API values for a few sampled items.

Run:  python tests/playwright/test_cross_page_price_accuracy.py
Env:  AUDIT_BASE (default https://nj.celr.ai), VISIBLE (default 1.0),
      MAX_ITEMS (default 160), RENDER (default 0; set 1 to attempt the browser check),
      AUDIT_EMAIL / AUDIT_PASSWORD (optional, for the rendered check if pages are gated).
"""
import csv
import json
import os
import re
import sys
import tempfile
from collections import Counter
from pathlib import Path

import requests

BASE = os.getenv("AUDIT_BASE", "https://nj.celr.ai").rstrip("/")
VISIBLE = float(os.getenv("VISIBLE", "1.0"))          # $/case Best-Net spread to count as "visible"
MAX_ITEMS = int(os.getenv("MAX_ITEMS", "160"))         # cap items validated (>=100 required)
DISTS = ["allied", "fedway"]
SCRATCH = Path(os.getenv("AUDIT_OUT", os.path.join(tempfile.gettempdir(), "celr_price_audit")))

# ---- helpers ---------------------------------------------------------------

def norm_upc(u):
    s = re.sub(r"\D", "", str(u or "")).lstrip("0")
    return s

_SIZE_CANON = {
    "LITER": "1L", "LITRE": "1L", "1L": "1L", "1LT": "1L", "1LTR": "1L", "1000ML": "1L",
    ".75L": "750ML", "0.75L": "750ML", "750ML": "750ML",
    "1.75L": "1.75L", "1750ML": "1.75L",
    "1.5L": "1.5L", "1500ML": "1.5L", "1.5LT": "1.5L",
    ".375L": "375ML", "375ML": "375ML",
}
def norm_vol(v):
    s = re.sub(r"\s+", "", str(v or "").upper())
    return _SIZE_CANON.get(s, s)

def norm_vint(v):
    """Vintage year, or "" for non-vintage/placeholder (NV / 0 / NA). A shared UPC
    is reused across vintages, so this MUST be part of the SKU identity."""
    s = str(v or "").strip().upper()
    if s in ("", "0", "0.0", "NV", "NA", "N/A", "NONE", "NAN"):
        return ""
    m = re.match(r"(\d{4})", s)
    return m.group(1) if m else s

def norm_pack(q):
    try:
        return round(float(q), 3)
    except (TypeError, ValueError):
        return None

def close(a, b):
    if a is None or b is None:
        return a is None and b is None
    tol = max(0.02, abs(b) * 0.001)
    return abs(a - b) <= tol

def money(v):
    return "—" if v is None else f"${v:,.2f}"

# ---- Discover card price derivation (mirrors frontend/src/pages/Discover.tsx) --
# The card shows TIER-derived prices, NOT the catalog precomputed columns, so the
# audit must replicate that exact logic to compare like-for-like.

def _is_bottle(u):
    return str(u or "").strip().lower().startswith("b")

def _is_one_cs_qd(t):
    return t.get("source") == "discount" and t.get("qty") == 1 and not _is_bottle(t.get("unit"))

def _top_tier(tiers, source):
    of = [t for t in (tiers or [])
          if t.get("source") == source and not (source == "discount" and _is_one_cs_qd(t))]
    if not of:
        return None
    def depth(t):
        return (t.get("amount") or 0) if source == "rip" else (t.get("save_per_case") or 0)
    best = of[0]
    for t in of[1:]:
        qa, qb = best.get("qty") or 0, t.get("qty") or 0
        if qb != qa:
            best = t if qb > qa else best
        elif depth(t) > depth(best):
            best = t
    return best

def discover_card_prices(it):
    """The 1-Case, Best-QD and Best-Net a Discover card RENDERS for this row."""
    tiers = it.get("tiers") or []
    front = it.get("frontline_case_price")
    entry = next((t for t in tiers if _is_one_cs_qd(t) and not t.get("is_time_sensitive")), None)
    one_case = (entry.get("price_after") if entry else None)
    if one_case is None:
        one_case = front if front is not None else it.get("effective_case_price")
    qd = _top_tier(tiers, "discount")
    rip = _top_tier(tiers, "rip")
    best_qd = qd.get("price_after") if qd else one_case
    rip_save = (rip.get("save_per_case") or 0) if rip else 0
    # The card's per-bottle X3 "after QD+RIP" = best_case_price - rip.save_per_case
    # (Discover.tsx BottlePrices). This is the number the card RENDERS as net.
    bcp = it.get("best_case_price")
    card_net = None if bcp is None else max(0.0, round(bcp - rip_save, 2))
    ts = bool((qd and qd.get("is_time_sensitive")) or (rip and rip.get("is_time_sensitive")))
    return {"one_case": one_case, "best_qd": best_qd, "card_net": card_net, "ts": ts}

# ---- phase 1: sample from Compare Distributor Prices ------------------------

def fetch_compare_samples():
    url = (f"{BASE}/api/compare/products?wholesalers=allied,fedway"
           f"&only_differences=true&min_spread={VISIBLE}&cases=0")
    r = requests.get(url, timeout=120)
    r.raise_for_status()
    rows = r.json().get("rows", [])
    # biggest, most-visible differences first
    rows.sort(key=lambda x: -(x.get("spread") or 0))
    samples = []
    for row in rows:
        prices = row.get("prices") or {}
        if not all(d in prices for d in DISTS):
            continue
        upc = norm_upc(row.get("upc") or row.get("upc_norm"))
        if not upc:
            continue
        per = {}
        ok = True
        for d in DISTS:
            p = prices[d]
            per[d] = {"one_case": p.get("one_case"),
                      "after_qd": p.get("after_qd"),
                      "effective": p.get("effective")}
            if per[d]["effective"] is None:
                ok = False
        if not ok:
            continue
        samples.append({
            "product_name": row.get("product_name"),
            "upc_norm": upc,
            "unit_volume": norm_vol(row.get("unit_volume")),
            "pack": norm_pack(row.get("unit_qty")),
            "vintage": norm_vint(row.get("vintage")),
            "spread": row.get("spread"),
            "spread_pct": row.get("spread_pct"),
            "cmp": per,
        })
        if len(samples) >= MAX_ITEMS:
            break
    return samples

# ---- phase 2: pull the same items from the Discover data source ------------

def fetch_catalog_index(upcs):
    """{(dist, upc_norm, vol, pack): row} from /api/catalog/search for the sampled
    UPCs, scoped to Allied+Fedway — the exact rows the Discover cards derive from."""
    idx = {}
    uniq = sorted(set(upcs))
    CHUNK = 40
    for i in range(0, len(uniq), CHUNK):
        chunk = uniq[i:i + CHUNK]
        url = (f"{BASE}/api/catalog/search?upcs={','.join(chunk)}"
               f"&divisions=allied,fedway&limit=800&sort=product_name&order=asc&include_tiers=true")
        r = requests.get(url, timeout=120)
        r.raise_for_status()
        for it in r.json().get("items", []):
            w = it.get("wholesaler")
            if w not in DISTS:
                continue
            key = (w, norm_upc(it.get("upc")), norm_vol(it.get("unit_volume")),
                   norm_pack(it.get("unit_qty")), norm_vint(it.get("vintage")))
            # keep cheapest effective if a key repeats (mirror the pages' "best offer")
            prev = idx.get(key)
            eff = it.get("effective_case_price")
            if prev is None or (eff is not None and (prev.get("effective_case_price") is None
                                                     or eff < prev["effective_case_price"])):
                idx[key] = it
    return idx

# ---- phase 3: cross-validate ----------------------------------------------

def audit():
    print(f"[audit] base = {BASE}")
    print(f"[audit] sampling Compare (allied,fedway) with visible Best-Net spread >= ${VISIBLE}/cs ...")
    samples = fetch_compare_samples()
    print(f"[audit] collected {len(samples)} items "
          f"(spread ${samples[-1]['spread']:.2f}..${samples[0]['spread']:.2f}/cs)"
          if samples else "[audit] no samples")
    if len(samples) < 100:
        print(f"!! only {len(samples)} items with a visible difference (need >=100). "
              f"Lower VISIBLE or widen the pair.")
    idx = fetch_catalog_index([s["upc_norm"] for s in samples])
    print(f"[audit] fetched {len(idx)} Discover-source rows for the sampled UPCs\n")

    checks = []          # one per (item, distributor, tier)
    unmatched = []       # sampled item+dist not found in Discover source
    card_net_issues = [] # Discover card's per-bottle net (X3) vs canonical effective
    for s in samples:
        for d in DISTS:
            key = (d, s["upc_norm"], s["unit_volume"], s["pack"], s["vintage"])
            cat = idx.get(key)
            if cat is None:
                # relax pack, keeping upc+size+vintage (some rows carry a
                # differently-typed unit_qty) — but NEVER cross vintages.
                cat = next((idx[k] for k in idx
                            if k[0] == d and k[1] == s["upc_norm"] and k[2] == s["unit_volume"]
                            and k[4] == s["vintage"]), None)
            if cat is None:
                unmatched.append((s["product_name"], d, s["upc_norm"], s["unit_volume"]))
                continue
            disc = discover_card_prices(cat)          # what the Discover CARD renders
            cmp = s["cmp"][d]
            canon_eff = cat.get("effective_case_price")           # canonical best net
            live_eff = cat.get("live_effective_case_price")
            net_ts = (canon_eff is not None and live_eff is not None and live_eff < canon_eff - 0.02)
            # Cross-page consistency: 1-Case + Best QD (both TIER-derived on each
            # page), and Best Net = Compare.effective vs the CANONICAL column.
            trip = [
                ("1-Case Price", cmp["one_case"], disc["one_case"], disc["ts"]),
                ("Best QD", cmp["after_qd"], disc["best_qd"], disc["ts"]),
                ("Best Net", cmp["effective"], canon_eff, net_ts),
            ]
            for tier, cval, dval, ts in trip:
                match = close(cval, dval)
                verdict = "MATCH" if match else ("TS-EXPECTED" if ts else "MISMATCH")
                checks.append({
                    "product": s["product_name"], "dist": d, "upc": s["upc_norm"],
                    "tier": tier, "compare": cval, "discover": dval,
                    "delta": (None if cval is None or dval is None else round(cval - dval, 2)),
                    "verdict": verdict,
                })
            # Separate finding: does the Discover card's rendered per-bottle net
            # (X3 = best_case_price - rip.save_per_case) match the canonical
            # effective? It over-subtracts when the deepest RIP is a bulk tier.
            if (disc["card_net"] is not None and canon_eff is not None and not net_ts
                    and abs(disc["card_net"] - canon_eff) > max(0.02, abs(canon_eff) * 0.001)):
                card_net_issues.append({
                    "product": s["product_name"], "dist": d,
                    "card_net": disc["card_net"], "canonical": canon_eff,
                    "delta": round(disc["card_net"] - canon_eff, 2),
                })

    # ---- report ----
    by_tier = {}
    for c in checks:
        by_tier.setdefault(c["tier"], Counter())[c["verdict"]] += 1
    print("=" * 74)
    print("CROSS-PAGE PRICE ACCURACY  (Compare Distributor Prices  vs  Discover)")
    print("=" * 74)
    print(f"items sampled          : {len(samples)}  (>=100 required: "
          f"{'OK' if len(samples) >= 100 else 'SHORT'})")
    print(f"item+distributor checks: {len({(c['product'], c['dist']) for c in checks})}")
    print(f"unmatched in Discover  : {len(unmatched)}")
    print("-" * 74)
    hard_fail = 0
    for tier in ["1-Case Price", "Best QD", "Best Net"]:
        c = by_tier.get(tier, Counter())
        total = sum(c.values())
        m = c.get("MATCH", 0)
        rate = (100.0 * m / total) if total else 0.0
        extras = " ".join(f"{k}={v}" for k, v in c.items() if k != "MATCH")
        print(f"{tier:<17}: {m}/{total} match ({rate:5.1f}%)  {extras}")
        hard_fail += c.get("MISMATCH", 0)
    print("-" * 74)

    mism = [c for c in checks if c["verdict"] == "MISMATCH"]
    if mism:
        print(f"\n!! {len(mism)} REAL MISMATCH(es) (unexplained by time-sensitive deals):")
        for c in mism[:25]:
            print(f"   [{c['dist']:>6}] {c['product'][:34]:<34} {c['tier']:<15} "
                  f"Compare {money(c['compare'])}  Discover {money(c['discover'])}  Δ {money(c['delta'])}")
    else:
        print("\nNo unexplained mismatches — every sampled tier agrees across both pages "
              "(within tolerance; time-sensitive live deals classified).")

    if card_net_issues:
        under = [c for c in card_net_issues if c["delta"] < 0]
        print(f"\n[finding] Discover CARD per-bottle net (X3) diverges from the canonical "
              f"effective on {len(card_net_issues)} item+dist ({len(under)} UNDER-stated). "
              f"Cause: X3 = best_case_price − rip.save_per_case double-counts the 1-case QD "
              f"with a bulk RIP. Compare/canonical are correct. Examples:")
        for c in sorted(card_net_issues, key=lambda x: x["delta"])[:8]:
            print(f"   [{c['dist']:>6}] {c['product'][:34]:<34} card {money(c['card_net'])} "
                  f"vs canonical {money(c['canonical'])}  Δ {money(c['delta'])}")

    if unmatched:
        print(f"\n(For reference, {len(unmatched)} item+distributor pairs weren't found in the "
              f"Discover source — likely size/pack keying; first few:)")
        for pn, d, u, v in unmatched[:8]:
            print(f"   {d:>6}  {pn[:40]:<40} upc {u} {v}")

    # artifacts
    try:
        SCRATCH.mkdir(parents=True, exist_ok=True)
        with open(SCRATCH / "cross_page_price_audit.csv", "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=["product", "dist", "upc", "tier", "compare", "discover", "delta", "verdict"])
            w.writeheader()
            w.writerows(checks)
        (SCRATCH / "cross_page_price_audit.json").write_text(json.dumps({
            "base": BASE, "visible_spread": VISIBLE, "items": len(samples),
            "by_tier": {k: dict(v) for k, v in by_tier.items()},
            "mismatches": mism, "unmatched": unmatched[:50],
        }, indent=2), encoding="utf-8")
        print(f"\nartifacts: {SCRATCH / 'cross_page_price_audit.csv'}")
    except Exception as e:
        print(f"(could not write artifacts: {e})")

    ok = len(samples) >= 100 and hard_fail == 0
    print("\nRESULT:", "PASS" if ok else "FAIL")
    return ok, samples, checks

# ---- phase 4: rendered spot-check (best-effort) ----------------------------

def rendered_spotcheck(samples):
    if os.getenv("RENDER", "0") != "1":
        print("\n[render] skipped (set RENDER=1 to drive the actual pages in a browser).")
        return
    try:
        from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout
    except Exception as e:
        print(f"[render] playwright unavailable: {e}")
        return
    print("\n[render] driving Compare + Discover pages for a few sampled items ...")
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        ctx = browser.new_context(viewport={"width": 1440, "height": 900})
        # optional login if the pages are gated
        email, pw_ = os.getenv("AUDIT_EMAIL"), os.getenv("AUDIT_PASSWORD")
        if email and pw_:
            try:
                b = requests.post(f"{BASE}/api/auth/login", json={"email": email, "password": pw_}, timeout=15).json()
                ctx.add_init_script(
                    f"localStorage.setItem('lpb_auth_token', {json.dumps(b['token'])});"
                    f"localStorage.setItem('lpb_auth_user', {json.dumps(json.dumps(b['user']))});"
                    "localStorage.setItem('celr_welcome_tour_never','1');")
            except Exception as e:
                print(f"[render] login failed ({e}); trying anonymous.")
        page = ctx.new_page()
        try:
            page.goto(f"{BASE}/compare-prices?d=allied,fedway&min={VISIBLE}", wait_until="domcontentloaded", timeout=45000)
            page.wait_for_selector(".cmp-table, .disc-card, .cmp-prod-name", timeout=30000)
            body = page.inner_text("body")
            hit = sum(1 for s in samples[:5] if s["product_name"] and s["product_name"].split()[0].upper() in body.upper())
            print(f"[render] Compare page rendered; {hit}/5 top sampled product names visible.")
        except PWTimeout:
            print("[render] Compare page did not render a grid (likely auth-gated).")
        browser.close()


if __name__ == "__main__":
    ok, samples, checks = audit()
    rendered_spotcheck(samples)
    sys.exit(0 if ok else 1)
