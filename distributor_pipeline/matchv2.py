"""Matcher v2: semantic name search + frontline-price disambiguation + Claude.

Pipeline per Fedway item:
  1. semantic retrieve  : voyage nearest catalogue names (handles abbreviations,
                          word order, vintages; item->item is semantic not exact)
  2. size + price score  : keep size-compatible candidates, rank by name cosine
                          blended with frontline-case-price closeness (the strong
                          signal you flagged)
  3. accept / Claude     : clear winners auto-accept; ambiguous ones go to Claude
                          with their candidate rows to pick the right UPC or none
Output: Fedway item (SKU/name) -> UPC, with method/confidence/score/price_delta.
"""
import collections
from concurrent.futures import ThreadPoolExecutor, as_completed

import numpy as np
from rapidfuzz import fuzz

from . import util, semantic, llm
from .match import _matched, _unmatched

LLM_BATCH = 25
LLM_WORKERS = 8


def _clean(s):
    return util.clean_display_name(s or "") or (s or "")


def _size_ok(a, b):
    if not a or not b:
        return True
    if a == b:
        return True
    if {a, b} <= {700, 750}:        # common 700/750 distributor difference
        return True
    r = a / b
    return 0.95 <= r <= 1.05


def _price_close(a, b):
    if not a or not b:
        return 0.0
    return 1.0 - min(1.0, abs(a - b) / max(a, b))


def build_master(rows):
    """rows from db.find_upc_master. Return (records, name_list, name_to_idx,
    price_index). price_index keys (size_ml, round(case_price)) -> [idx] for the
    exact frontline-price match path."""
    recs = []
    by_name = collections.defaultdict(list)
    price_index = collections.defaultdict(list)
    for upc, pn, brand, uv, uq, ptype, cost, casep, ws in rows:
        name = _clean(f"{pn or ''}")
        if not name:
            continue
        i = len(recs)
        size_ml = util.parse_size_ml(uv or "")
        cp = float(casep) if casep else None
        recs.append({"upc": upc, "name": name, "product_name": pn,
                     "size_ml": size_ml, "case_price": cp,
                     "unit_price": float(cost) if cost else None, "wholesaler": ws})
        by_name[name].append(i)
        if size_ml and cp:
            price_index[(size_ml, round(cp))].append(i)
    names = list(by_name.keys())
    return recs, names, by_name, price_index


