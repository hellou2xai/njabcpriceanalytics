#!/usr/bin/env python
"""Capture golden API snapshots for the Render / Postgres migration.

Hits a running backend and saves normalised JSON responses so the exact same
calls can be replayed after each migration phase and diffed. Any difference is
a regression to fix. This is the safety net for "exact same features".

Two groups of calls:
  1. Read-only pricing/analytics endpoints, called anonymously so the output is
     deterministic and user-independent. These must match byte-for-byte after
     migration (same Parquet data, same DuckDB engine).
  2. A scripted auth + user-data flow (signup, create order/line/note, etc.)
     that builds known state from scratch and reads it back. ids, timestamps
     and tokens are blanked so the read-backs can be diffed across engines even
     though the underlying row ids differ.

Usage:
    python scripts/snapshot_api.py --label baseline
    python scripts/snapshot_api.py --label postgres --base-url http://127.0.0.1:8000

Output: tests/golden/<label>/<name>.json  and  tests/golden/<label>/manifest.json
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import uuid
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parent.parent
GOLDEN_DIR = ROOT / "tests" / "golden"

# Keys whose values are not stable across a data migration (row ids, audit
# timestamps, bearer tokens). Blanked before saving the user-data read-backs.
VOLATILE_KEYS = {
    "id", "order_id", "line_id", "rep_id", "sales_rep_id", "division_id",
    "store_id", "user_id", "note_id", "item_id", "token", "created_at",
    "updated_at", "expires_at", "email", "generated_at",
}

# A fresh golden account per run keeps the user-data read-backs clean and
# deterministic (no accumulation), so the same scripted flow yields identical
# normalised output on either engine. Email is normalised out of the bodies.
GOLDEN_PW = "golden-pw-12345"


def normalise(obj, strip_ids: bool):
    """Round floats for fp stability; optionally blank volatile id/time keys."""
    if isinstance(obj, float):
        return round(obj, 4)
    if isinstance(obj, list):
        return [normalise(x, strip_ids) for x in obj]
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            if strip_ids and k in VOLATILE_KEYS:
                out[k] = "<volatile>"
            else:
                out[k] = normalise(v, strip_ids)
        return out
    return obj


def _safe_name(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", name).strip("_")


def _rows(body):
    """Pull the row list out of a response that may be a bare list or a paged
    envelope ({items|results: [...]})."""
    if isinstance(body, list):
        return body
    if isinstance(body, dict):
        for key in ("items", "results", "rows", "data"):
            if isinstance(body.get(key), list):
                return body[key]
    return []


def _pick(rows):
    """Deterministically choose one row from a possibly tie-ordered result, so
    the scripted write flow builds identical state on every run/engine."""
    if not rows:
        return None
    return sorted(rows, key=lambda r: json.dumps(r, sort_keys=True, default=str))[0]


class Snapshotter:
    def __init__(self, base_url: str, label: str):
        self.base = base_url.rstrip("/")
        self.out = GOLDEN_DIR / label
        self.out.mkdir(parents=True, exist_ok=True)
        self.client = httpx.Client(timeout=120.0)
        self.token: str | None = None
        self.email = f"golden-{uuid.uuid4().hex[:8]}@example.test"
        self.manifest: list[dict] = []

    # -- core request + capture ------------------------------------------------
    def call(self, name, method, path, *, params=None, json_body=None,
             auth=False, strip_ids=False, date_sensitive=False, save=True):
        headers = {}
        if auth and self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        url = self.base + path
        try:
            resp = self.client.request(method, url, params=params, json=json_body, headers=headers)
            status = resp.status_code
            try:
                body = resp.json()
            except Exception:
                body = {"_non_json_text": resp.text[:2000]}
        except Exception as e:  # network / timeout
            status, body = -1, {"_error": repr(e)}

        norm = normalise(body, strip_ids)
        if save:
            entry = {
                "name": name,
                "request": {"method": method, "path": path, "params": params, "auth": auth},
                "status": status,
                "date_sensitive": date_sensitive,
                "body": norm,
            }
            (self.out / f"{_safe_name(name)}.json").write_text(
                json.dumps(entry, indent=2, sort_keys=True, ensure_ascii=False)
            )
            self.manifest.append({
                "name": name, "method": method, "path": path, "params": params,
                "auth": auth, "status": status, "date_sensitive": date_sensitive,
            })
            flag = " [date-sensitive]" if date_sensitive else ""
            print(f"  {status:>4}  {method:5} {path}{flag}")
        return status, body

    # -- read-only pricing / analytics (anonymous, deterministic) --------------
    def capture_readonly(self):
        print("Read-only pricing/analytics endpoints (anonymous):")
        ro = [
            ("health", "/api/health", None),
            ("analytics_dashboard", "/api/analytics/dashboard", None),
            # Limits set to each endpoint's max so the FULL result set is
            # captured where possible. A complete set is order-stable under the
            # recursive-canonical compare; a truncated subset over a tie-ordered
            # query is not.
            ("analytics_price_movers", "/api/analytics/price-movers", {"limit": 100}),
            ("analytics_lifecycle", "/api/analytics/lifecycle", {"limit": 1000}),
            ("analytics_cross_source", "/api/analytics/cross-source", {"limit": 1000}),
            ("analytics_category_trends", "/api/analytics/category-trends", None),
            ("catalog_search_q", "/api/catalog/search", {"q": "glenlivet", "limit": 1000}),
            ("catalog_facets", "/api/catalog/facets", None),
            ("catalog_editions", "/api/catalog/editions", None),
            ("catalog_categories", "/api/catalog/categories", None),
            ("catalog_cross_distributor", "/api/catalog/cross-distributor", {"limit": 50000}),
            ("catalog_cross_distributor_combined", "/api/catalog/cross-distributor-combined", {"limit": 50000}),
            ("catalog_qa_anomalies", "/api/catalog/qa/anomalies", {"limit": 25}),
            ("catalog_distributor_exclusive", "/api/catalog/distributor-exclusive",
             {"distributor": "allied", "compared_to": "fedway", "limit": 50000}),
            ("deals_discounts", "/api/deals/discounts", {"limit": 1000}),
            ("deals_clearance", "/api/deals/clearance", {"limit": 1000}),
            ("deals_combo_index", "/api/deals/combo-index", None),
            ("deals_combos", "/api/deals/combos", {"limit": 100000}),
            ("deals_rips", "/api/deals/rips", {"limit": 1000}),
            ("deals_rip_products", "/api/deals/rip-products", {"limit": 1000}),
            ("intelligence_buy_signals", "/api/intelligence/buy-signals", {"limit": 1000}),
            ("intelligence_buy_sheet", "/api/intelligence/buy-sheet", None),
            ("qa_scan", "/api/qa/scan", None),
            ("qa_summary", "/api/qa/summary", None),
        ]
        for name, path, params in ro:
            self.call(name, "GET", path, params=params)

        # Date-sensitive: depends on CURRENT_DATE. Same engine + data -> identical
        # on the same calendar day. Flagged so the diff step can run same-day.
        self.call("deals_time_sensitive", "GET", "/api/deals/time-sensitive",
                  params={"limit": 20000}, date_sensitive=True)
        self.call("deals_time_sensitive_past", "GET", "/api/deals/time-sensitive",
                  params={"limit": 20000, "include_past": "true"}, date_sensitive=True)

    # -- dynamic, product-specific read-only (primed from search) --------------
    def capture_product_specific(self):
        print("Product-specific read-only endpoints (primed from search):")
        _, body = self.call("_prime_search", "GET", "/api/catalog/search",
                            params={"limit": 5}, save=False)
        sample = _pick(_rows(body))
        if not sample:
            print("  (no sample product available, skipping)")
            return
        ws = sample.get("wholesaler")
        pn = sample.get("product_name")
        upc = sample.get("upc")
        uv = sample.get("unit_volume")
        common = {"upc": upc, "unit_volume": uv}
        self.call("catalog_product", "GET", f"/api/catalog/product/{ws}/{pn}", params=common)
        self.call("catalog_product_breakdown", "GET", f"/api/catalog/product-breakdown/{ws}/{pn}", params=common)
        self.call("catalog_price_history", "GET", f"/api/catalog/price-history/{ws}/{pn}", params=common)

    # -- scripted auth + user-data flow (authed, ids blanked) ------------------
    def capture_user_flow(self):
        print("Auth + user-data write/read flow (authed):")
        # Fresh user each run (unique email), so read-backs never accumulate.
        s, b = self.call("auth_signup", "POST", "/api/auth/signup", save=False,
                         json_body={"email": self.email, "password": GOLDEN_PW, "full_name": "Golden Snapshot", "phone": "201-555-0100"})
        if s == 409:
            s, b = self.call("auth_login", "POST", "/api/auth/login", save=False,
                            json_body={"email": self.email, "password": GOLDEN_PW})
        if isinstance(b, dict):
            self.token = b.get("token")
        if not self.token:
            print("  (could not authenticate golden user; skipping user-data flow)")
            return

        self.call("auth_me", "GET", "/api/auth/me", auth=True, strip_ids=True)

        # An allied product for an allied-scoped order line.
        _, sb = self.call("_prime_allied", "GET", "/api/catalog/search",
                         params={"wholesaler": "allied", "limit": 50}, save=False)
        prod = _pick(_rows(sb))

        # division + sales rep
        self.call("create_division", "POST", "/api/divisions", auth=True, save=False,
                  json_body={"name": "Golden Division"})
        _, rep = self.call("create_sales_rep", "POST", "/api/sales-reps", auth=True, save=False,
                          json_body={"name": "Golden Rep", "division": "Golden Division",
                                     "distributor": "allied", "email": "rep@example.test", "phone": "555-0100"})
        rep_id = rep.get("id") if isinstance(rep, dict) else None

        # order scoped to allied + rep
        _, order = self.call("create_order", "POST", "/api/orders", auth=True, save=False,
                           json_body={"name": "Golden Order", "distributor": "allied",
                                      "sales_rep_id": rep_id, "notes": "golden order note"})
        order_id = order.get("id") if isinstance(order, dict) else None

        if order_id and prod:
            self.call("add_order_line", "POST", f"/api/orders/{order_id}/lines", auth=True, save=False,
                      json_body={"product_name": prod.get("product_name"), "wholesaler": "allied",
                                 "upc": prod.get("upc"), "unit_volume": prod.get("unit_volume"),
                                 "qty_cases": 5, "qty_units": 0})

        # add a combo to the order (allied combo)
        _, cb = self.call("_prime_combo", "GET", "/api/deals/combos",
                         params={"wholesaler": "allied", "limit": 50}, save=False)
        combo = _pick(_rows(cb))
        if order_id and combo:
            self.call("add_combo_to_order", "POST", f"/api/orders/{order_id}/add-combo", auth=True, save=False,
                      json_body={"wholesaler": "allied", "combo_code": combo.get("combo_code")})

        # a product note + a watchlist entry
        if prod:
            self.call("add_note", "POST", "/api/notes", auth=True, save=False,
                      json_body={"product_name": prod.get("product_name"), "wholesaler": "allied",
                                 "note": "golden snapshot note"})
            self.call("add_watchlist", "POST", "/api/watchlist", auth=True, save=False,
                      json_body={"product_name": prod.get("product_name"), "wholesaler": "allied",
                                 "upc": prod.get("upc"), "unit_volume": prod.get("unit_volume"),
                                 "target_price": 9.99, "notes": "golden"})

        # -- read everything back (these are the diffable artefacts) --
        self.call("get_divisions", "GET", "/api/divisions", auth=True, strip_ids=True)
        self.call("get_sales_reps", "GET", "/api/sales-reps", auth=True, strip_ids=True)
        self.call("get_orders", "GET", "/api/orders", auth=True, strip_ids=True)
        self.call("get_orders_draft", "GET", "/api/orders", params={"status": "draft"}, auth=True, strip_ids=True)
        self.call("get_orders_plan", "GET", "/api/orders/plan", auth=True, strip_ids=True)
        if order_id:
            self.call("get_order_detail", "GET", f"/api/orders/{order_id}", auth=True, strip_ids=True)
            self.call("get_order_scorecard", "GET", f"/api/intelligence/order-scorecard/{order_id}", auth=True, strip_ids=True)
        self.call("get_watchlist", "GET", "/api/watchlist", auth=True, strip_ids=True)
        self.call("get_notes_all", "GET", "/api/notes/all", auth=True, strip_ids=True)
        self.call("get_missed_opportunities", "GET", "/api/intelligence/missed-opportunities", auth=True, strip_ids=True)
        self.call("get_alerts", "GET", "/api/alerts", auth=True, strip_ids=True)
        self.call("get_alerts_unread", "GET", "/api/alerts/unread-count", auth=True, strip_ids=True)
        self.call("get_stores", "GET", "/api/stores", auth=True, strip_ids=True)

    def finish(self):
        (self.out / "manifest.json").write_text(
            json.dumps({"base_url": self.base, "count": len(self.manifest),
                        "entries": self.manifest}, indent=2, sort_keys=True)
        )
        self.client.close()
        print(f"\nSaved {len(self.manifest)} snapshots to {self.out}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", default="http://127.0.0.1:8000")
    ap.add_argument("--label", required=True, help="e.g. 'baseline' or 'postgres'")
    args = ap.parse_args()

    print(f"Snapshotting {args.base_url} -> tests/golden/{args.label}\n")
    snap = Snapshotter(args.base_url, args.label)
    # Fail fast if the server is not up.
    try:
        snap.client.get(snap.base + "/api/health")
    except Exception as e:
        print(f"ERROR: backend not reachable at {snap.base} ({e})")
        sys.exit(1)
    snap.capture_readonly()
    snap.capture_product_specific()
    snap.capture_user_flow()
    snap.finish()


if __name__ == "__main__":
    main()
