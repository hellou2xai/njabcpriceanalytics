"""Tool-level eval harness for the Celar AI Assistant.

Exercises the assistant's data tools directly (no model / API key needed) to
surface RESPONSE bugs at the source: $0 stocking rows leaking into deals, a
geography filter returning the wrong product type, edition pinning, UPC
collisions, crashes on bad input, price-sanity violations, and cross-tool
inconsistency. Run: python scripts/eval_assistant.py

Exit code is non-zero if any FAIL is recorded (WARN does not fail the run).
"""
from __future__ import annotations

import os
import sys
import io

# Allow running as `python scripts/eval_assistant.py` from the repo root.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Make stdout tolerant of non-cp1252 chars on a Windows console.
try:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
except Exception:
    pass

from backend.db import get_duckdb
from backend import assistant as A

CTX = {"user_id": None}
RESULTS: list[tuple[str, str, str, str]] = []   # (status, name, detail, section)
_SECTION = "general"


def section(title: str) -> None:
    global _SECTION
    _SECTION = title
    print(f"\n== {title} ==")


def record(status: str, name: str, detail: str = "") -> None:
    RESULTS.append((status, name, detail, _SECTION))
    tag = {"PASS": "[ok ]", "WARN": "[warn]", "FAIL": "[FAIL]"}.get(status, status)
    line = f"{tag} {name}"
    if detail:
        line += f"  ::  {detail}"
    print(line)


def expect(name: str, ok: bool, detail: str = "", warn_only: bool = False) -> None:
    record("PASS" if ok else ("WARN" if warn_only else "FAIL"), name, "" if ok else detail)


def no_crash(name: str, fn):
    """Call fn(); record FAIL if it raises. Returns (ok, result)."""
    try:
        out = fn()
        record("PASS", f"no-crash: {name}")
        return True, out
    except Exception as e:
        record("FAIL", f"no-crash: {name}", f"{type(e).__name__}: {e}")
        return False, None


# ---- shared helpers -------------------------------------------------------

FLOOR = 0.10


def near_free(rows) -> list:
    bad = []
    for r in rows or []:
        if not isinstance(r, dict):
            continue
        f, e = r.get("frontline_case_price"), r.get("effective_case_price")
        try:
            if f and float(f) > 0 and e is not None and float(e) < float(f) * FLOOR:
                bad.append((r.get("product_name"), float(f), float(e)))
        except (TypeError, ValueError):
            pass
    return bad


def price_violations(rows) -> list:
    """effective should be <= frontline and non-negative."""
    bad = []
    for r in rows or []:
        if not isinstance(r, dict):
            continue
        f, e = r.get("frontline_case_price"), r.get("effective_case_price")
        try:
            if e is not None and float(e) < 0:
                bad.append((r.get("product_name"), "negative effective", float(e)))
            if f is not None and e is not None and float(e) > float(f) + 0.01:
                bad.append((r.get("product_name"), "effective>frontline", (float(f), float(e))))
        except (TypeError, ValueError):
            pass
    return bad


def product_types(con, rows) -> dict:
    out = {}
    for r in rows or []:
        upc = str(r.get("upc") or "").lstrip("0")
        if not upc:
            continue
        try:
            row = con.execute(
                "SELECT ANY_VALUE(product_type) FROM cpl_enriched "
                "WHERE LTRIM(CAST(upc AS VARCHAR),'0')=?", [upc]).fetchone()
            out[r.get("product_name")] = row[0] if row else None
        except Exception:
            pass
    return out


# ---- the eval -------------------------------------------------------------

