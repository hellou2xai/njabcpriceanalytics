"""
NJ ABC eCPL Standard Template Definitions.

These define the canonical column schemas for each sheet type.
Every wholesaler's parser maps their raw columns to these canonical names.
If the NJ ABC changes their template, update HERE — all parsers inherit the fix.
"""

# ---------------------------------------------------------------------------
# CPL — Current Price List
# ---------------------------------------------------------------------------
# Canonical output columns (what goes into Parquet).
# Order matters — this is the Parquet column order.
CPL_COLUMNS = [
    "upc",
    "from_date",
    "to_date",
    "brand_reg_no",
    "product_type",
    "product_name",
    "vintage",
    "abv_proof",
    "unit_type",
    "unit_qty",
    "unit_volume",
    "rip_code",
    "combo_code",
    "closeout_permit",
    "frontline_case_price",
    "frontline_unit_price",
    "best_case_price",
    "best_unit_price",
    "split_case_surcharge",
    # Discount tiers are normalized into a separate structure,
    # but we also keep them flat for the CPL parquet.
    "discount_1_qty",
    "discount_1_amt",
    "discount_2_qty",
    "discount_2_amt",
    "discount_3_qty",
    "discount_3_amt",
    "discount_4_qty",
    "discount_4_amt",
    "discount_5_qty",
    "discount_5_amt",
    # Distributor-internal item number. Not part of the official NJ ABC
    # template: Fedway appends it as an UNNAMED column right of the last
    # labelled CPL header (column Z), one per product row. Same identifier as
    # the RIP sheet's dist_item_no. Captured only for wholesalers whose config
    # sets cpl_dist_item_after_headers (Fedway); NULL for everyone else.
    "dist_item_no",
]

# Standard NJ ABC CPL header → canonical name mapping.
# Keys are lowercased, stripped header strings for fuzzy matching.
CPL_HEADER_MAP = {
    "upc code": "upc",
    "from date": "from_date",
    "to date": "to_date",
    "brand registration number": "brand_reg_no",
    "product type": "product_type",
    "product name": "product_name",
    "vintages": "vintage",
    "proof": "abv_proof",
    "abv": "abv_proof",
    "unit type": "unit_type",
    "unit quantity": "unit_qty",
    "unit_volume amount": "unit_volume",
    "unit volume": "unit_volume",
    "rip code": "rip_code",
    "combo code": "combo_code",
    "closeout permit": "closeout_permit",
    "frontline case list price": "frontline_case_price",
    "frontline_unit list price": "frontline_unit_price",
    "frontline unit list price": "frontline_unit_price",
    "best case price": "best_case_price",
    "best unit price": "best_unit_price",
    "split case unit price": "split_case_surcharge",
    "split case price per unit": "split_case_surcharge",
    "discount 1 quantity": "discount_1_qty",
    "discount 1 $ amount": "discount_1_amt",
    "discount 1 $amount": "discount_1_amt",
    "discount 2 quantity": "discount_2_qty",
    "discount 2 $ amount": "discount_2_amt",
    "discount 2 $amount": "discount_2_amt",
    "discount 3 quantity": "discount_3_qty",
    "discount 3 $ amount": "discount_3_amt",
    "discount 3 $amount": "discount_3_amt",
    "discount 4 quantity": "discount_4_qty",
    "discount 4 $ amount": "discount_4_amt",
    "discount 4 $amount": "discount_4_amt",
    "discount 5 quantity": "discount_5_qty",
    "discount 5 $ amount": "discount_5_amt",
    "discount 5 $amount": "discount_5_amt",
}

# ---------------------------------------------------------------------------
# RIP — Reduced Item Price
# ---------------------------------------------------------------------------
RIP_COLUMNS = [
    "rip_code",
    "upc",
    "brand_reg_no",
    "from_date",
    "to_date",
    "rip_description",
    "rip_unit_1",
    "rip_qty_1",
    "rip_amt_1",
    "rip_unit_2",
    "rip_qty_2",
    "rip_amt_2",
    "rip_unit_3",
    "rip_qty_3",
    "rip_amt_3",
    "rip_unit_4",
    "rip_qty_4",
    "rip_amt_4",
    "comments",
    # Distributor-internal item number. Not part of the official NJ ABC
    # template: Fedway appends it as an UNNAMED column right of COMMENTS
    # (their RIP comments reference products by this number, e.g.
    # "Item # 247380 = 1/2 case", and rows with UPC=0 have ONLY this key).
    # Captured opportunistically by base_parser._parse_rip.
    "dist_item_no",
]

