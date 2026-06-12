"""Verify rip_credits + credit-scaled effective prices in derived parquet."""
import duckdb

con = duckdb.connect()
cr = "read_parquet('parquet_output/derived/rip_credits.parquet')"
en = "read_parquet('parquet_output/derived/cpl_enriched.parquet')"

print("--- rip_credits summary ---")
print(con.sql(f"""
  SELECT wholesaler, edition, count(*) rows_,
         sum(CASE WHEN case_credit < 1 THEN 1 ELSE 0 END) AS credit_lt1,
         sum(CASE WHEN case_credit > 1 THEN 1 ELSE 0 END) AS credit_gt1,
         sum(CASE WHEN split_pack IS NOT NULL THEN 1 ELSE 0 END) AS splits
  FROM {cr} GROUP BY 1,2 ORDER BY 1,2
""").df().to_string(index=False))

print("\n--- Grand Marnier 375x12 (credit 0.5: rebate halved) ---")
print(con.sql(f"""
  SELECT edition, product_name, unit_volume, unit_qty,
         frontline_case_price, rip_savings, effective_case_price
  FROM {en}
  WHERE wholesaler='allied' AND upc='649188900469' AND edition='2026-06'
""").df().to_string(index=False))

print("\n--- Don Q 1.75L (split rule: rebate UNCHANGED) ---")
print(con.sql(f"""
  SELECT edition, product_name, unit_volume, rip_savings, effective_case_price
  FROM {en}
  WHERE wholesaler='allied' AND upc IN ('82301175014','82301175021')
    AND edition='2026-06'
""").df().to_string(index=False))

print("\n--- control: a no-rule RIP product unchanged (June, allied, has_rip, no credit row) ---")
print(con.sql(f"""
  SELECT e.product_name, e.rip_savings, e.effective_case_price
  FROM {en} e
  LEFT JOIN {cr} c ON c.wholesaler=e.wholesaler AND c.edition=e.edition
       AND c.upc = LTRIM(CAST(e.upc AS VARCHAR),'0')
  WHERE e.wholesaler='allied' AND e.edition='2026-06' AND e.has_rip
    AND c.upc IS NULL
  ORDER BY e.rip_savings DESC LIMIT 3
""").df().to_string(index=False))