def run(con):
    # 1) Robustness: no tool should raise on empty or garbage input.
    pure = [
        ("top_products", A._t_top_products), ("price_timeline", A._t_price_timeline),
        ("price_details", A._t_price_details), ("compare_distributors", A._t_compare_distributors),
        ("rip_lookup", A._t_rip_lookup), ("best_gp_deals", A._t_best_gp_deals),
        ("closeouts", A._t_closeouts), ("distributor_arbitrage", A._t_distributor_arbitrage),
        ("price_history", A._t_price_history), ("category_breakdown", A._t_category_breakdown),
        ("deal_360", A._t_deal_360), ("size_value", A._t_size_value),
        ("best_one_case_rip", A._t_best_one_case_rip), ("find_substitute", A._t_find_substitute),
    ]
    section("robustness: empty + garbage input")
    for nm, fn in pure:
        no_crash(f"{nm}({{}})", lambda fn=fn: fn(con, {}))
        no_crash(f"{nm}(garbage)", lambda fn=fn: fn(con, {"match": "zzqxweird-not-a-product-999"}))
    for nm, fn in [("find_deals", A._t_find_deals), ("price_movers", A._t_price_movers)]:
        no_crash(f"{nm}({{}})", lambda fn=fn: fn(con, {}, CTX))

    # 2) Stocking-deal floor must hold across every browse/deal surface.
    section("stocking-deal floor ($0 free-with-purchase must not leak)")
    floor_probes = {
        "top_products(cheapest Wine)": A._t_top_products(con, {"category": "Wine", "order_by": "cheapest", "limit": 25}),
        "top_products(cheapest Spirits)": A._t_top_products(con, {"category": "Spirits", "order_by": "cheapest", "limit": 25}),
        "best_gp_deals": A._t_best_gp_deals(con, {"limit": 25}),
        "closeouts": A._t_closeouts(con, {"limit": 25}),
        "distributor_arbitrage": A._t_distributor_arbitrage(con, {"limit": 25}),
        "find_deals(discount)": A._t_find_deals(con, {"kind": "discount", "limit": 25}, CTX),
        "find_deals(time_sensitive)": A._t_find_deals(con, {"kind": "time_sensitive", "limit": 25}, CTX),
        "find_deals(clearance)": A._t_find_deals(con, {"kind": "clearance", "limit": 25}, CTX),
        "price_movers(drop)": A._t_price_movers(con, {"direction": "drop", "limit": 25}, CTX),
    }
    for nm, rows in floor_probes.items():
        bad = near_free(rows if isinstance(rows, list) else [])
        expect(f"floor: {nm}", not bad,
               f"{len(bad)} near-free rows e.g. {bad[:2]}")

    # 3) Price sanity: effective <= frontline, no negatives.
    section("price sanity")
    for nm, rows in floor_probes.items():
        bad = price_violations(rows if isinstance(rows, list) else [])
        expect(f"sanity: {nm}", not bad, f"{bad[:2]}")

    # 4) Region / varietal semantics return the right product type.
    section("region / varietal semantics")
    ca = A._t_top_products(con, {"region": "california", "limit": 25})
    expect("region=california returns rows", bool(ca), "no rows for California wines", warn_only=True)
    pts = product_types(con, ca)
    wrong = {n: t for n, t in pts.items() if t and t not in ("Wine", "Sparkling")}
    expect("region=california -> Wine only", not wrong, f"non-wine leaked: {dict(list(wrong.items())[:4])}")
    absolut = [n for n in pts if n and "ABSOLUT" in str(n).upper()]
    expect("region=california excludes ABSOLUT", not absolut, f"{absolut[:3]}")

    ky = A._t_top_products(con, {"region": "kentucky", "limit": 15})
    kpts = product_types(con, ky)
    nonspirit = {n: t for n, t in kpts.items() if t and t != "Spirits"}
    expect("region=kentucky -> Spirits", bool(ky) and not nonspirit,
           f"rows={len(ky)} non-spirit={dict(list(nonspirit.items())[:4])}", warn_only=not ky)

    # 4b) Data-pipeline health: price_trend must be populated in the current
    #     edition, else every "prices going up / down" feature returns empty.
    section("data pipeline")
    cym = A._current_ym()
    trend_rows = con.execute(
        "WITH cur AS (SELECT wholesaler, MAX(edition) ed FROM cpl_enriched "
        "WHERE edition<=? GROUP BY wholesaler) "
        "SELECT COUNT(*) FILTER (WHERE c.price_trend IS NOT NULL), COUNT(*) "
        "FROM cpl_enriched c JOIN cur ON c.wholesaler=cur.wholesaler AND c.edition=cur.ed",
        [cym]).fetchone()
    populated = trend_rows[0] if trend_rows else 0
    expect(f"price_trend populated in current edition ({cym})", populated > 0,
           f"0 of {trend_rows[1] if trend_rows else 0} rows have a price_trend -> price_movers "
           f"and the price-increase/drop filters return EMPTY (data-pipeline gap, not a code bug)",
           warn_only=True)

    # 5) Edition awareness.
    section("edition awareness")
    cases = {"May": "-05", "2026-05": "2026-05", "this month": None, "garbage zzz": None, "": None}
    for text, want in cases.items():
        got = A._resolve_month(con, text)
        if want is None and text in ("garbage zzz", ""):
            expect(f"_resolve_month('{text}') -> None", got is None, f"got {got}")
        elif text == "this month":
            expect("_resolve_month('this month') -> current", got == A._current_ym(), f"got {got}")
        else:
            expect(f"_resolve_month('{text}')", bool(got) and want in got, f"got {got}")

    rl_now = A._t_rip_lookup(con, {"match": "macallan 12"})
    rl_may = A._t_rip_lookup(con, {"match": "macallan 12", "month": "May"})
    expect("rip_lookup month plumbs edition", rl_may.get("edition") == A._resolve_month(con, "May"),
           f"edition={rl_may.get('edition')}")
    expect("rip_lookup(month=May) differs from current when expired",
           rl_may.get("by_distributor") != {} or rl_now.get("by_distributor") == rl_may.get("by_distributor"),
           f"now={rl_now.get('by_distributor')} may={rl_may.get('by_distributor')}", warn_only=True)

    # 6) price_timeline: resolves named product, sorted, deltas, no collision.
    section("price_timeline")
    tl = A._t_price_timeline(con, {"match": "macallan double cask 12", "months": 12})
    expect("timeline returns distributors", isinstance(tl, dict) and bool(tl.get("distributors")),
           str(tl)[:120])
    if tl.get("distributors"):
        d0 = tl["distributors"][0]
        eds = [t["edition"] for t in d0["timeline"]]
        expect("timeline editions sorted ascending", eds == sorted(eds), str(eds))
        expect("timeline resolved the named product (not a UPC collision)",
               "DOUBLE CASK" in str(tl.get("product", "")).upper(), f"product={tl.get('product')}")
        expect("timeline first delta is None, rest computed",
               d0["timeline"][0]["delta_vs_prev"] is None, "first row should have no prior")
    tl_bad = A._t_price_timeline(con, {"match": "zzqx-not-real"})
    expect("timeline(nonexistent) -> error dict", isinstance(tl_bad, dict) and bool(tl_bad.get("error")),
           str(tl_bad)[:120])
    tl_empty = A._t_price_timeline(con, {"match": ""})
    expect("timeline(empty) -> error dict", isinstance(tl_empty, dict) and bool(tl_empty.get("error")),
           str(tl_empty)[:120])

    # 7) Cross-tool consistency: price_details effective == compare_distributors row.
    section("cross-tool consistency")
    sample = con.execute(
        "WITH cur AS (SELECT wholesaler, MAX(edition) ed FROM cpl_enriched "
        f"WHERE edition<='{A._current_ym()}' GROUP BY wholesaler) "
        "SELECT c.product_name, c.wholesaler, CAST(c.upc AS VARCHAR) upc, c.effective_case_price "
        "FROM cpl_enriched c JOIN cur ON c.wholesaler=cur.wholesaler AND c.edition=cur.ed "
        "WHERE c.upc IS NOT NULL AND c.effective_case_price > 0 "
        "AND LTRIM(CAST(c.upc AS VARCHAR),'0') NOT IN ('','0') "
        "ORDER BY c.product_name LIMIT 1").fetchone()
    if sample:
        pname, ws, upc, eff = sample
        pd = A._t_price_details(con, {"match": pname})
        if not pd.get("error") and pd.get("effective_case_price") is not None:
            cmp = A._t_compare_distributors(con, {"match": upc})
            comp_rows = cmp.get("comparison", []) if isinstance(cmp, dict) else []
            match_ws = [r for r in comp_rows if r.get("wholesaler") == pd.get("wholesaler")]
            if match_ws:
                a, b = pd.get("effective_case_price"), match_ws[0].get("effective_case_price")
                expect("price_details == compare_distributors (same UPC/ws effective)",
                       a is not None and b is not None and abs(float(a) - float(b)) < 0.01,
                       f"price_details={a} compare={b} ({pname}/{ws})", warn_only=True)
            else:
                record("WARN", "consistency: no matching distributor row", f"{pname}/{ws}")
        else:
            record("WARN", "consistency: price_details unavailable", pname)

    # 8) price_movers direction sanity. Verify each returned product against its
    #    EXACT latest-edition row (wholesaler + name + size + upc): price_trend
    #    is computed per product+size+vintage, so a coarse (wholesaler, upc) check
    #    false-fails on UPC collisions.
    section("price_movers direction")
    up = A._t_price_movers(con, {"direction": "increase", "limit": 15}, CTX)
    if isinstance(up, list) and up:
        wrong = []
        for r in up:
            upc = str(r.get("upc") or "").lstrip("0")
            row = con.execute(
                "WITH cur AS (SELECT wholesaler, MAX(edition) ed FROM cpl_enriched GROUP BY wholesaler) "
                "SELECT ANY_VALUE(c.price_trend) FROM cpl_enriched c "
                "JOIN cur ON c.wholesaler=cur.wholesaler AND c.edition=cur.ed "
                "WHERE c.wholesaler=? AND COALESCE(c.product_name,'')=? "
                "AND COALESCE(c.unit_volume,'')=? AND LTRIM(CAST(c.upc AS VARCHAR),'0')=?",
                [r.get("wholesaler"), r.get("product_name") or "",
                 r.get("unit_volume") or "", upc]).fetchone()
            if row and row[0] not in ("increase", None):
                wrong.append((r.get("product_name"), row[0]))
        expect("price_movers(increase) returns rising products", not wrong,
               f"{len(wrong)}/{len(up)} not 'increase' e.g. {wrong[:2]}")
    else:
        record("WARN", "price_movers(increase) empty", str(up)[:80])

    # 9) RIP tier ladder integrity for a known code.
    section("rip tiers")
    if rl_may.get("rip_codes"):
        cd = rl_may["rip_codes"][0]
        tiers = cd.get("tiers", [])
        sorted_ok = [t["amount"] for t in tiers] == sorted(t["amount"] for t in tiers)
        best = [t for t in tiers if t.get("best")]
        expect("rip tiers sorted by amount", sorted_ok, str(tiers))
        expect("rip tiers flag exactly one best", len(best) == 1 or not tiers, f"best={len(best)}")
    else:
        record("WARN", "rip tiers: no May codes to check", str(rl_may.get("note")))

    # 7) Semantic resolution + relevance: a brand-scoped ask must return
    #    ON-TOPIC products only (the Casal Garcia junk-response class: an
    #    unscoped arbitrage sweep buried a brand answer under 2,062 rows).
    section("semantic resolution + relevance")

    def _off_topic(rows, *tokens):
        # On-topic = the name contains a token OR its 6-char prefix
        # (distributors abbreviate: GLENLIV == glenlivet).
        off = []
        for r in rows or []:
            name = str((r.get("product_name") if isinstance(r, dict) else r) or "").lower()
            if name and not any(t in name or (len(t) > 6 and t[:6] in name)
                                for t in tokens):
                off.append(name[:48])
        return off

    hits = A._resolve_products(con, {}, "casal garcia", "all", 100)
    expect("resolve('casal garcia') returns rows", bool(hits), "no rows")
    off = _off_topic(hits, "casal", "garcia")
    expect("resolve('casal garcia') all on-topic", not off, f"off-topic: {off[:4]}")

    hits_sp = A._resolve_products(con, {}, "cassal garcia", "all", 50)
    off_sp = _off_topic(hits_sp, "casal", "garcia")
    expect("resolve misspelling 'cassal garcia' lands on-topic",
           bool(hits_sp) and not off_sp,
           f"rows={len(hits_sp or [])} off-topic={off_sp[:3]}", warn_only=True)

    hits_u = A._resolve_products(con, {}, "764793360306", "all", 10)
    expect("resolve(UPC 764793360306) -> Casal Garcia",
           bool(hits_u) and not _off_topic(hits_u, "casal", "garcia"),
           str([h.get("product_name") for h in (hits_u or [])][:3]))

    arb = A._t_distributor_arbitrage(con, {"query": "casal garcia",
                                           "distributors": ["allied", "fedway"]})
    arb_rows = arb if isinstance(arb, list) else []
    expect("arbitrage(query='casal garcia') returns rows", bool(arb_rows), str(arb)[:150])
    off_a = _off_topic(arb_rows, "casal", "garcia")
    expect("arbitrage(query) all on-topic", not off_a, f"off-topic: {off_a[:4]}")
    expect("arbitrage(query) is scoped, not a sweep", len(arb_rows) <= 25,
           f"{len(arb_rows)} rows came back for one brand")
    arb_all = A._t_distributor_arbitrage(con, {"limit": 5000})
    expect("arbitrage unscoped still works for catalog-wide asks",
           isinstance(arb_all, list) and len(arb_all) > 100,
           f"{len(arb_all) if isinstance(arb_all, list) else arb_all}")

    tp_g = A._t_top_products(con, {"match": "glenlivet", "limit": 50})
    off_g = _off_topic(tp_g, "glenlivet")
    expect("top_products('glenlivet') on-topic", bool(tp_g) and not off_g,
           f"rows={len(tp_g or [])} off={off_g[:4]}")

    # 8) Ground truth: tool numbers must equal cpl_enriched exactly.
    section("ground truth vs cpl_enriched")
    gt = con.execute(
        "SELECT frontline_case_price, effective_case_price FROM cpl_enriched "
        "WHERE wholesaler='allied' AND product_name='MIRAVAL ROSE 2024' "
        "AND unit_volume='375ML' "
        "AND edition=(SELECT MAX(edition) FROM cpl_enriched WHERE wholesaler='allied') "
        "LIMIT 1").fetchone()
    if gt:
        tp_m = A._t_top_products(con, {"match": "miraval rose", "limit": 25}) or []
        # Pin the EXACT row (name + barcode): the same size also exists as a
        # placeholder-barcode 2025 listing with its own price.
        row_m = next((r for r in tp_m if str(r.get("unit_volume")) == "375ML"
                      and str(r.get("wholesaler")) == "allied"
                      and str(r.get("product_name")) == "MIRAVAL ROSE 2024"
                      and str(r.get("upc") or "").lstrip("0") == "89419240115"), None)
        expect("top_products carries the Miraval 375 row", row_m is not None,
               f"names={[r.get('product_name') for r in tp_m][:5]}")
        if row_m:
            expect("tool frontline == cpl_enriched",
                   abs(float(row_m.get("frontline_case_price") or 0) - float(gt[0])) < 0.011,
                   f"tool={row_m.get('frontline_case_price')} db={gt[0]}")
            expect("tool effective == cpl_enriched",
                   abs(float(row_m.get("effective_case_price") or 0) - float(gt[1])) < 0.011,
                   f"tool={row_m.get('effective_case_price')} db={gt[1]}")
    else:
        record("WARN", "ground truth: Miraval 375 not in current edition", "")

    # 9) Half-case credit model: the data layer must be populated and priced.
    section("half-case credit model")
    n_cr = con.execute("SELECT COUNT(*) FROM rip_credits").fetchone()[0]
    expect("rip_credits populated in the pricing cache", n_cr > 0,
           "0 rows — the cache predates the credit model (run derive + ingest + reload)")
    if gt and n_cr:
        # Sheet: 2cs $40 / 6cs $180 / 10cs $500 at credit 0.5 -> deepest full-
        # month rebate $25/physical case off $132 list = $107 effective.
        expect("Miraval 375 effective reflects credit-scaled RIP (107.00)",
               abs(float(gt[1]) - 107.0) < 0.011,
               f"effective={gt[1]} (132 - 50 = 82 means the credit was IGNORED)")
        # The placeholder-barcode sibling listing (2025, upc '0') matches the
        # sheet via its stub row, so its credit must come from the SIZE/PACK
        # fallback (derive rip_credit_by_pack) — $82 means the fallback broke.
        gt25 = con.execute(
            "SELECT effective_case_price FROM cpl_enriched "
            "WHERE wholesaler='allied' AND product_name='MIRAVAL ROSE 2025' "
            "AND unit_volume='375ML' "
            "AND edition=(SELECT MAX(edition) FROM cpl_enriched WHERE wholesaler='allied') "
            "LIMIT 1").fetchone()
        if gt25 and gt25[0] is not None:
            expect("placeholder-barcode sibling (2025) credit-scaled via size/pack fallback",
                   abs(float(gt25[0]) - 107.0) < 0.011, f"effective={gt25[0]}")


