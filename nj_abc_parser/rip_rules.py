"""Case-credit extraction from free-text RIP rules (Fedway / Allied).

Distributors hide quantity-qualification rules in RIP free text: Allied
inline in RIP DESCRIPTION ("DISARONNO VELVET CREAM   375ML 12PK = 1/2
CASE"), Fedway in the COMMENTS column ("375ml must be doubled for RIP.").

THE CASE-CREDIT MODEL (see backend/FOUNDATION.md)
--------------------------------------------------
A RIP tier is a pool of CASE CREDITS assembled across the RIP group's UPCs
(mix & match). Each rule sets the credit RATE for a pack configuration:

  - "375ML 12PK = 1/2 CASE" where the SKU's case IS the 12-pack:
        that physical case earns 0.5 credit  -> case_credit = 0.5
        (solo qualification needs 2x the printed case tier)
  - "3PK 1.75L = 1/2 CASE" where the SKU's case is the 6-pack:
        the rule prices the 3-bottle SPLIT; the full case counts FULL
        -> case_credit = 1.0, split_pack = 3, split_credit = 0.5
  - "must be doubled"            -> case_credit = 0.5
  - "= 1/4 case"                 -> case_credit = 0.25
  - "12-BT CS = 2 CS FOR RIP"    -> case_credit = 2.0 (favorable)

The credit applies ONLY to case-denominated tier quantities. Bottle tiers
are explicit bottle counts and are never scaled.

Pairing rules (each one bought with a real mispricing bug):
  - SIZE is a STRICT filter — "375ML = 1/2 CASE" must never tag a 750ML.
  - "12PK 375ML" (adjacent tokens) is a conjunction: the 375ML 12-pack.
    "6PK & 375ML" is two alternatives. Disambiguated by token adjacency.
  - Pack words (VAP / gift / flask / glass) are strict against name
    markers (VAP|GFBX|FLK|GLS|GIFT|TRAY|SET) — a VAP rule whose members
    carry no marker resolves to NOTHING, never to the whole group.
  - Item-number scopes resolve through dist_item_no (Fedway's unnamed
    RIP col N, captured by base_parser) — also the only key on Fedway
    rows filed with UPC=0.

Unresolvable clauses yield NO row: every downstream consumer treats a
missing credit as 1.0, so an unparsed rule can never alter pricing.
"""
from __future__ import annotations

import re
from collections import defaultdict

import pandas as pd

# --------------------------------------------------------------------- text

STOPWORDS = {
    "ALL", "TYPES", "TYPE", "MIX", "MATCH", "ONLY", "SIZES", "SIZE", "AND",
    "OR", "THE", "INCLUDES", "INCLUDE", "INCLUDING", "EXCLUDES", "EXCLUDE",
    "EXCLUDING", "EXC", "EX", "ASSORT", "ASSORTED", "MUST", "BE", "FOR",
    "RIP", "ARE", "IS", "THIS", "THESE", "ITEM", "ITEMS", "WITH", "AS",
    "CASE", "CASES", "CS", "FULL", "HALF", "PACKS", "PK", "PKS", "PACK",
    "BT", "BTS", "BTL", "BTLS", "BOTTLES", "NO", "SMALL", "LARGE", "W",
    "A", "BOTTLE", "MEANS", "SLEEVE", "MAY", "THESE",
}
PACK_WORDS = {"VAP", "VAPS", "GLASS", "GIFT", "FLASK", "TRAY", "SET", "SETS",
              "CO-PACK", "COPACK", "CO-PACKS", "SHAPE"}
PACK_WORD_PAT = {
    "VAP": "VAP", "VAPS": "VAP", "GLASS": "GLASS|GLS",
    "GIFT": "GIFT|GFBX|GF BX", "FLASK": "FLASK|FLK", "TRAY": "TRAY",
    "SET": r"\bSET\b", "SETS": r"\bSET", "CO-PACK": "CO.?P",
    "COPACK": "CO.?P", "CO-PACKS": "CO.?P", "SHAPE": "SHAPE",
}
SMALL_SET = {"50ML", "100ML", "187ML", "200ML", "375ML"}
LARGE_SET = {"1L", "1.5L", "1.75L", "3L"}

