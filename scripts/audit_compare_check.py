"""Compare Prices audit cross-checker (analysis only, no fixes).

Joins three views of the SAME Kramer vs Shore Point comparison:
  1. DOM      - the numbers painted on /compare-prices (Playwright scrape)
  2. API      - the /api/compare/products payload the page received
  3. parquet  - cpl_enriched (the derived source of truth per edition)

and writes every suspected disagreement to an Excel file for review:

  SUSPECT (hard):
    screen-vs-api   - a painted price differs from the API value (render bug)
    spread-internal - the shown Spread disagrees with the shown net prices
    winner          - the Winner cell isn't the cheaper shown net
    ordering        - net > best QD, or best QD > list (impossible by design)
    frontline       - API list price differs from cpl_enriched frontline
                      (frontline is never date-adjusted, so this is real)
  REVIEW (soft):
    qd/net vs month - API best-QD / net differ from cpl_enriched month values;
                      can be LEGITIMATE date-aware pricing (the endpoint prices
                      live-today tiers), listed so a human can judge.

Output: Data/Enhancement/Compare Prices audit Kramer vs ShorePoint 2026-06.xlsx
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import duckdb
import openpyxl
from openpyxl.styles import Font

ROOT = Path(__file__).resolve().parent.parent
IN = ROOT / "scripts" / "_audit_compare_out.json"
OUT = ROOT / "Data" / "Enhancement" / "Compare Prices audit Kramer vs ShorePoint 2026-06.xlsx"
PARQUET = ROOT / "parquet_output" / "derived" / "cpl_enriched.parquet"
WS = ["kramer", "shore_point"]
DISPLAY = {"kramer": "Kramer", "shore_point": "Shore Point"}
TOL = 0.011


def parse_money(t: str | None) -> float | None:
    if not t:
        return None
    m = re.search(r"-?\$?\s*([\d,]+(?:\.\d+)?)", str(t))
    return float(m.group(1).replace(",", "")) if m else None


def norm(s) -> str:
    return re.sub(r"\s+", " ", str(s or "")).strip().upper()


def n_upc(v) -> str:
    s = re.sub(r"\D", "", str(v or ""))
    return s.lstrip("0")


def main() -> None:
    payload = json.loads(IN.read_text(encoding="utf-8"))
    dom, api = payload["dom"], payload["api"]
    api_rows = api["rows"]
    editions = api.get("editions", {})
    print(f"dom rows: {len(dom)}  api rows: {len(api_rows)}  editions: {editions}")

    # ---- index API rows by the same display key the DOM shows ----
    def api_key(r) -> str:
        size = f"{r.get('unit_qty')} × {r.get('unit_volume')}"
        if r.get("vintage"):
            size += f" · {r['vintage']}"
        return f"{norm(r.get('product_name'))}|{norm(size)}"

    api_idx: dict[str, dict] = {}
    for r in api_rows:
        api_idx.setdefault(api_key(r), r)

    # ---- parquet month values for both wholesalers ----
    con = duckdb.connect()
    pq = con.execute(
        f"""SELECT wholesaler, edition, CAST(upc AS VARCHAR) AS upc, product_name,
                   unit_qty, unit_volume, frontline_case_price, best_case_price,
                   effective_case_price
            FROM '{PARQUET.as_posix()}'
            WHERE wholesaler IN ('kramer', 'shore_point')""",
    ).fetchdf()
    pq_idx: dict[tuple, list[dict]] = {}
    for rec in pq.to_dict("records"):
        pq_idx.setdefault((rec["wholesaler"], rec["edition"], n_upc(rec["upc"])), []).append(rec)

    def month_row(w: str, p: dict) -> dict | None:
        rows = pq_idx.get((w, p.get("edition"), n_upc(p.get("upc"))))
        if not rows:
            return None
        if len(rows) > 1:
            named = [r for r in rows if norm(r["product_name"]) == norm(p.get("product_name"))]
            if named:
                rows = named
        return rows[0]

    suspects: list[list] = []

    def add(sev, check, name, size, where, screen, api_v, pq_v, note=""):
        d = None
        vals = [v for v in (screen, api_v, pq_v) if v is not None]
        if len(vals) >= 2:
            d = round(max(vals) - min(vals), 2)
        suspects.append([sev, check, name, size, where, screen, api_v, pq_v, d, note])

    matched = 0
    for row in dom:
        key = f"{norm(row['name'])}|{norm(row['size'])}"
        ar = api_idx.get(key)
        if ar is None:
            add("SUSPECT", "dom-row-unmatched", row["name"], row["size"], "",
                None, None, None, "DOM row could not be matched to an API row")
            continue
        matched += 1
        cells = [parse_money(c["text"]) for c in row["prices"]]
        nets = {}
        for wi, w in enumerate(WS):
            p = ar["prices"].get(w) or {}
            api_vals = [p.get("frontline"), p.get("after_qd"), p.get("effective")]
            labels = ["List", "Best QD", "Best net"]
            for j, (label, av) in enumerate(zip(labels, api_vals)):
                dv = cells[wi * 3 + j] if wi * 3 + j < len(cells) else None
                if dv is not None and av is not None and abs(dv - av) > TOL:
                    add("SUSPECT", "screen-vs-api", row["name"], row["size"],
                        f"{DISPLAY[w]} {label}", dv, av, None,
                        "painted number differs from the API payload")
            nets[w] = p.get("effective")
            # impossible layer ordering (endpoint guarantees net <= QD <= list)
            f, bq, net = api_vals
            if bq is not None and f is not None and bq > f + TOL:
                add("SUSPECT", "ordering", row["name"], row["size"],
                    f"{DISPLAY[w]} Best QD > List", bq, f, None)
            if net is not None and bq is not None and net > bq + TOL:
                add("SUSPECT", "ordering", row["name"], row["size"],
                    f"{DISPLAY[w]} Net > Best QD", net, bq, None)
            # vs parquet month values
            mr = month_row(w, p)
            if mr is None:
                add("REVIEW", "not-in-parquet", row["name"], row["size"],
                    DISPLAY[w], None, p.get("frontline"), None,
                    f"upc {p.get('upc')} edition {p.get('edition')} not in cpl_enriched")
                continue
            if f is not None and mr["frontline_case_price"] is not None \
                    and abs(f - mr["frontline_case_price"]) > TOL:
                add("SUSPECT", "frontline-vs-parquet", row["name"], row["size"],
                    f"{DISPLAY[w]} List", cells[wi * 3], f, round(mr["frontline_case_price"], 2),
                    "list price should never be date-adjusted")
            if bq is not None and mr["best_case_price"] is not None \
                    and abs(bq - mr["best_case_price"]) > TOL:
                add("REVIEW", "qd-vs-month", row["name"], row["size"],
                    f"{DISPLAY[w]} Best QD", cells[wi * 3 + 1], bq, round(mr["best_case_price"], 2),
                    "may be a dated window priced live for today")
            if net is not None and mr["effective_case_price"] is not None \
                    and abs(net - mr["effective_case_price"]) > TOL:
                add("REVIEW", "net-vs-month", row["name"], row["size"],
                    f"{DISPLAY[w]} Best net", cells[wi * 3 + 2], net, round(mr["effective_case_price"], 2),
                    "may be a dated window priced live for today")

        # spread + winner internal consistency against what's ON SCREEN
        ds = parse_money(row["spread_text"])
        vals = [v for v in nets.values() if v is not None and v > 0]
        if ds is not None and len(vals) == 2:
            exp = round(abs(vals[0] - vals[1]), 2)
            if abs(ds - exp) > TOL:
                add("SUSPECT", "spread-internal", row["name"], row["size"],
                    "Spread", ds, exp, None,
                    "shown spread disagrees with the shown net prices")
        if len(vals) == 2 and abs(vals[0] - vals[1]) > 0.005:
            cheaper = WS[0] if (nets[WS[0]] or 9e9) < (nets[WS[1]] or 9e9) else WS[1]
            wt = norm(row["winner_text"])
            if wt and "TIE" not in wt and norm(DISPLAY[cheaper]) not in wt:
                add("SUSPECT", "winner", row["name"], row["size"],
                    "Winner", row["winner_text"], DISPLAY[cheaper], None,
                    "winner cell is not the cheaper shown net")

    # ---- write the workbook ----
    wb = openpyxl.Workbook()
    s = wb.active
    s.title = "Summary"
    by_check: dict[tuple, int] = {}
    for r in suspects:
        by_check[(r[0], r[1])] = by_check.get((r[0], r[1]), 0) + 1
    s.append(["Compare Prices audit", "Kramer vs Shore Point", "route", payload.get("route", "")])
    s.append(["dom rows", len(dom), "api rows", len(api_rows)])
    s.append(["dom rows matched to api", matched])
    s.append(["editions"] + [f"{k}: {v}" for k, v in editions.items()])
    s.append([])
    s.append(["severity", "check", "count"])
    for (sev, check), n in sorted(by_check.items()):
        s.append([sev, check, n])
    for c in s[6]:
        c.font = Font(bold=True)

    d = wb.create_sheet("Findings")
    d.append(["severity", "check", "product", "size", "where",
              "screen value", "api value", "parquet (month) value", "delta", "note"])
    for c in d[1]:
        c.font = Font(bold=True)
    order = {"SUSPECT": 0, "REVIEW": 1}
    suspects.sort(key=lambda r: (order.get(r[0], 2), r[1], r[2]))
    for r in suspects:
        d.append(r)
    d.freeze_panes = "A2"
    wb.save(OUT)
    print(f"findings: {len(suspects)}  ->  {OUT}")


if __name__ == "__main__":
    main()
