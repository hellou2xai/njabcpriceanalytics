"""CELR Product Number identity primitives (docs/CELR_PRODUCT_NUMBER_DESIGN.md).

v2 lesson (Jim Beam Orange, 2026-06-11): Go-UPC enrichment names are too noisy
to KEY identity on — the same product came back as four verbosity levels plus
outright garbage ("Beam Banner Jim Orange Pet", "Kyocera Test Artist" for a
placeholder barcode). The DISTRIBUTOR names are the consistent signal, so the
registry clusters on catalogue-name token signatures first; trusted enrichment
names only BRIDGE abbreviation variants (GLENLIVET FOUND RES == GLENLIVET
FOUNDER'S RESERVE) and supply the pretty header.

Self-contained on purpose: the registry's normalization is its own contract,
independent of the catalog router's display cores.
"""
from __future__ import annotations

import re

_SIZE_RE = re.compile(
    r"\b\d+(?:[.,]\d+)?\s*(?:ml|cl|lt|ltr|liter|litre|liters|l|oz|pk|pack|p)\b", re.I)
_PACK_RE = re.compile(r"\b\d+\s*(?:p|pk|pack|ct|cnt)\b|\b\d+\s*[x/]\s*\d+\b", re.I)
_PUNCT_RE = re.compile(r"[^a-z0-9 ]+")
_AGE_RE = re.compile(r"\b(\d+)\s*(?:yr|yrs|yo|years|year|y)\b", re.I)
_YEAR_RE = re.compile(r"\b(?:19|20)\d{2}\b")
_TRAIL2_RE = re.compile(r"\s\d{2}$")

# Words that never DISTINGUISH two products of one brand line: articles,
# packaging/material words, unambiguous category descriptors. Words that CAN
# distinguish (bourbon vs rye, flavours, cask finishes, proof numbers) stay:
# a wrong split is one alias away from fixed, a wrong merge corrupts history.
STOPWORDS = {
    "the", "a", "of", "with", "w", "and",
    "carton", "gift", "box", "set", "vap", "bottle", "btl", "can", "pk",
    "pet", "plastic", "glass",
    "wine", "whisky", "whiskey", "scotch", "single", "malt", "blended",
}
_AGE_WORDS = {"year", "years", "yr", "yrs", "y", "old", "aged"}


def norm_upc(v) -> str:
    return re.sub(r"\D", "", str(v or "")).lstrip("0")


def is_registry_upc(upc) -> bool:
    """A barcode usable as a registry identity: a real, unique GTIN. Rejects
    blanks, '0', all-same-digit fillers, '999999…' sentinels, codes shorter
    than 8 digits, AND repeated-digit placeholders like 111111111117 (nine or
    more leading repeats of one digit — Allied's fake-barcode pattern that
    slipped past the all-same-digit check and matched garbage enrichment)."""
    s = str(upc).strip() if upc is not None else ""
    if s in ("", "0"):
        return False
    if re.fullmatch(r"(0+|9+|1+)", s):
        return False
    if s.startswith("999999"):
        return False
    if re.match(r"^(\d)\1{8,}", s):
        return False
    return len(s.lstrip("0")) >= 8


def _tokens(core: str) -> list[str]:
    raw = [t for t in re.split(r"[^a-z0-9]+", core.lower()) if t]
    toks: list[str] = []
    i = 0
    while i < len(raw):
        t = raw[i]
        if i + 1 < len(raw) and t.isdigit() and raw[i + 1] in _AGE_WORDS:
            toks.append(f"{int(t)}yr")
            i += 2
            while i < len(raw) and raw[i] in _AGE_WORDS:
                i += 1
            continue
        m = re.fullmatch(r"(\d+)(?:yr|yrs|yo|y)", t)
        if m:
            toks.append(f"{int(m.group(1))}yr")
            i += 1
            continue
        if t not in STOPWORDS and t not in _AGE_WORDS:
            toks.append(t)
        i += 1
    return toks


def family_core(name: str | None, product_type: str | None = None) -> str:
    """Order-independent token signature of a product family. Size, pack,
    packaging material and category stopwords drop; ages normalize
    (12Y == 12 YR == 12 year); wine vintages drop (variant); tokens sort."""
    clean = (name if isinstance(name, str) else "").replace("'", "").replace("’", "")
    s = clean.lower()
    s = _PACK_RE.sub(" ", s)
    s = _SIZE_RE.sub(" ", s)
    s = _PUNCT_RE.sub(" ", s)
    s = _AGE_RE.sub(lambda m: f"{m.group(1)}yr", s)
    if "wine" in str(product_type or "").lower():
        s = _YEAR_RE.sub(" ", s)
        s = _TRAIL2_RE.sub("", s.rstrip())
    return " ".join(sorted(set(_tokens(s))))


def family_key(name: str | None, product_type: str | None = None) -> str:
    """The registry lookup key: type bucket + token signature."""
    bucket = "wine" if "wine" in str(product_type or "").lower() else "x"
    return f"{bucket}|{family_core(name, product_type)}"


def trusted_enrichment(catalog_name: str | None, enr_name: str | None) -> bool:
    """Go-UPC names are only trusted when they share at least one significant
    token with the distributor's name for the same barcode. 'Kyocera Test
    Artist' against 'JIM BEAM ORANGE' shares nothing -> garbage, ignore."""
    a = set(_tokens(family_core(catalog_name)))
    b = set(_tokens(family_core(enr_name)))
    return bool(a & b)