SIZE_RE = re.compile(r"\b(\d+(?:\.\d+)?)\s*(ML|L|OZ|LT)\b(?:'?S)?", re.I)
LITER_RE = re.compile(r"\bLITERS?\b", re.I)
PACK_RE = re.compile(r"\b(\d+)\s*[- ]?(?:PK|P|PACK|PACKS|BT|BTS|BTL|BTLS)\b", re.I)
ITEMNO_RE = re.compile(r"#?\s*(\d{5,7})\b")
SLASH_SIZE_RE = re.compile(r"\b(\d{2,4})/(\d{2,4})\s*ML\b", re.I)
# Bare bottle-ML sizes written WITHOUT a unit, as some distributors do (Fedway:
# "750 6pk & 375's = 1/2 cs"). Restricted to unambiguous bottle sizes so a pack
# count or other number is never misread as a size. The optional 's/'s handles
# the "375's" plural.
BARE_ML_RE = re.compile(r"\b(187|375|500|700|750|1000)(?:'?[sS])?\b")

RULE_RE = re.compile(
    r"=?\s*\(?\s*(1/2|1/4|FULL|HALF|1)\s*\)?\s*-?\s*(?:CASE|CS|CASES)\b", re.I)
DOUBLE_RE = re.compile(r"\bMUST\s+(?:BE\s+)?DOUBLED?\b|\bMUST\s+DOUBLE\b", re.I)
NBT_EQ_NCS_RE = re.compile(r"\b(\d+)\s*-?\s*BT\s*CS\s*=\s*(\d+)\s*CS\b", re.I)

# rule_kind -> case credit of the pack the rule names
KIND_CREDIT = {"half": 0.5, "quarter": 0.25, "doubled": 0.5}


def canon_size(tok) -> str | None:
    """'375ML'S' -> '375ML', 'LITERS'/'LITER' -> '1L', '1.75' -> '1.75L'."""
    if tok is None or (isinstance(tok, float) and tok != tok):
        return None
    t = str(tok).upper().replace(" ", "").rstrip(".").rstrip("'S").rstrip("S'")
    if t.endswith("'"):
        t = t[:-1]
    if t in ("LITER", "LITERS", "LTR", "LT", "1LT", "1LITER"):
        return "1L"
    m = re.fullmatch(r"(\d+(?:\.\d+)?)(ML|L|OZ|LT)?", t)
    if not m:
        return None
    num, unit = m.group(1), m.group(2)
    if unit in ("L", "LT"):
        return "1L" if float(num) == 1 else f"{num}L"
    if unit == "ML":
        return f"{num}ML"
    if unit == "OZ":
        return f"{num}OZ"
    return f"{num}L" if float(num) < 20 else f"{num}ML"


def norm_upc(u) -> str:
    return str(u).lstrip("0") if u is not None else ""


# One NJ ABC standard case = 9 litres (12 x 750ML). A half/quarter-case credit
# means the pack is a FRACTION of a case, so it can only sit below a full case.
# A pack that already measures a full case or more cannot be "half a case" — a
# fractional credit on it is self-contradictory (real bug: Allied filed the
# Glenlivet Founders 750ML 12-pack = 9L under a "CARRIBEAN RES 750ML = 1/2 case"
# clause meant for the Caribbean 6-pack = 4.5L). 8.9L threshold so a 9.0L case
# trips it without float noise; legit half-packs (4.5L) stay well clear.
FULL_CASE_ML = 8900.0

_SIZE_ML_RE = re.compile(r"(\d+(?:\.\d+)?)\s*(ML|L|OZ)\b", re.I)


def size_to_ml(size_c) -> float | None:
    """One bottle's volume in mL from a canon_size string ('750ML','1.75L','50ML').
    None when unparseable (kegs/odd formats are left alone, never guarded)."""
    if size_c is None or (isinstance(size_c, float) and size_c != size_c):
        return None
    m = _SIZE_ML_RE.search(str(size_c).upper())
    if not m:
        return None
    v = float(m.group(1))
    u = m.group(2).upper()
    if u == "L":
        return v * 1000.0
    if u == "OZ":
        return v * 29.5735
    return v  # ML


