"""Export the proposed CELR family grouping as human-readable tree MD files.

Purpose: user verification BEFORE any prod change. Renders what the Products
grid WILL show once the serving path stops trusting placeholder barcodes:
every 2026-06 listing, grouped under its family, with placeholder-barcode
rows joined by NAME key only (never by the shared fake barcode).

Output goes to to_be_tested_after_code_change/celr_grouping_proposal/:
  INDEX.md            stats, method, benchmark families, placeholder report
  families_A.md ...   full tree, chunked by first letter of the family header

Reads only local parquet. Touches nothing in Postgres or the app.
"""
from __future__ import annotations

import re
import sys
from collections import defaultdict
from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.celr import family_key, is_registry_upc, norm_upc  # noqa: E402

PARQ = ROOT / "parquet_output"
OUT = ROOT / "to_be_tested_after_code_change" / "celr_grouping_proposal"
EDITION = "2026-06"

BENCHMARKS = [
    ("jim beam orange", "Jim Beam Orange"),
    ("glenlivet found", "Glenlivet Founders Reserve"),
    ("coppola", "Coppola (DC varietals must stay separate)"),
]


def to_ml(vol: str) -> float:
    s = (vol or "").strip().upper()
    m = re.match(r"([\d.]+)\s*(ML|L|LIT|LITER|OZ|GAL)?", s)
    if not m:
        return 1e12
    try:
        n = float(m.group(1))
    except ValueError:
        return 1e12
    u = m.group(2) or "ML"
    if u in ("L", "LIT", "LITER"):
        return n * 1000
    if u == "OZ":
        return n * 29.5735
    if u == "GAL":
        return n * 3785.41
    return n


