"""ONE-COMMAND monthly edition load. Runs every post-parsing step in order so
a new month (drop the distributor workbooks into Data/, then run this) comes
out with ALL the data rules applied — nothing to remember, nothing to redo.

    python scripts/monthly_load.py 2026-07
    python scripts/monthly_load.py 2026-07 --local-only     # no prod writes
    python scripts/monthly_load.py 2026-07 --skip-etl       # parquet already built
    python scripts/monthly_load.py 2026-07 --skip-semantic  # no Voyage key here

Steps (each prints PASS/FAIL; the run stops on a hard failure):
  1. ETL + derive        run_etl.py --derive (parses Data/, rebuilds
                         cpl_enriched with every derive.py rule: eligibility,
                         effective price, rip_windows, ...)
  2. Ingest              ingest_to_postgres.py --all --edition <ed>
                         (local + prod partition replace)
  3. CELR registry       build_celr_products.py against local AND prod
                         Postgres (incremental: new UPCs join families or
                         mint CPNs; wine headers stored year-free)
  4. Semantic index      build_semantic_index.py against local AND prod
                         (embeds new products; FTS refreshes on app startup)
  5. Prod cache reload   POST /api/admin/reload-pricing with
                         CELR_ADMIN_EMAIL / CELR_ADMIN_PASSWORD from the
                         environment or .env; otherwise prints the manual
                         step (Admin page -> Reload pricing cache)
  6. Verification        - CELR benchmarks (Jim Beam Orange / Glenlivet
                           Founders one family each; Coppola DC varietals
                           separate)
                         - RIP membership mismatch workbook regenerated for
                           the new edition (v3 rules) with the
                           UPCs-not-in-CPL count

Optional manual follow-up (user deliverable, not automated): Qualified
Quantity column on the month's Enhancement workbooks via
scripts/add_qualified_qty.py (file paths are month-specific).
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PY = sys.executable


def load_env() -> dict:
    env = dict(os.environ)
    env_file = ROOT / ".env"
    if env_file.exists():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    return env


def run(label: str, cmd: list[str], env: dict | None = None,
        hard: bool = True) -> bool:
    print(f"\n=== {label} ===\n    {' '.join(cmd)}")
    r = subprocess.run(cmd, cwd=ROOT, env=env)
    ok = r.returncode == 0
    print(f"--- {label}: {'PASS' if ok else 'FAIL'}")
    if not ok and hard:
        sys.exit(f"ABORTED at step: {label}")
    return ok


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("edition", help="The new edition, e.g. 2026-07")
    ap.add_argument("--local-only", action="store_true",
                    help="No prod writes (ingest local only, registry/semantic local only)")
    ap.add_argument("--skip-etl", action="store_true")
    ap.add_argument("--skip-semantic", action="store_true")
    args = ap.parse_args()
    ed = args.edition

    env = load_env()
    prod_url = (env.get("RENDER_EXTERNAL_DATABASE_URL") or "").strip()
    if not args.local_only and not prod_url:
        sys.exit("RENDER_EXTERNAL_DATABASE_URL not set (.env) — use --local-only or set it")
    prod_env = {**env, "DATABASE_URL": prod_url, "PRICING_SOURCE": env.get("PRICING_SOURCE", "")}

    # 1. ETL + derive — every derive.py rule applies to the new edition here.
    if not args.skip_etl:
        run("ETL + derive", [PY, "run_etl.py", "--derive"], env=env)

    # 2. Ingest (local always; prod unless --local-only).
    ingest_cmd = [PY, "scripts/ingest_to_postgres.py", "--edition", ed]
    if not args.local_only:
        ingest_cmd.append("--all")
    run("Ingest to Postgres", ingest_cmd, env=env)

    # 3. CELR registry — incremental; existing CPNs never change.
    run("CELR registry (local)", [PY, "scripts/build_celr_products.py"], env=env)
    if not args.local_only:
        run("CELR registry (prod)", [PY, "scripts/build_celr_products.py"], env=prod_env)

    # 4. Semantic index — new products embed; soft-fail (no Voyage key locally
    #    is fine, the FTS fallback still works and startup ensures the index).
    if not args.skip_semantic:
        run("Semantic index (local)", [PY, "scripts/build_semantic_index.py"],
            env=env, hard=False)
        if not args.local_only:
            run("Semantic index (prod)", [PY, "scripts/build_semantic_index.py"],
                env=prod_env, hard=False)

    # 5. Prod cache reload.
    if not args.local_only:
        email = env.get("CELR_ADMIN_EMAIL", "").strip()
        pw = env.get("CELR_ADMIN_PASSWORD", "").strip()
        if email and pw:
            try:
                import requests
                base = env.get("CELR_PROD_URL", "https://nj.celr.ai").rstrip("/")
                s = requests.Session()
                lr = s.post(f"{base}/api/auth/login",
                            json={"email": email, "password": pw}, timeout=30)
                lr.raise_for_status()
                tok = lr.json().get("access_token") or lr.json().get("token")
                hdr = {"Authorization": f"Bearer {tok}"} if tok else {}
                rr = s.post(f"{base}/api/admin/reload-pricing", headers=hdr, timeout=300)
                print(f"--- Prod reload: HTTP {rr.status_code}")
            except Exception as e:
                print(f"--- Prod reload FAILED ({e}) — trigger it from the "
                      "Admin page (Reload pricing cache).")
        else:
            print("\n=== Prod cache reload ===\nCELR_ADMIN_EMAIL/PASSWORD not set — "
                  "trigger it from the Admin page (Reload pricing cache) or redeploy.")

    # 6. Verification.
    run("Verify: CELR benchmarks", [PY, "scripts/verify_celr_benchmarks.py", ed],
        env=env, hard=False)
    run("Verify: RIP mismatch workbook",
        [PY, "scripts/analyze_rip_membership_mismatch_v3.py", "--edition", ed],
        env=env, hard=False)

    print(f"\nDONE: edition {ed} loaded with all post-parsing steps applied.")
    print("Optional: Qualified Quantity workbook annotation "
          "(scripts/add_qualified_qty.py, month-specific file paths).")


if __name__ == "__main__":
    main()
