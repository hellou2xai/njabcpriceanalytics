"""Shared helper: attach Go-UPC product images to a page of catalogue records.

Fast by design. One batch query per page against the in-memory DuckDB
product_enrichment table (no per-row lookups), then a dict join on the
normalised UPC. The image itself is served from R2's public CDN, so the API
never moves image bytes. Used by every list endpoint that renders product rows
(catalog search/new-items, deals discounts/clearance/rip-products, intelligence
buy-sheet/missed/buy-signals).
"""

import math


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
