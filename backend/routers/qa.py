"""
QA API — agentic variance scan with root-cause classification.

Wraps backend.services.qa_engine. Exposes a full scan (findings + summary) and
a lightweight summary-only endpoint. Designed to be re-run after every ETL and
to back a CI gate (see qa_scan.py at the project root).
"""

from typing import List, Optional

from fastapi import APIRouter, Query

from backend.services import qa_engine

router = APIRouter(prefix="/api/qa", tags=["qa"])


def _parse_checks(check: Optional[List[str]]) -> Optional[list]:
    """Accept ?check=a&check=b (repeatable) or ?check=a,b (comma list)."""
    if not check:
        return None
    out = []
    for c in check:
        if c is None:
            continue
        out.extend(part.strip() for part in c.split(",") if part.strip())
    return out or None


@router.get("/scan")
def scan(
    threshold: float = Query(qa_engine.VARIANCE_THRESHOLD, ge=0,
                             description="Variance threshold as a fraction (0.05 = 5%)"),
    wholesaler: Optional[str] = Query(None, description="Restrict to one distributor slug"),
    check: Optional[List[str]] = Query(
        None, description="Detector(s) to run; repeatable or comma-separated. One of "
                          "edition_price_moves, cross_distributor_gaps, calc_bugs, "
                          "pack_size_mismatch, vintage_placeholder_dupe."),
    limit: int = Query(200, ge=1, le=5000, description="Max rows per detector"),
):
    """Run the full variance scan and return findings + summary."""
    return qa_engine.run_scan(
        threshold=threshold,
        wholesaler=wholesaler,
        checks=_parse_checks(check),
        limit_per_check=limit,
    )


@router.get("/summary")
def summary(
    threshold: float = Query(qa_engine.VARIANCE_THRESHOLD, ge=0),
    wholesaler: Optional[str] = Query(None),
    check: Optional[List[str]] = Query(None),
    limit: int = Query(200, ge=1, le=5000),
):
    """Return just the summary block (counts by severity / root cause / check)."""
    result = qa_engine.run_scan(
        threshold=threshold,
        wholesaler=wholesaler,
        checks=_parse_checks(check),
        limit_per_check=limit,
    )
    return {
        "threshold": result["threshold"],
        "generated_at": result["generated_at"],
        "wholesaler": result["wholesaler"],
        "checks_run": result["checks_run"],
        "summary": result["summary"],
    }
