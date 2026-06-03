"""End-to-end runner: extract -> stage -> match -> crosswalk (local+Render) ->
reports. Autonomous: makes the safe choice and keeps going, logging anything odd
into the final summary. Only staging tables are ever truncated.

    python -m distributor_pipeline.run            # full run, no LLM
    python -m distributor_pipeline.run --use-llm  # enable pass 4
    python -m distributor_pipeline.run --max-pages 80   # quick smoke test
"""
import argparse
import csv
import collections

from . import config, extract, db, match, matchv2


def _rich(it):
    s = 0
    if it.get("front_line_case_price"): s += 4
    if (it.get("product_name") or "") and len(it["product_name"]) > 3: s += 2
    if it.get("proof"): s += 1
    if it.get("raw_attributes", {}).get("source") not in ("best_deal", "partial_month"): s += 1
    return s


def dedupe_items(items):
    """One row per item_number_norm, keeping the richest representative."""
    best = {}
    for it in items:
        k = it.get("item_number_norm")
        if not k:
            continue
        if k not in best or _rich(it) > _rich(best[k]):
            best[k] = it
    return list(best.values())


def write_csv(path, rows, cols):
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        for r in rows:
            w.writerow(r)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-llm", action="store_true", help="skip the Claude pass")
    ap.add_argument("--max-pages", type=int, default=None)
    ap.add_argument("--no-render", action="store_true")
    args = ap.parse_args()
    dist = config.DISTRIBUTOR_CODE
    config.OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    summary = []

    def log(msg):
        print(msg, flush=True)
        summary.append(msg)

    log(f"== {dist} crosswalk pipeline ==")
    log(f"PDF: {config.PDF_PATH.name}")

    # 1. extract
    ex = extract.extract(max_pages=args.max_pages)
    log(f"sections (pages): {ex['section_pages']}")
    by_sec = collections.Counter(i['section'] for i in ex['items'])
    log(f"items extracted: {len(ex['items'])} | deals: {len(ex['deals'])} | "
        f"combos: {len(ex['combos'])} | unparsed lines: {len(ex['unparsed'])}")
    log(f"  per section: {dict(by_sec)}")

    # 2. stage (local, truncate-reload)
    local = config.local_db_url()
    ni, nd, nc = db.load_staging(local, dist, ex)
    log(f"staged -> {db.STG_ITEMS}={ni}, {db.STG_DEALS}={nd}, {db.STG_COMBOS}={nc}")

    # 3. master = live UPC-bearing catalogue (real-upc rows, all distributors)
    mrows = db.find_upc_master(local)
    log(f"UPC master rows (real-upc, latest edition): {len(mrows)}")

    # 4. match: semantic name search + frontline-price disambiguation + Claude
    items = dedupe_items(ex['items'])
    log(f"distinct items (by item_number_norm): {len(items)}")
    matched, review = matchv2.match_items(mrows, items, use_llm=not args.no_llm, log=log)
    master_rows_for_reports = mrows
    for r in matched:
        r["distributor_code"] = dist
        r["price_book_month"] = config.PRICE_BOOK_MONTH
        r.setdefault("wholesaler", None)
    conf = collections.Counter(r["match_confidence"] for r in matched)
    total = len(matched)
    hi = conf.get("HIGH", 0); med_c = conf.get("MEDIUM", 0)
    rate = (hi + med_c) / total * 100 if total else 0
    log(f"match rate: HIGH={hi} MEDIUM={med_c} LLM={conf.get('LLM',0)} "
        f"NONE={conf.get('NONE',0)} => matched {(hi+med_c+conf.get('LLM',0))/total*100:.1f}%")

    # 5. crosswalk: local always, Render unless suppressed
    n_local = db.LocalPostgresWriter().write(matched)
    log(f"crosswalk rows upserted locally: {n_local}")
    if args.no_render:
        log("Render push skipped (--no-render)")
    else:
        render = db.RenderPostgresWriter()
        if not render.url:
            log("Render URL not set; skipped (set RENDER_EXTERNAL_DATABASE_URL)")
        else:
            try:
                n_r = render.write(matched)
                log(f"crosswalk rows upserted to Render: {n_r}")
            except Exception as e:
                log(f"Render push FAILED (kept local): {type(e).__name__}: {e}")

    # 6. reports
    out = config.OUTPUT_DIR
    unmatched_fed = [r for r in matched if not r["upc"]]
    write_csv(out / "unmatched_fedway.csv",
              sorted(unmatched_fed, key=lambda r: -(r.get("front_line_case_price") or 0)),
              ["distributor_code", "item_number_norm", "brand", "product_name", "size_ml",
               "pack_qty", "front_line_case_price", "bottle_price", "rip_id"])
    matched_upcs = {r["upc"] for r in matched if r["upc"]}
    seen = set()
    unmatched_upc = []
    for (upc, pn, brand, uv, uq, ptype, cost, casep, ws) in master_rows_for_reports:
        if upc in matched_upcs or upc in seen:
            continue
        seen.add(upc)
        unmatched_upc.append({"upc": upc, "product_name": pn, "brand": brand,
                              "size_ml": None, "wholesaler": ws})
    write_csv(out / "unmatched_upc.csv", unmatched_upc,
              ["upc", "product_name", "brand", "size_ml", "wholesaler"])
    write_csv(out / "match_review.csv", review,
              ["item_number_norm", "fedway_name", "size_ml", "case_price", "candidates"])
    write_csv(out / "unparsed_lines.csv",
              [{"page": p, "column": c, "y": y, "text": t} for (p, c, y, t) in ex["unparsed"]],
              ["page", "column", "y", "text"])

    # 7. validation
    # pack*bottle vs case sanity
    outliers = 0
    for it in items:
        cp, bp, pk = it.get("front_line_case_price"), it.get("bottle_price"), it.get("pack_qty")
        if cp and bp and pk:
            implied = bp * pk
            if implied and abs(implied - cp) / cp > 0.25:
                outliers += 1
    log(f"validation: pack*bottle vs case outliers (>25%): {outliers}")
    # spot check sample
    his = [r for r in matched if r["match_confidence"] == "HIGH"]
    sample = his[::max(1, len(his) // 20)][:20]
    log("--- 20 HIGH-confidence spot checks (fedway -> upc) ---")
    for r in sample:
        log(f"  {r['item_number_norm']} {r['size_ml']}ml '{(r['product_name'] or '')[:34]}' "
            f"-> {r['upc']} '{(r['upc_product_name'] or '')[:34]}' (score {r['match_score']:.0f})")
    # top unmatched by value
    top_un = sorted(unmatched_fed, key=lambda r: -(r.get("front_line_case_price") or 0))[:10]
    log("--- top 10 unmatched Fedway items by case price ---")
    for r in top_un:
        log(f"  ${r.get('front_line_case_price')} {r['size_ml']}ml "
            f"'{(r['product_name'] or '')[:40]}' item {r['item_number_norm']}")

    (out / "run_summary.txt").write_text("\n".join(summary), encoding="utf-8")
    log(f"reports written to {out}")


if __name__ == "__main__":
    main()
