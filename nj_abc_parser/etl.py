"""
ETL Pipeline — Excel → Parquet.

Scans a data directory, auto-detects wholesaler + edition for each file,
parses all sheets, and writes Hive-partitioned Parquet files.

Output structure:
    output_dir/
        cpl/wholesaler=allied/edition=2026-04/data.parquet
        rip/wholesaler=allied/edition=2026-04/data.parquet
        combo/wholesaler=allied/edition=2026-04/data.parquet
        beer_mm/wholesaler=allied/edition=2026-04/data.parquet
"""

import logging
from pathlib import Path

import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

from nj_abc_parser.base_parser import NJABCParser
from nj_abc_parser.registry import (
    detect_wholesaler, parse_edition_from_filename, edition_year_from_submission,
)

logger = logging.getLogger("nj_abc_parser")


def run_etl(
    data_dir: str | Path,
    output_dir: str | Path,
    wholesaler_slug: str | None = None,
    dry_run: bool = False,
) -> dict:
    """
    Run the full ETL pipeline.

    Args:
        data_dir: Path to directory containing Excel files
        output_dir: Path to write Parquet files
        wholesaler_slug: If set, only process files for this wholesaler
        dry_run: If True, parse but don't write Parquet

    Returns:
        Summary dict with counts per wholesaler/sheet
    """
    data_dir = Path(data_dir)
    output_dir = Path(output_dir)
    summary = {"files_processed": 0, "files_skipped": 0, "errors": [], "details": []}

    # Find all Excel files
    excel_files = sorted(data_dir.glob("*.xlsx"))
    logger.info(f"Found {len(excel_files)} Excel files in {data_dir}")

    for filepath in excel_files:
        # Skip temp files
        if filepath.name.startswith("~") or filepath.name.startswith("_tmp"):
            continue

        # Detect wholesaler
        config = detect_wholesaler(filepath)
        if config is None:
            logger.warning(f"SKIP: Cannot detect wholesaler for '{filepath.name}'")
            summary["files_skipped"] += 1
            continue

        # Filter by slug if requested
        if wholesaler_slug and config["slug"] != wholesaler_slug:
            continue

        # Parse edition from filename
        edition_info = parse_edition_from_filename(filepath)
        # Year-less filename (month present, no 4-digit year — e.g. Wine
        # Enterprises): take the YEAR from the file's SUBMISSION DATE, keep the
        # filename's MONTH (which distinguishes the June vs July file).
        if edition_info["edition"] is None and edition_info.get("month"):
            yr = edition_year_from_submission(filepath)
            if yr:
                edition_info = {
                    "year": yr, "month": edition_info["month"],
                    "edition": f"{yr}-{int(edition_info['month']):02d}",
                }
                logger.info(f"  edition year {yr} from submission date "
                            f"(filename had no year) → {edition_info['edition']}")
        if edition_info["edition"] is None:
            logger.warning(f"SKIP: Cannot parse edition from '{filepath.name}'")
            summary["files_skipped"] += 1
            continue

        slug = config["slug"]
        edition = edition_info["edition"]
        logger.info(f"Processing: {filepath.name} → {slug}/{edition}")

        try:
            parser = NJABCParser(config)
            sheets = parser.parse_file(filepath)

            file_detail = {
                "file": filepath.name,
                "wholesaler": slug,
                "edition": edition,
                "sheets": {},
            }

            for sheet_type, df in sheets.items():
                # Add metadata columns
                df.insert(0, "wholesaler", slug)
                df.insert(1, "edition", edition)
                df.insert(2, "year", edition_info["year"])
                df.insert(3, "month", edition_info["month"])

                row_count = len(df)
                file_detail["sheets"][sheet_type] = row_count

                if not dry_run:
                    _write_parquet(df, output_dir, sheet_type, slug, edition)

                logger.info(f"  {sheet_type}: {row_count} rows {'(dry run)' if dry_run else '→ parquet'}")

            summary["files_processed"] += 1
            summary["details"].append(file_detail)

        except Exception as e:
            logger.error(f"ERROR processing {filepath.name}: {e}", exc_info=True)
            summary["errors"].append({"file": filepath.name, "error": str(e)})

    _print_summary(summary)
    return summary


def _write_parquet(df: pd.DataFrame, output_dir: Path,
                   sheet_type: str, slug: str, edition: str):
    """Write a DataFrame to Hive-partitioned Parquet."""
    part_dir = output_dir / sheet_type / f"wholesaler={slug}" / f"edition={edition}"
    part_dir.mkdir(parents=True, exist_ok=True)

    out_path = part_dir / "data.parquet"

    # Convert datetime columns to date for cleaner Parquet
    for col in df.columns:
        if pd.api.types.is_datetime64_any_dtype(df[col]):
            df[col] = df[col].dt.date

    table = pa.Table.from_pandas(df, preserve_index=False)
    pq.write_table(table, out_path)
    logger.debug(f"  Written: {out_path}")


def _print_summary(summary: dict):
    """Print a human-readable ETL summary."""
    print("\n" + "=" * 60)
    print("NJ ABC Parser — ETL Summary")
    print("=" * 60)
    print(f"Files processed: {summary['files_processed']}")
    print(f"Files skipped:   {summary['files_skipped']}")
    print(f"Errors:          {len(summary['errors'])}")

    if summary["details"]:
        print("\nDetails:")
        for d in summary["details"]:
            sheets_str = ", ".join(f"{k}: {v} rows" for k, v in d["sheets"].items())
            print(f"  {d['wholesaler']}/{d['edition']} — {sheets_str}")

    if summary["errors"]:
        print("\nErrors:")
        for e in summary["errors"]:
            print(f"  {e['file']}: {e['error']}")

    print("=" * 60 + "\n")
