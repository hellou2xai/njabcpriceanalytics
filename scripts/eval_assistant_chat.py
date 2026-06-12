"""Model-driven (end-to-end) eval for the Celar AI Assistant.

Sends real questions through the live /api/assistant/ask endpoint (model + tools)
and checks the ANSWERS for response bugs: the assistant going offline, the banned
"on the left/screen" phrasing on the standalone page, missing tables/products,
$0 stocking-deal pricing, a geography filter returning the wrong product type,
edition handling (a past-month rebate), off-topic refusal, and docked grid-driving.

Needs the backend running with a valid ANTHROPIC_API_KEY:
    python -m uvicorn backend.main:app --port 8000
    python scripts/eval_assistant_chat.py

Each question is a real model call, so this costs a little money and takes a
minute or two. Set CELR_EVAL_URL to point at a different host. Exit code is
non-zero on any FAIL (WARN does not fail the run).
"""
from __future__ import annotations

import os
import sys
import io
import json
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
try:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
except Exception:
    pass

from backend.db import get_duckdb

BASE = os.getenv("CELR_EVAL_URL", "http://127.0.0.1:8000").rstrip("/")
RESULTS: list[tuple[str, str, str]] = []   # (status, case, detail)
TOTAL_COST = 0.0


def ask(question: str, page=None, page_path=None) -> dict:
    body = json.dumps({"question": question, "page": page, "page_path": page_path}).encode()
    req = urllib.request.Request(f"{BASE}/api/assistant/ask", data=body,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=180) as resp:
        return json.load(resp)


# ---- checks: each takes (response, con) and returns (ok, detail) -----------

BANNED = ["on the left", "to the left", "on the screen", "on the page",
          "on the side", "in the grid", "filtered the page"]


def not_offline(r, con):
    a = (r.get("answer") or "").lower()
    m = (r.get("usage") or {}).get("model", "")
    bad = "offline" in a or "ai call failed" in a or m in ("offline", "error")
    return not bad, f"model={m}"


def no_banned_phrasing(r, con):
    a = (r.get("answer") or "").lower()
    hit = [p for p in BANNED if p in a]
    return not hit, f"banned phrase(s): {hit}"


def _named(fn, name):
    fn.__name__ = name
    return fn


def min_products(n):
    def _c(r, con):
        got = len(r.get("products") or [])
        return got >= n, f"{got} products (need >= {n})"
    return _named(_c, f"min_products>={n}")


def drove_screen(r, con):
    sc = r.get("screen")
    return bool(sc and sc.get("path")), f"screen={r.get('screen')}"


def short_answer(maxlen):
    def _c(r, con):
        n = len(r.get("answer") or "")
        return n <= maxlen, f"answer length {n} (want <= {maxlen})"
    return _named(_c, f"short_answer<={maxlen}")


def chart_titled(sub):
    def _c(r, con):
        titles = [c.get("title", "") for c in (r.get("charts") or [])]
        return any(sub.lower() in t.lower() for t in titles), f"chart titles={titles}"
    return _named(_c, f"chart_titled('{sub}')")


def answer_has(*subs, mode="any"):
    def _c(r, con):
        a = (r.get("answer") or "").lower()
        hits = [s for s in subs if s.lower() in a]
        ok = bool(hits) if mode == "any" else len(hits) == len(subs)
        return ok, f"found {hits} of {list(subs)}"
    return _named(_c, f"answer_has({mode})")


def answer_lacks(*subs):
    def _c(r, con):
        a = (r.get("answer") or "").lower()
        hit = [s for s in subs if s.lower() in a]
        return not hit, f"should not contain {hit}"
    return _named(_c, "answer_lacks")


def no_near_free_products(r, con):
    bad = []
    for p in r.get("products") or []:
        f, e = p.get("frontline_case_price"), p.get("effective_case_price")
        try:
            if f and float(f) > 0 and e is not None and float(e) < float(f) * 0.10:
                bad.append((p.get("product_name"), float(f), float(e)))
        except (TypeError, ValueError):
            pass
    return not bad, f"$0/near-free rows: {bad[:2]}"


def products_type_in(allowed):
    allowed = {a.lower() for a in allowed}

    def _c(r, con):
        wrong = []
        for p in r.get("products") or []:
            # Judge each row by ITS OWN listing's type (wholesaler + name):
            # a UPC lookup bleeds another distributor's classification in
            # (Allied types Sauza seltzers 'Spirits' while Fedway says 'RTD'),
            # and placeholder barcodes are shared across unrelated products.
            row = con.execute(
                "SELECT ANY_VALUE(product_type) FROM cpl_enriched "
                "WHERE wholesaler=? AND product_name=?",
                [p.get("wholesaler"), p.get("product_name")]).fetchone()
            pt = (row[0] if row else None)
            if pt and pt.lower() not in allowed:
                wrong.append((p.get("product_name"), pt))
        return not wrong, f"wrong type: {wrong[:3]}"
    return _named(_c, f"products_type_in({sorted(allowed)})")