RIP_HEADER_MAP = {
    "rip code": "rip_code",
    "upc code": "upc",
    "brand registration": "brand_reg_no",
    "brand reg": "brand_reg_no",
    "from date": "from_date",
    "to date": "to_date",
    "rip description": "rip_description",
    "rip unit no. 1": "rip_unit_1",
    "rip unit no.1": "rip_unit_1",
    "rip quantity no. 1": "rip_qty_1",
    "rip quantity no.1": "rip_qty_1",
    "rip $ amount no. 1": "rip_amt_1",
    "rip $ amount no.1": "rip_amt_1",
    "rip unit no. 2": "rip_unit_2",
    "rip unit no.2": "rip_unit_2",
    "rip quantity no. 2": "rip_qty_2",
    "rip quantity no.2": "rip_qty_2",
    "rip $ amount no. 2": "rip_amt_2",
    "rip $ amount no.2": "rip_amt_2",
    "rip unit no. 3": "rip_unit_3",
    "rip unit no.3": "rip_unit_3",
    "rip quantity no. 3": "rip_qty_3",
    "rip quantity no.3": "rip_qty_3",
    "rip $ amount no. 3": "rip_amt_3",
    "rip $ amount no.3": "rip_amt_3",
    "rip unit no. 4": "rip_unit_4",
    "rip unit no.4": "rip_unit_4",
    "rip quantity no. 4": "rip_qty_4",
    "rip quantity no.4": "rip_qty_4",
    "rip $ amount no. 4": "rip_amt_4",
    "rip $ amount no.4": "rip_amt_4",
    "comments": "comments",
    "comments instructions": "comments",
}

# ---------------------------------------------------------------------------
# COMBO — Bundle Deals
# ---------------------------------------------------------------------------
COMBO_COLUMNS = [
    "combo_code",
    "upc",
    "from_date",
    "to_date",
    "product_name",
    "brand_reg_no",
    "combo_pack_price",
    "qty_per_pack",
    "frontline_price_each",
    "combo_price_each",
    "total_savings",
    "comments",
]

COMBO_HEADER_MAP = {
    "combo code": "combo_code",
    "upc code": "upc",
    "from date": "from_date",
    "to date": "to_date",
    "individual products": "product_name",
    "individual products in combo pack": "product_name",
    "indivivual products": "product_name",
    "indivivual products in combo pack": "product_name",
    "indivivual products in co": "product_name",
    "brand registration": "brand_reg_no",
    "brand registration number": "brand_reg_no",
    "combo pack price": "combo_pack_price",
    "quantity of items": "qty_per_pack",
    "quantity of items per combo pack": "qty_per_pack",
    "frontline price": "frontline_price_each",
    "frontline price for each item": "frontline_price_each",
    "non-combo price": "frontline_price_each",
    "combo price of each item": "combo_price_each",
    "combo price": "combo_price_each",
    "total savings": "total_savings",
    "comments": "comments",
    "comments instructions": "comments",
}

# ---------------------------------------------------------------------------
# BEER MIX AND MATCH
# ---------------------------------------------------------------------------
BEER_MM_COLUMNS = [
    "beer_mm_code",
    "upc",
    "from_date",
    "to_date",
    "description",
    "brand_reg_no",
    "frontline_case_keg_price",
    "min_qty",
    "discount_pct",
    "price_each",
    "per_case_keg_discount",
    "rolling_keg",
]

BEER_MM_HEADER_MAP = {
    "beer mix and match code": "beer_mm_code",
    "upc code": "upc",
    "from date": "from_date",
    "to date": "to_date",
    "beer mix and match description": "description",
    "description": "description",
    "brand registration": "brand_reg_no",
    "brand registration number": "brand_reg_no",
    "beer mix and match frontline": "frontline_case_keg_price",
    "frontline case or keg price": "frontline_case_keg_price",
    "minimum quantity": "min_qty",
    "case or keg discount": "discount_pct",
    "beer mix and match price": "price_each",
    "price for each case or keg": "price_each",
    "per case or keg discount": "per_case_keg_discount",
    "rolling keg": "rolling_keg",
}

# ---------------------------------------------------------------------------
# Sheet name aliases — wholesalers may name sheets slightly differently
# ---------------------------------------------------------------------------
SHEET_ALIASES = {
    "cpl": ["CPL", "cpl", "Current Price List"],
    "rip": ["RIP", "rip", "Reduced Item Price"],
    "combo": ["COMBO", "Combo", "combo"],
    "beer_mm": ["BEER MIX and MATCH", "BEER MIX AND MATCH", "Beer Mix and Match"],
}
