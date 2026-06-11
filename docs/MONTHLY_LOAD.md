# Monthly edition load — the one-command runbook

Written 2026-06-11 so the July 2026 load (and every month after) needs no
re-doing of the June data fixes. Everything below is already code; the only
monthly inputs are the distributor workbooks.

## The short version

1. Drop the month's distributor Excel files into `Data/` (same folders as
   always).
2. Run:

       python scripts/monthly_load.py 2026-07

3. Read the PASS/FAIL lines. Done.

`--local-only` skips all prod writes (dry run on this machine);
`--skip-etl` reuses already-built parquet; `--skip-semantic` skips the
Voyage embedding step.

## What the command runs, in order

| Step | Script | What it bakes in |
|---|---|---|
| ETL + derive | `run_etl.py --derive` | All parsing + every derive.py rule: RIP eligibility (sheet presence by UPC, single vs multi listing), effective prices, rip_windows, time-sensitive flags |
| Ingest | `scripts/ingest_to_postgres.py --all --edition <ed>` | Partition-replace into local AND prod Postgres |
| CELR registry | `scripts/build_celr_products.py` (local + prod) | New UPCs join existing families or mint new CPNs (numbers never change); name-first clustering; placeholder barcodes never identity nodes; wine headers stored without vintage years |
| Semantic index | `scripts/build_semantic_index.py` (local + prod, soft-fail) | Embeddings for new products; FTS index re-ensures itself on app startup |
| Prod cache reload | `/api/admin/reload-pricing` (auto with `CELR_ADMIN_EMAIL`/`CELR_ADMIN_PASSWORD` in `.env`, else click Admin → Reload pricing cache) | Prod serves the new edition without a redeploy |
| Verify: benchmarks | `scripts/verify_celr_benchmarks.py <ed>` | Jim Beam Orange one family; Glenlivet Founders one family; Coppola varietals separate |
| Verify: RIP membership | `scripts/analyze_rip_membership_mismatch_v3.py --edition <ed>` | Fresh mismatch workbook in Data/Enhancement with the UPCs-not-in-CPL count highlighted |

## Rules that are CODE, not steps (apply automatically to any edition)

- Placeholder barcodes (`111111111117`, `999999999993`, all-same-digit, `'1'`,
  sub-8-digit junk) are never join/group/fetch keys anywhere serving-side
  (`_is_clean_upc` / `_VALID_UPC_SQL` / `celr.is_registry_upc` /
  `lib/upc.ts isRealUpc`). Rows carrying one stay visible, joined by name
  or by RIP-code reference.
- RIP combo membership: sheet barcodes join by real barcode; every CPL row
  whose own rip_code references the code is a member; real sheet barcodes
  missing from the CPL show as visible stubs.
- Multi-RIP programs never blend: per-tier `code` everywhere, one ladder
  block per program, `rip_choice` on cart/list lines, better-RIP
  suggestions.
- Wine family headers display without vintage years (`celr.display_header`,
  applied at serving AND stored clean by the registry builder).

## Optional monthly extras (run only when asked)

- `scripts/add_qualified_qty.py` — writes the Qualified Quantity column into
  the month's Enhancement CPL workbooks (file paths are month-specific;
  annotation only, no pricing math).
- `scripts/export_celr_tree.py <ed>` — regenerates the grouping-verification
  tree MD into `to_be_tested_after_code_change/celr_grouping_proposal`.
  Required BEFORE shipping any grouping-algorithm change; not needed for a
  routine load.

## If something fails

- The command aborts at the failed step; rerun just that script (each is
  idempotent) and then rerun `monthly_load.py` with the matching `--skip-*`
  flags for what already passed.
- Prod Postgres connection drops on long writes: the registry builder
  already streams with COPY; ingest is partition-replace and safe to rerun.
- Render deploy/cache quirks: see the Render notes in CLAUDE.md and the
  Admin page's Reload pricing cache button.
