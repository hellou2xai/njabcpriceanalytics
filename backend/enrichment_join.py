"""Shared helper: attach Go-UPC product images to a page of catalogue records.

Fast by design. One batch query per page against the in-memory DuckDB
product_enrichment table (no per-row lookups), then a dict join on the
normalised UPC. The image itself is served from R2's public CDN, so the API
never moves image bytes. Used by every list endpoint that renders product rows
(catalog search/new-items, deals discounts/clearance/rip-products, intelligence
buy-sheet/missed/buy-signals).
"""

import math
import re
from difflib import SequenceMatcher

ALLIED = "allied"  # the app's wholesaler code for Allied Beverage Group


def attach_enrichment_image(con, records, upc_key="upc"):
    """Set rec["image_url"] on each record (None when there is no image).

    `con` is a DuckDB connection that has the product_enrichment table (its upc
    column is already the normalised key, LTRIM(upc,'0')). `upc_key` is the field
    on each record that holds the product's UPC. No-op on an empty list; degrades
    to no images if the table is absent (e.g. parquet dev mode).
    """
    if not records:
        return
    norms = sorted({str(r.get(upc_key)).lstrip("0") for r in records
                    if r.get(upc_key) and str(r.get(upc_key)).lstrip("0")})
    img_map = {}
    if norms:
        ph = ", ".join(f"$e{i}" for i in range(len(norms)))
        prm = {f"e{i}": u for i, u in enumerate(norms)}
        try:
            df = con.execute(
                f"SELECT upc, image_url FROM product_enrichment WHERE upc IN ({ph})", prm
            ).fetchdf()
            for _, er in df.iterrows():
                iu = er.get("image_url")
                if isinstance(iu, float) and math.isnan(iu):
                    iu = None
                img_map[str(er["upc"])] = iu or None
        except Exception:
            img_map = {}
    for rec in records:
        rec["image_url"] = img_map.get(str(rec.get(upc_key) or "").lstrip("0"))


def _toks(s):
    return set(t for t in re.sub(r"[^A-Z0-9 ]", " ", (s or "").upper()).split() if t)


def _name_score(a, b):
    """Cheap semantic-ish similarity: token-set Jaccard, tie-broken by ratio."""
    ta, tb = _toks(a), _toks(b)
    j = len(ta & tb) / len(ta | tb) if (ta | tb) else 0.0
    return j + 0.001 * SequenceMatcher(None, (a or "").upper(), (b or "").upper()).ratio()


# Distributors that carry their own item number in sku_mapping. The SKU is shown
# next to the UPC only for these, and only on that distributor's own rows.
SKU_DISTRIBUTORS = ("allied", "fedway")


def _display_sku(wholesaler, sku):
    """Format a SKU for display. Fedway part numbers are stored zero-padded to 9
    (so they join the catalogue), but are shown WITHOUT leading zeros. Allied
    (ABG) numbers carry no leading zeros, so they pass through unchanged."""
    if sku and wholesaler == "fedway":
        return sku.lstrip("0") or sku
    return sku


def attach_sku_mapping(con, records, upc_key="upc", wholesaler_key="wholesaler",
                       name_key="product_name"):
    """Set rec["abg_sku"] (the distributor's own item number) on records whose
    wholesaler has a SKU mapping (Allied = ABG SKU, Fedway = Fedway SKU).

    Gated per-record by wholesaler: a SKU is only ever set from that record's
    OWN distributor, because the same UPC exists under several distributors and
    the number must not leak across. Lookup is by (distributor, normalised UPC).

    UPC -> SKU is one-to-many. We surface a SKU only when it resolves to one: a
    UPC with a single SKU, or a multi-SKU UPC where the catalogue product name
    clearly matches one candidate's item_name. Genuinely ambiguous UPCs are left
    blank so the field is never misleading. Degrades to no SKUs if the table is
    absent (e.g. parquet dev mode before a load).
    """
    if not records:
        return
    norms = sorted({str(r.get(upc_key)).lstrip("0") for r in records
                    if str(r.get(wholesaler_key) or "") in SKU_DISTRIBUTORS
                    and r.get(upc_key) and str(r.get(upc_key)).lstrip("0")})
    cand: dict = {}
    if norms:
        ph = ", ".join(f"$s{i}" for i in range(len(norms)))
        prm = {f"s{i}": u for i, u in enumerate(norms)}
        dist_ph = ", ".join(f"'{d}'" for d in SKU_DISTRIBUTORS)
        try:
            df = con.execute(
                "SELECT distributor, upc_norm, abg_sku, item_name FROM sku_mapping "
                f"WHERE distributor IN ({dist_ph}) AND upc_norm IN ({ph})", prm
            ).fetchdf()
            for _, er in df.iterrows():
                cand.setdefault((str(er["distributor"]), str(er["upc_norm"])), []).append(
                    (str(er["abg_sku"]), er.get("item_name") or "")
                )
        except Exception:
            cand = {}

    for rec in records:
        rec["abg_sku"] = None
        w = str(rec.get(wholesaler_key) or "")
        if w not in SKU_DISTRIBUTORS:
            continue
        c = cand.get((w, str(rec.get(upc_key) or "").lstrip("0")))
        if not c:
            continue
        if len(c) == 1:
            rec["abg_sku"] = _display_sku(w, c[0][0])
            continue
        # Multiple SKUs share this UPC: resolve only on a clear name winner.
        pn = rec.get(name_key) or ""
        scored = sorted(((_name_score(pn, nm), sku) for sku, nm in c), reverse=True)
        if scored[0][0] > 0 and (len(scored) == 1 or scored[0][0] - scored[1][0] > 1e-9):
            rec["abg_sku"] = _display_sku(w, scored[0][1])
        # else: ambiguous -> leave None (do not confuse the user).