SECTION_BLURB = {
    "robustness: empty + garbage input": "Every tool is called with empty and nonsense input; none should raise.",
    "stocking-deal floor ($0 free-with-purchase must not leak)": "$0 / near-free 'free-with-purchase' rows must never surface in browse or deal results.",
    "price sanity": "Effective price must be <= list price and never negative.",
    "region / varietal semantics": "A geography filter must return the right product type (California -> Wine, Kentucky -> Spirits), never stray substrings like ABSOLUT CALIFORNIA.",
    "data pipeline": "Upstream data the tools depend on must be populated for the current edition.",
    "edition awareness": "Month parsing and past-edition lookups (e.g. a rebate from a prior month) must work.",
    "price_timeline": "Month-over-month price tool: resolves the named product, sorts editions, computes deltas, errors gracefully.",
    "cross-tool consistency": "The same product's numbers must agree across different tools.",
    "price_movers direction": "Products returned for 'prices going up' must actually be rising.",
    "rip tiers": "RIP tier ladders are sorted and flag exactly one best rung.",
    "semantic resolution + relevance": "Brand/UPC/misspelled queries must resolve to ON-TOPIC products only, and brand-scoped tools must never return an unscoped sweep.",
    "ground truth vs cpl_enriched": "Tool prices must equal the derived source of truth exactly.",
    "half-case credit model": "Half-case qualifiers (375ML=1/2 CASE) must be priced via case credits — data populated and effective prices scaled.",
}