def main() -> None:
    con = duckdb.connect()
    rows = con.execute(
        f"""
        SELECT wholesaler, product_name, product_type, brand, upc,
               unit_volume, unit_qty, unit_type, vintage
        FROM '{(PARQ / "derived" / "cpl_enriched.parquet").as_posix()}'
        WHERE edition = '{EDITION}'
        """
    ).fetchall()
    fams = con.execute(
        f"SELECT upc_norm, cpn, header_name, brand FROM "
        f"'{(PARQ / 'derived' / 'celr_products.parquet').as_posix()}'"
    ).fetchall()
    keys = con.execute(
        f"SELECT key, cpn FROM "
        f"'{(PARQ / 'derived' / 'celr_family_keys.parquet').as_posix()}'"
    ).fetchall()

    upc_map: dict[str, int] = {}
    fam_meta: dict[int, tuple[str, str]] = {}
    for un, cpn, header, brand in fams:
        upc_map[un] = cpn
        if cpn not in fam_meta:
            fam_meta[cpn] = (header or "", brand or "")
    key_map = {k: c for k, c in keys}

    # ---- assign every listing to a family using the FIXED serving rule ----
    # real registry barcode -> family by barcode; everything else (placeholder
    # or unknown barcode) -> family by NAME key; no key match -> standalone.
    members: dict[object, list[tuple]] = defaultdict(list)
    n_by_upc = n_by_key = n_standalone = 0
    placeholder_rows: list[tuple] = []
    for w, name, ptype, brand, upc, vol, qty, utype, vint in rows:
        un = norm_upc(upc)
        is_ph = bool(un) and not is_registry_upc(un)
        cpn = upc_map.get(un) if is_registry_upc(un) else None
        if cpn is not None:
            n_by_upc += 1
            gid: object = cpn
        else:
            k = family_key(name or "", ptype or "")
            cpn = key_map.get(k)
            if cpn is not None:
                n_by_key += 1
                gid = cpn
            else:
                n_standalone += 1
                gid = f"name:{k}"
        vs = str(vint or "").strip().lower()
        vs = "" if vs in ("", "0", "0.0", "nv", "none", "nan", "n/a") else \
            re.sub(r"\.0$", "", vs)
        rec = (w or "", name or "", ptype or "", brand or "", un,
               vol or "", qty, utype or "", vs, is_ph)
        members[gid].append(rec)
        if is_ph:
            placeholder_rows.append((gid, rec))

    # ---- render ----
    def fam_header(gid: object) -> tuple[str, str]:
        if isinstance(gid, int):
            h, b = fam_meta.get(gid, ("", ""))
            title = h or max((r[1] for r in members[gid]), key=len)
            label = f"CELR-{gid:06d}"
        else:
            title = max((r[1] for r in members[gid]), key=len)
            label = "(no CELR number: standalone by name)"
        return title, label

    def render_family(gid: object) -> list[str]:
        title, label = fam_header(gid)
        recs = members[gid]
        ptypes = sorted({r[2] for r in recs if r[2]})
        brands = sorted({r[3] for r in recs if r[3]})
        out = [f"### {title}",
               f"`{label}` · {' / '.join(ptypes) or '?'}"
               + (f" · brand: {', '.join(brands)}" if brands else "")
               + f" · {len(recs)} listing(s)", "```"]
        bysize: dict[tuple, list[tuple]] = defaultdict(list)
        for r in recs:
            bysize[(to_ml(r[5]), r[5], r[8])].append(r)
        sizes = sorted(bysize.keys(), key=lambda k: (k[0], k[2]))
        for i, sk in enumerate(sizes):
            last_size = i == len(sizes) - 1
            s_branch = "└─" if last_size else "├─"
            vint = f" · vintage {sk[2]}" if sk[2] else ""
            out.append(f"{s_branch} {sk[1] or '(no size)'}{vint}")
            rs = sorted(bysize[sk], key=lambda r: (r[0], r[1]))
            for j, r in enumerate(rs):
                pad = "   " if last_size else "│  "
                l_branch = "└─" if j == len(rs) - 1 else "├─"
                ph = " [PLACEHOLDER UPC: joined by name, not barcode]" if r[9] else ""
                try:
                    qty = f" · {int(float(r[6]))}/cs" if r[6] else ""
                except (TypeError, ValueError):
                    qty = ""
                out.append(f"{pad}{l_branch} {r[0]} · {r[1]}{qty} · UPC {r[4] or '?'}{ph}")
        out.append("```")
        out.append("")
        return out

    # order: alphabetical by family title
    ordered = sorted(members.keys(), key=lambda g: fam_header(g)[0].upper())

    OUT.mkdir(parents=True, exist_ok=True)
    for old in OUT.glob("*.md"):
        old.unlink()

    chunks: dict[str, list[object]] = defaultdict(list)
    for gid in ordered:
        first = fam_header(gid)[0][:1].upper()
        chunks[first if first.isalpha() else "0-9"].append(gid)

    files = []
    for letter in sorted(chunks):
        fname = f"families_{letter}.md"
        lines = [f"# CELR grouping proposal — families '{letter}' "
                 f"(edition {EDITION})", ""]
        for gid in chunks[letter]:
            lines.extend(render_family(gid))
        (OUT / fname).write_text("\n".join(lines), encoding="utf-8")
        files.append((fname, len(chunks[letter])))

    # ---- INDEX ----
    multi = sum(1 for g in members if len(members[g]) > 1)
    idx = [
        f"# CELR grouping proposal (edition {EDITION}) — for verification, "
        "NOT yet in prod", "",
        "Every listing of the current edition, grouped exactly as the app "
        "will group it once the placeholder-barcode fix ships. Nothing is "
        "dropped: every row appears under exactly one family.", "",
        "## Rule (fixed serving order)",
        "1. Real registry barcode -> family by barcode "
        f"({n_by_upc} listings).",
        "2. Placeholder or unknown barcode -> family by catalogue-NAME key "
        f"({n_by_key} listings). A shared fake barcode like 111111111117 is "
        "NEVER a join key.",
        f"3. No name-key match -> standalone card ({n_standalone} listings). "
        "Still shown, never hidden.", "",
        "## Stats",
        f"- listings (rows) in edition: {len(rows)}",
        f"- families/cards: {len(members)} ({multi} with more than one "
        "listing)",
        f"- placeholder-barcode listings: {len(placeholder_rows)}", "",
        "## Files",
    ]
    for fname, n in files:
        idx.append(f"- [{fname}]({fname}) — {n} families")
    idx += ["", "## Benchmark families", ""]
    for needle, label in BENCHMARKS:
        idx.append(f"### Benchmark: {label}")
        idx.append("")
        hit_gids = [g for g in ordered
                    if any(needle in r[1].lower() for r in members[g])
                    or needle in fam_header(g)[0].lower()]
        for g in hit_gids:
            idx.extend(render_family(g))
    idx += ["## Where the formerly-welded placeholder rows land now", "",
            "Rows that share fake barcode(s) and used to be welded into one "
            "card. Each now sits under its own name-keyed family:", ""]
    by_fam: dict[object, list[tuple]] = defaultdict(list)
    for gid, rec in placeholder_rows:
        by_fam[gid].append(rec)
    for gid in sorted(by_fam, key=lambda g: fam_header(g)[0].upper()):
        title, label = fam_header(gid)
        for rec in by_fam[gid]:
            idx.append(f"- {rec[0]} · `{rec[1]}` (UPC {rec[4]}) -> **{title}** "
                       f"`{label}`")
    (OUT / "INDEX.md").write_text("\n".join(idx), encoding="utf-8")

    print(f"listings: {len(rows)}  families: {len(members)}  "
          f"by_upc: {n_by_upc}  by_key: {n_by_key}  standalone: {n_standalone}")
    print(f"placeholder rows: {len(placeholder_rows)}")
    print(f"wrote {len(files) + 1} files to {OUT}")


if __name__ == "__main__":
    main()
