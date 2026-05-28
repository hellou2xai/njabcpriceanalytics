"""Pre-generate plain-English product explanations for the detail modal.

Aimed at a layman buyer who opens a product on the catalog and wants to
understand:
  - What this product is, in one line.
  - What the case and per-bottle list price are.
  - What the discounts mean in real money (not the jargon "CPL discount tier
    3" but "buy 5+ cases and you save $15 per case").
  - What the RIP rebate is, what they need to buy to qualify, and how much it
    stacks on top of the regular discount.
  - The best price they can actually achieve and how to get there.

Run after each pricing-cache rebuild, same trigger as backend.ai_blurbs. Off
automatically when ANTHROPIC_API_KEY is not set. Bumping `_BLURB_VERSION`
re-writes every existing row with the new prompt's output.
"""
from __future__ import annotations
import os
import threading
from datetime import date as _date

from backend.db import get_duckdb
from backend.pg import get_pg
from backend.pricing_cache import get_pricing_path

_BLURB_VERSION = "v1"

_MODEL = os.getenv("CELR_PRODUCT_BLURB_AI_MODEL",
                   os.getenv("CELR_BLURB_AI_MODEL",
                             os.getenv("CELR_SEARCH_AI_MODEL", "claude-sonnet-4-6")))
_MAX_PER_RUN = int(os.getenv("CELR_PRODUCT_BLURB_MAX_PER_RUN", "300"))

_lock = threading.Lock()
_run_token: str | None = None


def _client_or_none():
    if not os.getenv("ANTHROPIC_API_KEY"):
        return None
    try:
        import anthropic
        return anthropic.Anthropic()
    except Exception:
        return None


_SYSTEM = (
    "You explain catalog products to small independent New Jersey liquor "
    "retailers in plain, friendly English. The reader is not a finance "
    "person, so avoid the words tier, CPL, rebate code, RIP code, and "
    "frontline. Use 'discount' and 'extra rebate' instead. Reply with three "
    "to five short sentences (max 75 words), no bullets, no headings, no "
    "emojis, no markdown, no greeting, no sales hype. Cover, in this order: "
    "(1) one sentence on what the product is and the pack size; "
    "(2) the regular case price and per-bottle price; "
    "(3) the discount in concrete dollars and the case quantity needed to "
    "earn it; "
    "(4) the extra rebate (if any) in concrete dollars and what to buy to "
    "qualify, with a note that it stacks on top of the discount; "
    "(5) the final price the buyer can actually achieve and total savings "
    "per case. Use plain prose only, no dashes."
)