def products_exclude_name(sub):
    def _c(r, con):
        hit = [p.get("product_name") for p in (r.get("products") or [])
               if sub.lower() in str(p.get("product_name") or "").lower()]
        return not hit, f"unexpected: {hit[:3]}"
    return _named(_c, f"products_exclude('{sub}')")


def products_match_terms(*terms):
    """RELEVANCE: every docked product must be on-topic for the named brand —
    name contains a term or its 6-char prefix (GLENLIV == glenlivet). This is
    the Casal Garcia junk-response class: an unscoped sweep must never dock."""
    low = [t.lower() for t in terms]

    def _c(r, con):
        off = []
        for p in (r.get("products") or []):
            name = str(p.get("product_name") or "").lower()
            if name and not any(t in name or (len(t) > 6 and t[:6] in name) for t in low):
                off.append(name[:40])
        return not off, f"{len(off)} off-topic rows e.g. {off[:3]}"
    return _named(_c, f"products_match({terms})")


def max_products(n):
    def _c(r, con):
        got = len(r.get("products") or [])
        return got <= n, f"{got} products docked (sweep? want <= {n})"
    return _named(_c, f"max_products<={n}")


def no_sweep_banner(r, con):
    """The analyst banner must not summarize a catalog-wide sweep (hundreds of
    products) on a brand-scoped question."""
    import re as _re
    a = r.get("answer") or ""
    m = _re.search(r"\*\*(\d[\d,]*) products?\*\* across", a)
    n = int(m.group(1).replace(",", "")) if m else 0
    return n <= 60, f"banner says {n} products across distributors"


# ---- the cases ------------------------------------------------------------
# Standalone (page_path=None) unless a page/path is given.
CASES = [
    {"name": "California wines (standalone)", "q": "find California wines under $200",
     "checks": [not_offline, no_banned_phrasing, min_products(1),
                products_type_in(["Wine", "Sparkling"]), products_exclude_name("ABSOLUT"),
                no_near_free_products]},
    {"name": "Cheapest tequila", "q": "what are the cheapest tequilas",
     "checks": [not_offline, no_banned_phrasing, min_products(1),
                products_type_in(["Spirits"]), no_near_free_products]},
    {"name": "RIP for Macallan 12 in May (past edition)",
     "q": "what RIP rebate deals are there on Macallan 12 for May",
     # Positively assert the (expired-by-June) May rebate was found: its codes
     # and best-tier amount only appear if the edition lookup worked. Avoids the
     # flaky negative-phrase check (the model may note OTHER variants have none).
     "checks": [not_offline, answer_has("111751", "10367", "600")]},
    {"name": "Price over months", "q": "how has Macallan Double Cask 12 price changed over the last few months",
     "checks": [not_offline, chart_titled("over months")]},
    {"name": "Compare distributors", "q": "compare Tito's Handmade Vodka across distributors",
     "checks": [not_offline, answer_has("allied", "fedway", "opici", "highgrade", "peerless", "distributor")]},
    {"name": "Prices going up (data-fix regression)", "q": "show me wines whose prices are going up",
     "checks": [not_offline, no_banned_phrasing, min_products(1), no_near_free_products]},
    {"name": "Best discount (no $0 Beronia)", "q": "what are the biggest discounts in the catalog right now",
     "checks": [not_offline, no_near_free_products, answer_lacks("100% off", "free with")]},
    {"name": "Off-topic refusal", "q": "what's the weather in Tokyo today",
     "checks": [not_offline, answer_has("catalog", "pricing", "can only", "only help", "rebate"),
                answer_lacks("sunny", "cloudy", "temperature", "forecast")]},
    {"name": "Docked: drive the grid", "q": "show me bourbon", "page": "Catalog", "path": "/catalog",
     "checks": [not_offline, drove_screen, short_answer(400)]},
    # --- relevance / specificity (the Casal Garcia junk-response class) ---
    {"name": "Brand cross-distributor gap (Casal Garcia)",
     "q": "which casal garcia products have price difference between fedway and allied for the same upc",
     "checks": [not_offline, products_match_terms("casal", "garcia"),
                max_products(40), no_sweep_banner,
                answer_has("casal garcia", "sangria")]},
    {"name": "Brand cross-distributor gap (Glenlivet)",
     "q": "which glenlivet products are priced differently at allied vs fedway",
     "checks": [not_offline, products_match_terms("glenlivet"),
                max_products(60), no_sweep_banner]},
    {"name": "Catalog-wide gap question still sweeps (control)",
     "q": "show me the biggest price gaps between distributors across the catalog",
     "checks": [not_offline, min_products(10)]},
    # --- half-case credit model surfaces in answers ---
    {"name": "Half-case qualifier (Miraval 375)",
     "q": "how many cases of miraval rose 375ml do I need to buy to qualify for its RIP",
     "checks": [not_offline, answer_has("half", "1/2", "0.5", "credit"),
                answer_has("4 ", "four", mode="any")]},
]