def split_clauses(text: str):
    """Yield (scope_text, rule_kind) for every qty-affecting rule.

    Only kinds that change credit are emitted: half / quarter / doubled /
    counts_as_more (with its ratio). Full-case clarifiers and case-unit
    notes don't alter credit and are skipped here, but their '= FULL CASE'
    spans still terminate scopes so a half-case scope can't bleed into one.
    """
    txt = " ".join(str(text).upper().split())
    events = []  # (start, end, kind, credit)
    for m in RULE_RE.finditer(txt):
        pre = txt[max(0, m.start() - 12):m.start()]
        if not ("=" in m.group(0) or "=" in pre[-3:]
                or re.search(r"(ARE|IS|AS)\s*$", pre)):
            continue
        frac = m.group(1)
        kind = {"1/2": "half", "HALF": "half", "1/4": "quarter",
                "FULL": "full_clarifier", "1": "full_clarifier"}[frac]
        events.append((m.start(), m.end(), kind, KIND_CREDIT.get(kind)))
    for m in DOUBLE_RE.finditer(txt):
        events.append((m.start(), m.end(), "doubled", 0.5))
    for m in NBT_EQ_NCS_RE.finditer(txt):
        events.append((m.start(), m.end(), "counts_as_more",
                       float(int(m.group(2)))))
    events.sort()
    prev_end = 0
    for start, end, kind, credit in events:
        scope = txt[prev_end:start]
        # '.' splits scopes only when NOT inside a decimal (1.75L, 19.2OZ)
        scope = re.split(r"(?<!\d)\.(?!\d)|[!;|]", scope)[-1].strip(" ,&=()-")
        prev_end = end
        if credit is not None:  # qty-affecting only
            yield scope, kind, credit


def parse_size_pack_alts(scope: str):
    """(size, pack) ALTERNATIVES; adjacent size+pack tokens pair as one
    conjunction ("12PK 375ML"), separated ones stay alternatives
    ("6PK & 375ML")."""
    items = []
    for m in SLASH_SIZE_RE.finditer(scope):
        items.append((m.start(), m.end(), "size", f"{m.group(1)}ML"))
        items.append((m.start(), m.end(), "size", f"{m.group(2)}ML"))
    taken = [(s, e) for s, e, *_ in items]
    for m in SIZE_RE.finditer(scope):
        if any(s <= m.start() < e for s, e in taken):
            continue
        c = canon_size(m.group(1) + m.group(2))
        if c:
            items.append((m.start(), m.end(), "size", c))
    for m in LITER_RE.finditer(scope):
        items.append((m.start(), m.end(), "size", "1L"))
    for m in PACK_RE.finditer(scope):
        items.append((m.start(), m.end(), "pack", int(m.group(1))))
    # Unit-less bottle-ML sizes ("375'S", "750"), but only where the number
    # isn't already claimed as a unit'd size or a pack count.
    claimed = [(s, e) for s, e, *_ in items]
    for m in BARE_ML_RE.finditer(scope):
        if any(s <= m.start() < e for s, e in claimed):
            continue
        items.append((m.start(), m.end(), "size", f"{m.group(1)}ML"))
    for m in re.finditer(r"\b(SMALL|LARGE)\s+SIZES\b", scope):
        items.append((m.start(), m.end(), "size",
                      "__small__" if m.group(1) == "SMALL" else "__large__"))
    items.sort()
    alts, i = [], 0
    while i < len(items):
        s, e, kind, val = items[i]
        nxt = items[i + 1] if i + 1 < len(items) else None
        if nxt and nxt[2] != kind and 0 <= nxt[0] - e <= 4:
            alts.append((val if kind == "size" else nxt[3],
                         val if kind == "pack" else nxt[3]))
            i += 2
        else:
            alts.append((val, None) if kind == "size" else (None, val))
            i += 1
    return alts


def _name_tokens(scope: str) -> list[str]:
    return [t for t in re.split(r"[^A-Z0-9.']+", scope)
            if t and t not in STOPWORDS and t not in PACK_WORDS
            and not t.replace(".", "").isdigit() and canon_size(t) is None
            and not re.fullmatch(r"\d+(PK|P|PACK|BT)", t)]


def _tok_match(scope_tok: str, name: str) -> bool:
    """Containment OR 4+-char prefix overlap, so abbreviated CPL names
    still match ('COURVOISIER' ~ 'COURVOIS VS')."""
    if scope_tok in name:
        return True
    if len(scope_tok) >= 5:
        for nt in name.split():
            if len(nt) >= 4 and (scope_tok.startswith(nt)
                                 or nt.startswith(scope_tok[:max(4, len(nt))])):
                return True
    return False


# ----------------------------------------------------------------- resolver