def _candidates(limit: int = 500) -> list[dict]:
    """Current-edition products that don't yet have a current-version blurb.

    Prioritises products with active savings (a real discount or RIP) since
    those need the most explanation. Falls back to plain priced items if the
    deal queue is empty so users get coverage on regular SKUs too.
    """
    t = _date.today()
    current_ym = f"{t.year:04d}-{t.month:02d}"
    with get_duckdb() as con:
        eds_df = con.execute(
            "SELECT wholesaler, "
            "COALESCE(MAX(CASE WHEN edition <= $c THEN edition END), MAX(edition)) AS cur_ed "
            "FROM cpl_enriched GROUP BY wholesaler",
            {"c": current_ym},
        ).fetchdf()
        conds, params, idx = [], {}, 0
        for _, row in eds_df.iterrows():
            ed = row["cur_ed"]
            if ed is None or (isinstance(ed, float) and ed != ed):
                continue
            conds.append(f"(wholesaler = $w{idx} AND edition = $e{idx})")
            params[f"w{idx}"], params[f"e{idx}"] = row["wholesaler"], ed
            idx += 1
        if not conds:
            return []
        # Products with a real saving come first, then everything else by
        # popularity proxy (we don't have view counts, so use case price as a
        # mild signal: expensive SKUs are buyer-research-heavy).
        rows = con.execute(f"""
            SELECT wholesaler, edition, upc, product_name, brand, unit_volume, unit_qty,
                   frontline_case_price, frontline_unit_price,
                   effective_case_price, total_savings_per_case,
                   discount_pct, has_discount, has_rip, rip_code,
                   discount_1_qty, discount_1_amt, discount_2_qty, discount_2_amt,
                   discount_3_qty, discount_3_amt, discount_4_qty, discount_4_amt,
                   discount_5_qty, discount_5_amt
            FROM cpl_enriched
            WHERE upc IS NOT NULL AND upc <> ''
              AND product_name IS NOT NULL AND product_name <> ''
              AND ({' OR '.join(conds)})
            ORDER BY
              CASE WHEN total_savings_per_case IS NOT NULL AND total_savings_per_case > 0 THEN 0 ELSE 1 END,
              total_savings_per_case DESC NULLS LAST,
              frontline_case_price DESC NULLS LAST
            LIMIT {int(limit) * 3}
        """, params).fetchdf()
        # Attach RIP tiers per (wholesaler, edition, upc, rip_code) so the
        # prompt can describe what the buyer needs to qualify.
        rip_map: dict = {}
        rip_pairs = {(r["wholesaler"], r["edition"], str(r.get("rip_code") or "").strip(), str(r["upc"]).strip())
                     for _, r in rows.iterrows()
                     if str(r.get("rip_code") or "").strip() and str(r.get("rip_code") or "").strip() not in ("0", "nan", "None")}
        if rip_pairs:
            ph = ", ".join(f"($pw{i}, $pe{i}, $prc{i}, $pu{i})" for i in range(len(rip_pairs)))
            prm = {}
            for i, (w, e, rc, u) in enumerate(rip_pairs):
                prm[f"pw{i}"], prm[f"pe{i}"], prm[f"prc{i}"], prm[f"pu{i}"] = w, e, rc, u
            try:
                rip_df = con.execute(f"""
                    SELECT wholesaler, edition, CAST(rip_code AS VARCHAR) AS rip_code,
                           CAST(upc AS VARCHAR) AS upc, rip_description,
                           rip_unit_1, rip_qty_1, rip_amt_1,
                           rip_unit_2, rip_qty_2, rip_amt_2,
                           rip_unit_3, rip_qty_3, rip_amt_3,
                           rip_unit_4, rip_qty_4, rip_amt_4
                    FROM rip
                    WHERE (wholesaler, edition, CAST(rip_code AS VARCHAR), CAST(upc AS VARCHAR)) IN ({ph})
                """, prm).fetchdf()
                for _, r in rip_df.iterrows():
                    key = (r["wholesaler"], r["edition"], r["rip_code"], r["upc"])
                    tiers = []
                    for j in range(1, 5):
                        amt = r.get(f"rip_amt_{j}"); qty = r.get(f"rip_qty_{j}"); unit = r.get(f"rip_unit_{j}")
                        try:
                            af = float(amt) if amt is not None else 0.0
                            qf = float(qty) if qty is not None else 0.0
                        except (TypeError, ValueError):
                            continue
                        if af != af or qf != qf or af <= 0 or qf <= 0:
                            continue
                        tiers.append({"qty": int(qf), "unit": str(unit) if unit else "Cases", "amount": af})
                    rip_map.setdefault(key, {"description": r.get("rip_description"), "tiers": []})["tiers"].extend(tiers)
            except Exception:
                rip_map = {}

    have: set = set()
    try:
        with get_pg() as pg:
            cur = pg.execute(
                "SELECT wholesaler, LTRIM(upc, '0') AS un, edition FROM ai_product_blurbs WHERE version = %s",
                (_BLURB_VERSION,),
            )
            for r in cur.fetchall():
                have.add((r["wholesaler"], r["un"], r["edition"]))
    except Exception:
        have = set()

    out: list[dict] = []
    for _, r in rows.iterrows():
        u_raw = str(r["upc"]) if r["upc"] is not None else ""
        u_norm = u_raw.lstrip("0")
        if (r["wholesaler"], u_norm, r["edition"]) in have:
            continue
        # Pack discount tiers into a compact dict the prompt can read.
        disc_tiers = []
        for j in range(1, 6):
            qty = r.get(f"discount_{j}_qty"); amt = r.get(f"discount_{j}_amt")
            try:
                af = float(amt) if amt is not None else 0.0
            except (TypeError, ValueError):
                af = 0.0
            if af > 0:
                disc_tiers.append({"qty": qty, "amount": af})
        rc = str(r.get("rip_code") or "").strip()
        rip = rip_map.get((r["wholesaler"], r["edition"], rc, u_raw.strip())) if rc else None
        out.append({
            "wholesaler": r["wholesaler"], "edition": r["edition"], "upc": u_raw,
            "product_name": r["product_name"], "brand": r.get("brand"),
            "unit_volume": r.get("unit_volume"), "unit_qty": r.get("unit_qty"),
            "frontline_case_price": r.get("frontline_case_price"),
            "frontline_unit_price": r.get("frontline_unit_price"),
            "effective_case_price": r.get("effective_case_price"),
            "total_savings_per_case": r.get("total_savings_per_case"),
            "discount_pct": r.get("discount_pct"),
            "has_discount": bool(r.get("has_discount")),
            "has_rip": bool(r.get("has_rip")),
            "discount_tiers": disc_tiers,
            "rip": rip,
        })
        if len(out) >= int(limit):
            break
    return out