def match_items(master_rows, items, use_llm=True, log=print):
    recs, names, by_name, price_index = build_master(master_rows)
    log(f"  master: {len(recs)} rows, {len(names)} distinct names; embedding...")
    index = semantic.SemanticIndex(names)

    q_texts = [_clean(it.get("product_name") or "") for it in items]
    qvecs = semantic.embed(q_texts)
    topk = index.topk(qvecs, k=20)

    matched, review, llm_queue = [], [], []
    exact_price = 0
    for ti, it in enumerate(items):
        cp = it.get("front_line_case_price")
        size = it.get("size_ml")
        qname = q_texts[ti]
        # candidate pool: semantic neighbours UNION exact (size, frontline price)
        cand_idx = set()
        for name_idx, _sim in topk[ti]:
            cand_idx.update(by_name[names[name_idx]])
        if size and cp:
            cand_idx.update(price_index.get((size, round(cp)), ()))
        sim_by_name = {names[ni]: s for ni, s in topk[ti]}
        cands = []  # (score, sim, price_close, rec_idx, price_delta)
        for ri in cand_idx:
            r = recs[ri]
            if not _size_ok(size, r["size_ml"]):
                continue
            sim = sim_by_name.get(r["name"], 0.0)
            pc = _price_close(cp, r["case_price"])
            fz = fuzz.token_set_ratio(qname, r["name"]) / 100.0
            score = 0.6 * sim + 0.25 * pc + 0.15 * fz
            pd = round(r["case_price"] - cp, 2) if (cp and r["case_price"]) else None
            cands.append((score, sim, pc, ri, pd, fz))
        if not cands:
            matched.append(_unmatched(it))
            continue
        cands.sort(reverse=True)
        bscore, bsim, bpc, bri, bpd, bfz = cands[0]
        runner = cands[1][0] if len(cands) > 1 else 0.0
        # EXACT frontline price + matching size is near-definitive (the live
        # frontline == bottle*pack now matches the PDF exactly). Among the
        # exact-price candidates pick the BEST-NAMED one (different products can
        # share a size+price, e.g. Glenlivet 750 vs a Chanson Beaune at ~$702),
        # and accept only when its name genuinely agrees.
        exact = [c for c in cands if c[2] >= 0.999]
        if cp and exact:
            exb = max(exact, key=lambda c: max(c[1], c[5]))
            if max(exb[1], exb[5]) >= 0.55:
                matched.append(_matched(it, recs[exb[3]], "price+size", "HIGH",
                                        round(exb[0] * 100, 1), exb[4]))
                exact_price += 1
                continue
        if bsim >= 0.86 and (bpc >= 0.90 or cp is None):
            matched.append(_matched(it, recs[bri], "semantic+price", "HIGH",
                                    round(bscore * 100, 1), bpd))
            continue
        if bsim >= 0.80 and bpc >= 0.93 and (bscore - runner) > 0.04:
            matched.append(_matched(it, recs[bri], "semantic+price", "MEDIUM",
                                    round(bscore * 100, 1), bpd))
            continue
        top = [c[:5] for c in cands[:6]]
        llm_queue.append((ti, it, top))
    log(f"  exact frontline-price+size matches: {exact_price}")

    # Claude disambiguation pass
    if use_llm and llm_queue:
        log(f"  Claude disambiguation on {len(llm_queue)} ambiguous items...")
        resolved = _run_llm(recs, llm_queue, log)
    else:
        resolved = {}

    for (ti, it, top) in llm_queue:
        pick = resolved.get(ti)
        if pick:
            ri, conf, score = pick
            pd = (round(recs[ri]["case_price"] - (it.get("front_line_case_price") or 0), 2)
                  if recs[ri]["case_price"] else None)
            matched.append(_matched(it, recs[ri], "semantic+llm", conf, score, pd))
        else:
            matched.append(_unmatched(it))
            review.append({
                "item_number_norm": it.get("item_number_norm"),
                "fedway_name": it.get("product_name"), "size_ml": it.get("size_ml"),
                "case_price": it.get("front_line_case_price"),
                "candidates": "; ".join(
                    f'{recs[ri]["upc"]}|{recs[ri]["name"]}|{round(s,3)}'
                    for (s, _si, _pc, ri, _pd) in top[:5]),
            })
    return matched, review


def _run_llm(recs, llm_queue, log):
    """Disambiguate ambiguous items with Claude, batches run concurrently."""
    resolved = {}
    upc_to_idx = {}
    for i, r in enumerate(recs):
        upc_to_idx.setdefault(r["upc"], i)

    def make_batch(chunk):
        return [{
            "id": ti, "name": it.get("product_name"), "size_ml": it.get("size_ml"),
            "case_price": it.get("front_line_case_price"),
            "candidates": [{"upc": recs[ri]["upc"], "name": recs[ri]["name"],
                            "size_ml": recs[ri]["size_ml"],
                            "case_price": recs[ri]["case_price"],
                            "wholesaler": recs[ri]["wholesaler"]}
                           for (_s, _si, _pc, ri, _pd) in top]}
            for (ti, it, top) in chunk]

    chunks = [llm_queue[b:b + LLM_BATCH] for b in range(0, len(llm_queue), LLM_BATCH)]
    total = len(llm_queue)
    done = 0

    def work(chunk):
        try:
            return llm.disambiguate(make_batch(chunk))
        except Exception as e:
            log(f"    LLM batch failed: {type(e).__name__}: {e}")
            return {}

    with ThreadPoolExecutor(max_workers=LLM_WORKERS) as ex:
        futs = {ex.submit(work, ch): len(ch) for ch in chunks}
        for fut in as_completed(futs):
            ans = fut.result()
            for tid, (upc, conf) in ans.items():
                if upc and upc in upc_to_idx:
                    resolved[tid] = (upc_to_idx[upc],
                                     {"high": "HIGH", "medium": "MEDIUM"}.get(conf, "LLM"),
                                     90.0 if conf == "high" else 80.0)
            done += futs[fut]
            log(f"    Claude progress: {done}/{total} ({len(resolved)} resolved)")
    return resolved