def write_report(path: str, n_pass: int, n_warn: int, n_fail: int) -> None:
    from datetime import datetime
    sections: list[str] = []
    for _, _, _, sec in RESULTS:
        if sec not in sections:
            sections.append(sec)
    icon = {"PASS": "✅", "WARN": "⚠️", "FAIL": "❌"}
    lines = []
    lines.append("# Celar AI Assistant: tool-level eval report")
    lines.append("")
    lines.append(f"_Generated: {datetime.now():%Y-%m-%d %H:%M} · run `python scripts/eval_assistant.py`_")
    lines.append("")
    if n_fail:
        verdict = f"{n_fail} failing check(s) to fix"
    elif n_warn:
        verdict = f"no failures, {n_warn} warning(s) to review"
    else:
        verdict = "all checks passed"
    lines.append(f"**Result: {n_pass} passed, {n_warn} warning(s), {n_fail} failed: {verdict}.**")
    lines.append("")
    lines.append("This eval exercises the assistant's data tools directly (no model call), so it "
                 "catches response bugs at their source: bad pricing, wrong filters, edition handling, "
                 "crashes, and inconsistency between tools.")
    lines.append("")
    # Attention box first.
    attn = [(s, n, d) for s, n, d, _ in RESULTS if s in ("FAIL", "WARN")]
    if attn:
        lines.append("## Needs attention")
        lines.append("")
        for s, n, d in attn:
            lines.append(f"- {icon[s]} **{n}**: {d or 'see details'}")
        lines.append("")
    # Per-section tables.
    for sec in sections:
        rows = [(s, n, d) for s, n, d, sc in RESULTS if sc == sec]
        p = sum(1 for s, _, _ in rows if s == "PASS")
        lines.append(f"## {sec}  ({p}/{len(rows)} passed)")
        blurb = SECTION_BLURB.get(sec)
        if blurb:
            lines.append("")
            lines.append(f"_{blurb}_")
        lines.append("")
        lines.append("| Check | Status | Detail |")
        lines.append("| --- | --- | --- |")
        for s, n, d in rows:
            lines.append(f"| {n} | {icon.get(s, s)} {s} | {d.replace('|', '\\|') if d else ''} |")
        lines.append("")
    open(path, "w", encoding="utf-8").write("\n".join(lines))


def main():
    with get_duckdb() as con:
        run(con)
    n_fail = sum(1 for s, _, _, _ in RESULTS if s == "FAIL")
    n_warn = sum(1 for s, _, _, _ in RESULTS if s == "WARN")
    n_pass = sum(1 for s, _, _, _ in RESULTS if s == "PASS")
    print("\n" + "=" * 60)
    print(f"SUMMARY: {n_pass} pass, {n_warn} warn, {n_fail} FAIL  (of {len(RESULTS)})")

    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    report = os.path.join(here, "tests", "assistant_eval_report.md")
    os.makedirs(os.path.dirname(report), exist_ok=True)
    write_report(report, n_pass, n_warn, n_fail)
    print(f"Report written to {report}")
    sys.exit(1 if n_fail else 0)


if __name__ == "__main__":
    main()