def section(t):
    print(f"\n== {t} ==")


def record(status, case, detail=""):
    RESULTS.append((status, case, detail))
    tag = {"PASS": "[ok ]", "WARN": "[warn]", "FAIL": "[FAIL]"}.get(status, status)
    print(f"{tag} {case}" + (f"  ::  {detail}" if detail else ""))


def run(con):
    global TOTAL_COST
    for case in CASES:
        section(case["name"])
        print(f"   Q: {case['q']}")
        try:
            r = ask(case["q"], page=case.get("page"), page_path=case.get("path"))
        except Exception as e:
            record("FAIL", case["name"] + " :: request", f"{type(e).__name__}: {e}")
            continue
        TOTAL_COST += float((r.get("usage") or {}).get("cost_usd") or 0)
        ans = (r.get("answer") or "").replace("\n", " ")
        print(f"   A: {ans[:200]}")
        for chk in case["checks"]:
            try:
                ok, detail = chk(r, con)
            except Exception as e:
                record("FAIL", f"{case['name']} / {getattr(chk, '__name__', 'check')}",
                       f"check error {type(e).__name__}: {e}")
                continue
            record("PASS" if ok else "FAIL", f"{case['name']} / {getattr(chk, '__name__', 'check')}",
                   "" if ok else detail)


def write_report(path, n_pass, n_warn, n_fail):
    from datetime import datetime
    icon = {"PASS": "✅", "WARN": "⚠️", "FAIL": "❌"}
    lines = ["# Celar AI Assistant: model-driven (end-to-end) eval report", ""]
    lines.append(f"_Generated: {datetime.now():%Y-%m-%d %H:%M} · run `python scripts/eval_assistant_chat.py`_")
    lines.append("")
    verdict = "all checks passed" if not n_fail else f"{n_fail} failing check(s) to fix"
    lines.append(f"**Result: {n_pass} passed, {n_warn} warning(s), {n_fail} failed: {verdict}.**")
    lines.append(f"_Total model cost this run: ${TOTAL_COST:.4f}._")
    lines.append("")
    lines.append("Each row is a real question sent through the model + tools; the checks look at "
                 "the actual answer, products, charts and screen action it produced.")
    lines.append("")
    fails = [(s, c, d) for s, c, d in RESULTS if s in ("FAIL", "WARN")]
    if fails:
        lines.append("## Needs attention")
        lines.append("")
        for s, c, d in fails:
            lines.append(f"- {icon[s]} **{c}**: {d or 'see details'}")
        lines.append("")
    # Group by case (the text before ' / ').
    cases = []
    for _, c, _ in RESULTS:
        base = c.split(" / ")[0].split(" :: ")[0]
        if base not in cases:
            cases.append(base)
    for base in cases:
        rows = [(s, c, d) for s, c, d in RESULTS if c.startswith(base)]
        p = sum(1 for s, _, _ in rows if s == "PASS")
        lines.append(f"## {base}  ({p}/{len(rows)} passed)")
        lines.append("")
        lines.append("| Check | Status | Detail |")
        lines.append("| --- | --- | --- |")
        for s, c, d in rows:
            label = c.split(" / ", 1)[1] if " / " in c else c
            lines.append(f"| {label} | {icon.get(s, s)} {s} | {d.replace('|', '\\|') if d else ''} |")
        lines.append("")
    open(path, "w", encoding="utf-8").write("\n".join(lines))


def main():
    # Fail fast if the backend isn't up.
    try:
        ask("ping health", page_path="/catalog")
    except Exception as e:
        print(f"Backend not reachable at {BASE} ({type(e).__name__}). "
              f"Start it: python -m uvicorn backend.main:app --port 8000")
        sys.exit(2)
    with get_duckdb() as con:
        run(con)
    n_fail = sum(1 for s, _, _ in RESULTS if s == "FAIL")
    n_warn = sum(1 for s, _, _ in RESULTS if s == "WARN")
    n_pass = sum(1 for s, _, _ in RESULTS if s == "PASS")
    print("\n" + "=" * 60)
    print(f"SUMMARY: {n_pass} pass, {n_warn} warn, {n_fail} FAIL  ·  model cost ${TOTAL_COST:.4f}")
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    report = os.path.join(here, "tests", "assistant_chat_eval_report.md")
    os.makedirs(os.path.dirname(report), exist_ok=True)
    write_report(report, n_pass, n_warn, n_fail)
    print(f"Report written to {report}")
    sys.exit(1 if n_fail else 0)


if __name__ == "__main__":
    main()
