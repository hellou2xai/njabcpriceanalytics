"""
CLI entry point for NJ ABC Parser ETL.

Usage:
    python run_etl.py                           # Process all files
    python run_etl.py --derive                  # Also build derived analytics Parquet
    python run_etl.py --derive-only             # Skip raw ETL, only rebuild derived
    python run_etl.py --wholesaler allied       # Process only Allied files
    python run_etl.py --dry-run                 # Parse only, don't write Parquet
    python run_etl.py --data-dir ./Data --output-dir ./parquet_output
"""

import argparse
import logging
import sys
from pathlib import Path

# Add project root to path
sys.path.insert(0, str(Path(__file__).parent))

from nj_abc_parser.etl import run_etl
from nj_abc_parser.registry import list_wholesalers


def main():
    parser = argparse.ArgumentParser(
        description="NJ ABC eCPL Parser — Excel to Parquet ETL"
    )
    parser.add_argument(
        "--data-dir", default="Data",
        help="Directory containing Excel price files (default: Data)"
    )
    parser.add_argument(
        "--output-dir", default="parquet_output",
        help="Directory for Parquet output (default: parquet_output)"
    )
    parser.add_argument(
        "--wholesaler", default=None,
        help="Process only this wholesaler slug (e.g., allied, fedway, opici, peerless, high_grade)"
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Parse files but don't write Parquet output"
    )
    parser.add_argument(
        "--list", action="store_true",
        help="List registered wholesalers and exit"
    )
    parser.add_argument(
        "--derive", action="store_true",
        help="Also build derived analytics Parquet files after ETL"
    )
    parser.add_argument(
        "--derive-only", action="store_true",
        help="Skip raw ETL, only rebuild derived Parquet files"
    )
    parser.add_argument(
        "--verbose", "-v", action="store_true",
        help="Enable debug logging"
    )

    args = parser.parse_args()

    # Configure logging
    level = logging.DEBUG if args.verbose else logging.INFO
    logging.basicConfig(
        level=level,
        format="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%H:%M:%S",
    )

    if args.list:
        print("\nRegistered Wholesalers:")
        for cfg in list_wholesalers():
            patterns = cfg.get("file_pattern", [])
            if isinstance(patterns, str):
                patterns = [patterns]
            print(f"  {cfg['slug']:15s} — {cfg['name']}")
            for p in patterns:
                print(f"  {'':15s}   file pattern: {p}")
        return

    # Derive-only mode: skip raw ETL
    if args.derive_only:
        from nj_abc_parser.derive import build_all
        build_all(parquet_dir=args.output_dir)
        return

    data_dir = Path(args.data_dir)
    if not data_dir.exists():
        print(f"Error: Data directory '{data_dir}' does not exist")
        sys.exit(1)

    summary = run_etl(
        data_dir=data_dir,
        output_dir=args.output_dir,
        wholesaler_slug=args.wholesaler,
        dry_run=args.dry_run,
    )

    # Build derived files if requested and ETL succeeded
    if args.derive and not args.dry_run and not summary["errors"]:
        from nj_abc_parser.derive import build_all
        build_all(parquet_dir=args.output_dir)

    sys.exit(1 if summary["errors"] else 0)


if __name__ == "__main__":
    main()
