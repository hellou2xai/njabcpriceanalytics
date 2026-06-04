"""UPC matching: name+size+price, no UPCs in the price book.

Passes
  1. blocking  : candidates share size_ml (exact) and a brand token
  2. scoring   : rapidfuzz token_set_ratio on normalised names; >=92 and a >=5
                 gap to the runner-up -> HIGH
  3. price     : ties (within 5 pts) broken by comparing the master's known cost
                 to the Fedway bottle price; within tolerance -> MEDIUM
  4. llm       : optional (--use-llm), batches the still-ambiguous sets
Everything unresolved is returned for match_review.csv. Nothing is silently
dropped or auto-picked.
"""
import statistics
from collections import defaultdict
from rapidfuzz import fuzz

from . import util

SCORE_HIGH = 92
GAP = 5


class Master:
    def __init__(self, rows):
        # row: (upc, product_name, brand, unit_volume, unit_qty, product_type,
        #       cost, case_price, wholesaler)
        self.rows = []
        self.block = defaultdict(list)   # (size_ml, brand_token) -> [idx]
        for upc, pn, brand, uv, uq, ptype, cost, casep, ws in rows:
            size_ml = util.parse_size_ml(uv or "")
            name = util.norm_name(f"{brand or ''} {pn or ''}")
            toks = set(name.split())
            idx = len(self.rows)
            self.rows.append({
                "upc": upc, "product_name": pn, "brand": brand, "size_ml": size_ml,
                "cost": cost, "case_price": casep, "wholesaler": ws,
                "norm": name, "tokens": toks,
            })
            for tk in toks:
                if len(tk) >= 3:
                    self.block[(size_ml, tk)].append(idx)

    def candidates(self, size_ml, tokens):
        seen, out = set(), []
        for tk in tokens:
            for idx in self.block.get((size_ml, tk), ()):
                if idx not in seen:
                    seen.add(idx); out.append(idx)
        return out


def infer_price_kind(master: Master, items):
    """Compare master cost magnitudes to Fedway bottle prices to decide whether
    the master 'price' is cost or retail, and set the pass-3 tolerance."""
    ratios = []
    by_norm = defaultdict(list)
    for r in master.rows:
        by_norm[r["norm"]].append(r)
    for it in items:
        bp = it.get("bottle_price")
        if not bp:
            continue
        nm = util.norm_name(it.get("product_name") or "")
        cand = by_norm.get(nm)
        if cand and cand[0]["cost"]:
            ratios.append(cand[0]["cost"] / bp)
        if len(ratios) >= 200:
            break
    med = statistics.median(ratios) if ratios else 1.0
    kind = "cost" if 0.7 <= med <= 1.3 else "retail"
    return kind, med


def _score(a_norm, r):
    return fuzz.token_set_ratio(a_norm, r["norm"])


def match_items(master: Master, items, price_kind="cost"):
    """Return (matched_rows, review_rows). matched rows carry upc + method/conf."""
    matched, review = [], []
    for it in items:
        a_norm = util.norm_name(it.get("product_name") or "")
        a_tokens = set(a_norm.split())
        size_ml = it.get("size_ml")
        cand_idx = master.candidates(size_ml, a_tokens)
        if not cand_idx:
            matched.append(_unmatched(it))
            continue
        scored = sorted(
            ((_score(a_norm, master.rows[i]), i) for i in cand_idx),
            reverse=True,
        )
        best_s, best_i = scored[0]
        runner = scored[1][0] if len(scored) > 1 else 0
        if best_s >= SCORE_HIGH and (best_s - runner) >= GAP:
            matched.append(_matched(it, master.rows[best_i], "name", "HIGH", best_s, None))
            continue
        # pass 3: price disambiguation among near-ties
        ties = [(s, i) for s, i in scored if best_s - s <= GAP]
        bp = it.get("bottle_price")
        pick, delta = _price_pick(ties, master, bp, price_kind)
        if pick is not None and best_s >= 80:
            matched.append(_matched(it, master.rows[pick], "name+price", "MEDIUM",
                                    best_s, delta))
            continue
        # unresolved -> review with all candidates
        review.append({
            "distributor_code": None, "item_number_norm": it.get("item_number_norm"),
            "fedway_name": it.get("product_name"), "size_ml": size_ml,
            "bottle_price": bp, "best_score": best_s,
            "candidates": "; ".join(
                f"{master.rows[i]['upc']}|{master.rows[i]['product_name']}|{s}"
                for s, i in scored[:5]),
        })
        matched.append(_unmatched(it))
    return matched, review


def _price_pick(ties, master, bp, price_kind):
    if not bp:
        return None, None
    best = (None, None, 1e9)
    for s, i in ties:
        cost = master.rows[i]["cost"]
        if not cost:
            continue
        if price_kind == "cost":
            delta = abs(cost - bp) / bp
            ok = delta <= 0.10
        else:  # retail: expect 1.1x..1.8x of cost
            ratio = cost / bp
            delta = abs(ratio - 1.45) / 1.45
            ok = 1.1 <= ratio <= 1.8
        if ok and delta < best[2]:
            best = (i, round((cost - bp), 2), delta)
    return best[0], best[1]


def _base(it):
    return {
        "distributor_code": None,
        "item_number_norm": it.get("item_number_norm"),
        "brand": it.get("brand"), "product_name": it.get("product_name"),
        "size_ml": it.get("size_ml"), "pack_qty": it.get("pack_qty"),
        "proof": it.get("proof"), "vintage": it.get("vintage"),
        "front_line_case_price": it.get("front_line_case_price"),
        "bottle_price": it.get("bottle_price"),
        "best_rip_bottle_price": it.get("best_rip_bottle_price"),
        "rip_id": it.get("rip_id"), "program_flags": it.get("program_flags"),
        # enrichment from the section headers (useful even when unmatched)
        "category": it.get("category"), "product_type": it.get("type"),
        "country": it.get("country"),
    }


def _matched(it, mrow, method, conf, score, delta):
    r = _base(it)
    live = mrow.get("case_price")
    pdf = it.get("front_line_case_price")
    r.update({"upc": mrow["upc"], "upc_product_name": mrow["product_name"],
              "match_method": method, "match_confidence": conf,
              "match_score": float(score),
              # frontline-price discrepancy: live system minus price book. Only
              # meaningful when BOTH prices exist, else null (no false delta).
              "live_frontline_case_price": live,
              "price_delta": (round(live - pdf, 2)
                              if (live is not None and pdf is not None) else None)})
    return r


def _unmatched(it):
    r = _base(it)
    r.update({"upc": None, "upc_product_name": None, "match_method": None,
              "match_confidence": "NONE", "match_score": None,
              "live_frontline_case_price": None, "price_delta": None})
    return r