def compute_rip_credits(rip_df: pd.DataFrame, cpl_df: pd.DataFrame) -> pd.DataFrame:
    """Resolve free-text RIP rules into per-UPC case credits.

    Inputs are the raw rip / cpl frames (any number of wholesalers and
    editions; only fedway+allied rows produce rules today, others pass
    through with no rows). Returns one row per (wholesaler, edition,
    rip_code, upc) whose credit differs from 1.0 OR that carries a split
    allowance:

        wholesaler, edition, rip_code, upc,
        case_credit   -- credit ONE physical case earns toward case tiers
        split_pack    -- bottles in an allowed sub-case split (NULL = none)
        split_credit  -- credit that split earns (e.g. 0.5)
        rule_kind, method, rule_excerpt
    """
    out = []
    anomalies = []  # full-case packs a fractional clause tried to tag (recorded)
    cpl = cpl_df.copy()
    cpl["upc_n"] = cpl["upc"].map(norm_upc)
    cpl = cpl[cpl["upc_n"] != ""]
    cpl["size_c"] = cpl["unit_volume"].map(canon_size)
    cpl["uq"] = cpl["unit_qty"].astype(str).str.replace(
        r"\.0+$", "", regex=True)
    cpl_idx = dict(tuple(cpl.groupby(["wholesaler", "edition"])))

    # Pack volume in mL per (wholesaler, edition, upc): one bottle's mL * pack.
    # Used by the full-case guard so a fractional credit can't land on a pack
    # that already measures a whole case.
    pack_ml: dict = {}
    for _, c in cpl.iterrows():
        ml = size_to_ml(c["size_c"])
        try:
            q = float(c["uq"])
        except (TypeError, ValueError):
            q = None
        if ml is not None and q:
            pack_ml[(c["wholesaler"], c["edition"], c["upc_n"])] = ml * q

    has_item = "dist_item_no" in rip_df.columns

    for (w, ed, code), g in rip_df.groupby(["wholesaler", "edition", "rip_code"]):
        texts = sorted({t for t in g["rip_description"].dropna().unique() if t})
        texts += sorted({t for t in g["comments"].dropna().unique() if t})
        blob = " | ".join(texts)
        if not blob:
            continue
        up = blob.upper()
        if not (re.search(r"1/2|1/4|HALF\s+CASE", up) or DOUBLE_RE.search(up)
                or NBT_EQ_NCS_RE.search(up)):
            continue

        mem = cpl_idx.get((w, ed))
        g_upcs = {norm_upc(u) for u in g["upc"]} - {""}
        mem = (mem[mem["upc_n"].isin(g_upcs)] if mem is not None
               else pd.DataFrame())
        item_map = {}
        if has_item:
            for _, rr in g.iterrows():
                it = rr.get("dist_item_no")
                if it:
                    item_map.setdefault(str(it), set()).add(norm_upc(rr["upc"]))

        for scope, kind, credit in split_clauses(blob):
            alts = parse_size_pack_alts(scope)
            itemnos = {m.group(1) for m in ITEMNO_RE.finditer(scope)} - {
                (s or "").replace("ML", "").replace("L", "").replace("OZ", "")
                for s, _ in alts}
            toks = _name_tokens(scope)
            packwords = {wd for wd in PACK_WORDS if wd in scope}

            matched_upcs: set[str] = set()
            split_pack = None
            method = None

            # 1) item-number scope (deterministic via dist_item_no)
            if itemnos and item_map:
                hits = set()
                for it in itemnos:
                    hits |= item_map.get(it, set())
                hits -= {""}
                if hits:
                    matched_upcs = hits & g_upcs
                    method = "item#"

            # 2) size/pack alternatives + name tokens + pack words
            if not matched_upcs and not mem.empty and not itemnos:
                cand = mem
                pack_relaxed_for: int | None = None
                if alts:
                    mask = pd.Series(False, index=mem.index)
                    for sz, pk in alts:
                        m_ = pd.Series(True, index=mem.index)
                        if sz == "__small__":
                            m_ &= mem["size_c"].isin(SMALL_SET)
                        elif sz == "__large__":
                            m_ &= mem["size_c"].isin(LARGE_SET)
                        elif sz:
                            m_ &= mem["size_c"] == sz
                        if pk:
                            m_pk = m_ & (mem["uq"] == str(pk))
                            if m_pk.any():
                                m_ = m_pk
                            elif m_.any():
                                # SKU is the full-pack case; rule prices
                                # the split -> credit stays 1.0 + allowance
                                pack_relaxed_for = pk
                        mask |= m_
                    cand = mem[mask]
                if packwords and not cand.empty:
                    pat = "|".join(PACK_WORD_PAT[wd] for wd in packwords)
                    cand = cand[cand["product_name"].str.upper()
                                .str.contains(pat, regex=True, na=False)]
                if toks and not cand.empty:
                    names_u = cand["product_name"].str.upper().fillna("")
                    strict = names_u.apply(
                        lambda n: all(_tok_match(t, n) for t in toks))
                    if strict.any():
                        cand = cand[strict]
                    else:
                        # multi-product name lists ("CAOL ILA & CLYNELISH")
                        # can't all-match one name; any distinctive token
                        # within the already-constrained candidates is the
                        # right scope (never widens beyond the RIP group)
                        loose = names_u.apply(
                            lambda n: any(_tok_match(t, n) for t in toks
                                          if len(t) >= 4))
                        if loose.any():
                            cand = cand[loose]
                        elif not (alts or packwords):
                            # name-ONLY scope with zero name hits: unresolved
                            cand = cand.iloc[0:0]
                        # else: keep the size/pack-constrained candidates —
                        # the unmatched tokens are just the brand label
                        # ("DON Q RUM 3PK 1.75L" vs names "DON Q GOLD")
                elif not toks and not alts and not packwords:
                    # whole-RIP scope
                    cand = mem
                if not cand.empty:
                    matched_upcs = set(cand["upc_n"])
                    method = ("size/pack" if alts or packwords else
                              "name" if toks else "whole-rip")
                    if pack_relaxed_for is not None:
                        split_pack = pack_relaxed_for

            # whole-RIP scope on groups with no CPL join (e.g. Fedway rows
            # filed with UPC=0): the rule still covers the whole group
            if (not matched_upcs and mem.empty and not toks
                    and not alts and not packwords and not itemnos):
                matched_upcs = g_upcs
                method = "whole-rip"

            if not matched_upcs:
                continue
            for u in matched_upcs:
                if split_pack is not None:
                    row_credit, sp, sc = 1.0, split_pack, credit
                else:
                    row_credit, sp, sc = credit, None, None
                # Full-case guard: a fractional credit (<1.0) cannot apply to a
                # pack that already measures a whole case (>= 9L). The clause was
                # scoped to a fraction-sized pack (a 6-pack / 375ML); a full case
                # swept in by a size-only fall-back is recorded as an anomaly and
                # left at credit 1.0 (never silently mis-priced).
                if row_credit is not None and row_credit < 1.0:
                    vml = pack_ml.get((w, ed, u))
                    if vml is not None and vml >= FULL_CASE_ML:
                        anomalies.append({
                            "wholesaler": w, "edition": ed, "rip_code": code,
                            "upc": u, "pack_ml": round(vml, 1),
                            "attempted_credit": row_credit,
                            "rule_excerpt": (scope[:80] or kind),
                            "reason": "fractional credit on a full-case (>=9L) pack",
                        })
                        continue
                out.append({
                    "wholesaler": w, "edition": ed, "rip_code": code,
                    "upc": u, "case_credit": row_credit,
                    "split_pack": sp, "split_credit": sc,
                    "rule_kind": kind, "method": method,
                    "rule_excerpt": (scope[:80] or kind),
                })

    def _finish(result: pd.DataFrame) -> pd.DataFrame:
        # Record the guarded packs so a human can reconcile them against the
        # source sheet instead of the system silently mis-pricing or hiding them.
        # NB: store a plain LIST in .attrs (never a DataFrame — pandas compares
        # attrs during astype/concat and a DataFrame there raises "ambiguous").
        seen, uniq = set(), []
        for a in anomalies:
            k = (a["wholesaler"], a["edition"], a["rip_code"], a["upc"])
            if k not in seen:
                seen.add(k)
                uniq.append(a)
        result.attrs["anomalies"] = uniq
        if uniq:
            print(f"  [rip_rules] {len(uniq)} full-case guard anomalies "
                  f"(fractional credit left at 1.0):")
            for a in uniq:
                print(f"    - {a['wholesaler']}/{a['rip_code']} upc {a['upc']} "
                      f"({a['pack_ml']:.0f}mL) via \"{a['rule_excerpt']}\"")
        return result

    if not out:
        return _finish(pd.DataFrame(columns=[
            "wholesaler", "edition", "rip_code", "upc", "case_credit",
            "split_pack", "split_credit", "rule_kind", "method",
            "rule_excerpt"]))
    df = pd.DataFrame(out)
    # one row per (w, ed, code, upc): worst (lowest) credit wins; keep any
    # split allowance row's fields if present
    df = df.sort_values("case_credit").drop_duplicates(
        subset=["wholesaler", "edition", "rip_code", "upc"], keep="first")
    # rows that neither change credit nor allow a split carry no signal
    df = df[(df["case_credit"] != 1.0) | df["split_pack"].notna()]
    return _finish(df.reset_index(drop=True))