def _prompt(row: dict) -> str:
    fr = row.get("frontline_case_price")
    fr_btl = row.get("frontline_unit_price")
    eff = row.get("effective_case_price")
    save = row.get("total_savings_per_case")
    pct = row.get("discount_pct")
    try:
        uq = int(float(row.get("unit_qty") or 0))
    except (TypeError, ValueError):
        uq = 0
    eff_btl = (eff / uq) if (eff and uq > 0) else None

    bits = [
        f"Product: {row.get('product_name')}.",
        f"Brand: {row.get('brand') or 'unknown'}.",
        f"Pack: {row.get('unit_volume') or 'size N/A'}{f', {uq} bottles per case' if uq > 0 else ''}.",
    ]
    if fr is not None:
        bits.append(f"List price: ${float(fr):.2f} per case" + (f", ${float(fr_btl):.2f} per bottle." if fr_btl else "."))
    # Discount summary
    dt = row.get("discount_tiers") or []
    if dt:
        parts = []
        for t in dt:
            q = t.get("qty")
            try:
                qi = int(float(q)) if q is not None and str(q).strip() not in ("", "nan") else None
            except (TypeError, ValueError):
                qi = None
            label = f"buy {qi}+ cases" if qi else f"qty {q}"
            parts.append(f"{label} save ${t['amount']:.2f} per case")
        bits.append("Discount: " + "; ".join(parts) + ".")
    else:
        bits.append("Discount: none on this product.")
    # RIP summary
    rip = row.get("rip") or {}
    rip_tiers = rip.get("tiers") or []
    if rip_tiers:
        # de-dup by (qty, unit, amount)
        seen, parts = set(), []
        for t in rip_tiers:
            sig = (t.get("qty"), t.get("unit"), round(float(t["amount"]), 2))
            if sig in seen:
                continue
            seen.add(sig)
            parts.append(f"buy {t['qty']} {t['unit']} get ${t['amount']:.2f} back")
        if parts:
            desc = (rip.get("description") or "").strip()
            bits.append("Extra rebate: " + "; ".join(parts) + (f" (rebate text: {desc})" if desc else "") + ".")
    else:
        bits.append("Extra rebate: none.")
    if eff is not None:
        bits.append(f"Best effective case price after everything: ${float(eff):.2f}"
                    + (f", ${eff_btl:.2f} per bottle." if eff_btl else "."))
    if save is not None and save > 0:
        line = f"Total savings: ${float(save):.2f} per case"
        if pct is not None:
            try:
                line += f" ({float(pct):.0f} percent)"
            except (TypeError, ValueError):
                pass
        bits.append(line + ".")
    return " ".join(bits)


def _generate_one(client, row: dict) -> str | None:
    try:
        msg = client.messages.create(
            model=_MODEL,
            max_tokens=260,
            system=_SYSTEM,
            messages=[{"role": "user", "content": _prompt(row)}],
        )
        parts = []
        for block in msg.content or []:
            if getattr(block, "type", None) == "text":
                parts.append(block.text)
        text = " ".join(parts).strip()
        # Defensive: strip any dash characters the model slipped in.
        text = text.replace(chr(0x2014), ", ").replace(chr(0x2013), ", ")
        return text or None
    except Exception:
        return None


def _insert(rows: list[tuple[str, str, str, str]]) -> int:
    if not rows:
        return 0
    sql = """
        INSERT INTO ai_product_blurbs (wholesaler, upc, edition, blurb, version)
        VALUES (%s, %s, %s, %s, %s)
        ON CONFLICT (wholesaler, upc, edition) DO UPDATE
        SET blurb = EXCLUDED.blurb,
            version = EXCLUDED.version
    """
    n = 0
    with get_pg() as pg:
        for r in rows:
            try:
                pg.execute(sql, (r[0], r[1], r[2], r[3], _BLURB_VERSION))
                n += 1
            except Exception:
                pass
    return n


def generate_blurbs_batch(limit: int | None = None) -> int:
    client = _client_or_none()
    if client is None:
        return 0
    cap = limit if limit is not None else _MAX_PER_RUN
    cands = _candidates(limit=cap)
    written: list[tuple[str, str, str, str]] = []
    for row in cands:
        blurb = _generate_one(client, row)
        if not blurb:
            continue
        written.append((str(row["wholesaler"]), str(row["upc"]), str(row["edition"]), blurb))
        if len(written) >= cap:
            break
    return _insert(written)


def warm_product_blurbs_async():
    """Kick off product-blurb generation in the background, once per cache version."""
    global _run_token
    token = str(get_pricing_path())
    with _lock:
        if _run_token == token:
            return
        _run_token = token

    def _run():
        try:
            n = generate_blurbs_batch()
            if n:
                print(f"[product-blurbs] generated {n} new AI product blurbs (version {_BLURB_VERSION})")
        except Exception as e:
            print(f"[product-blurbs] background generation skipped: {e}")
    threading.Thread(target=_run, daemon=True).start()
