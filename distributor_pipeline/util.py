"""Normalisation helpers shared by the extractor and the matcher."""
import re

# ---- size ----------------------------------------------------------------
_SIZE_RE = re.compile(r"(\d+(?:\.\d+)?)\s*(ML|LT|L|OZ|GAL)\b", re.I)
_OZ_TO_ML = 29.5735


def parse_size_ml(size_raw: str):
    """'750 ML'->750, '1.75 LT'->1750, '1 LT'->1000, '12 OZ'->355, '50 ML'->50."""
    if not size_raw:
        return None
    m = _SIZE_RE.search(size_raw.upper())
    if not m:
        return None
    val = float(m.group(1)); unit = m.group(2).upper()
    if unit in ("LT", "L", "GAL"):
        ml = val * (3785.41 if unit == "GAL" else 1000)
    elif unit == "OZ":
        ml = val * _OZ_TO_ML
    else:
        ml = val
    return int(round(ml))


# ---- item number ---------------------------------------------------------
def norm_item_catalog(raw: str) -> str | None:
    """Catalog and best-deal numbers are the SAME number, just printed with
    different leading-zero padding. Verified empirically: zero-padding BOTH to 9
    maximises the A<->B overlap (138 matches), while the *10 hypothesis gives 0.
    So the canonical key is simply pad-to-9."""
    return norm_item_padded(raw)


def norm_item_padded(raw: str) -> str | None:
    """Best-deal / partial-month numbers are already the full 9-digit code."""
    if raw is None:
        return None
    d = re.sub(r"\D", "", str(raw))
    if not d:
        return None
    return d.zfill(9)


# ---- deal strings --------------------------------------------------------
# "15C\$270" / "2B\$12" / "1C$24"  (a literal backslash often precedes $)
_CASE_TIER = re.compile(r"(\d+)\s*C\\?\$(\d+(?:\.\d+)?)")
_BOTTLE_TIER = re.compile(r"(\d+)\s*B\\?\$(\d+(?:\.\d+)?)")
_MONTHS = {m: i + 1 for i, m in enumerate(
    ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"])}


def parse_deal_tiers(text: str):
    """Return list of (qty, unit 'C'|'B', amount). Month handled by caller."""
    out = []
    for q, a in _CASE_TIER.findall(text):
        out.append((int(q), "C", float(a)))
    for q, a in _BOTTLE_TIER.findall(text):
        out.append((int(q), "B", float(a)))
    return out


def find_month(text: str):
    for mo, n in _MONTHS.items():
        if re.search(rf"\b{mo}\b", text):
            return n
    return None


# ---- retail-incentive tiers ("2 Cs/$12, 4 Cs/$48", "3 Bt/$6, 1 Cs/$50") ---
_RI_TIER = re.compile(r"(\d+)\s*(Cs|Bt|Sleeve)\s*/\s*\$(\d+(?:\.\d+)?)", re.I)


def parse_retail_tiers(text: str):
    out = []
    for q, u, a in _RI_TIER.findall(text):
        unit = {"cs": "C", "bt": "B", "sleeve": "S"}.get(u.lower(), u)
        out.append((int(q), unit, float(a)))
    return out


# ---- name normalisation for matching ------------------------------------
_ABBREV = {
    "CHARD": "CHARDONNAY", "CAB": "CABERNET", "SAUV": "SAUVIGNON",
    "PN": "PINOT NOIR", "PG": "PINOT GRIGIO", "BBN": "BOURBON",
    "WHSKY": "WHISKEY", "WHSK": "WHISKEY", "WHKY": "WHISKEY",
    "RSV": "RESERVE", "RES": "RESERVE", "SB": "SAUVIGNON BLANC",
    "CS": "CABERNET SAUVIGNON", "ZIN": "ZINFANDEL", "SYR": "SYRAH",
    "PROS": "PROSECCO", "CHAMP": "CHAMPAGNE", "VOD": "VODKA",
    "TEQ": "TEQUILA", "REPO": "REPOSADO", "BLNC": "BLANC", "BL": "BLANC",
    "RSRV": "RESERVE", "SEL": "SELECT", "ORIG": "ORIGINAL",
}
_MONEY = re.compile(r"\$\s*\d+(?:\.\d+)?")
_UNIT_PRICE = re.compile(r"\b\d+(?:\.\d+)?\s*/\s*(?:OZ|EA)\b", re.I)
_SIZE_TOKEN = re.compile(r"\b\d+(?:\.\d+)?\s*(?:ML|LT|L|OZ|PK|PF|VTG|GAL)\b", re.I)
_PUNCT = re.compile(r"[^A-Z0-9 ]")
_MULTISPACE = re.compile(r"\s+")
# Fedway program flags / pack noise that carry no product meaning.
_NOISE_TOKENS = {"F", "LA", "GP", "JNC", "JC", "VAP", "PK", "PF", "VTG", "CS", "BT",
                 "JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP",
                 "OCT", "NOV", "DEC", "RIP"}


def norm_name(s: str) -> str:
    if not s:
        return ""
    s = s.upper()
    s = _MONEY.sub(" ", s)
    s = _UNIT_PRICE.sub(" ", s)
    s = _SIZE_TOKEN.sub(" ", s)
    s = _PUNCT.sub(" ", s)
    toks = []
    for t in s.split():
        if t in _NOISE_TOKENS or t.isdigit():
            continue
        toks.append(_ABBREV.get(t, t))
    return _MULTISPACE.sub(" ", " ".join(toks)).strip()


def brand_tokens(s: str) -> set:
    return set(norm_name(s).split())


_LEAD_NOISE = re.compile(
    r"^(?:RIP:?\s*\d*\s*|JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC|"
    r"\d+\s*PK|\d+PK)\s+", re.I)


def clean_display_name(s: str) -> str:
    """Clean a catalog product name for storage and semantic matching: remove
    price fragments ($x, x/OZ, x/EA) that bleed in from price rows, then strip
    leading noise tokens (stray month, 'RIP:' fragment, leading pack count)."""
    if not s:
        return s
    s = _MONEY.sub(" ", s)
    s = _UNIT_PRICE.sub(" ", s)
    s = _MULTISPACE.sub(" ", s).strip()
    prev = None
    while prev != s:
        prev = s
        s = _LEAD_NOISE.sub("", s).strip()
    return s
