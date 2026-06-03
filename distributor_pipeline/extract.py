"""PDF extraction: section routing + parsers A (catalog), B (best-deal/partial),
C (retail incentives), D (combos). Column-segments by x first, then runs a
top-to-bottom state machine per column (the prompt's required approach).

Everything that cannot be classified is logged to `unparsed` with page/col/y so
counts reconcile. Returns dicts of plain rows; the caller loads them to Postgres.
"""
import re
import collections
import pdfplumber

from . import config, util

HEADER_RE = re.compile(r"800-4-FEDWAY\s+(.*?)\s+Order Fax", re.I)
PROGRAM_FLAGS = {"F", "LA", "GP", "JNC", "JC", "J", "N", "SM", "VAP", "C", "G"}

# Type/style and country banners sit ABOVE brands in the hierarchy; they must not
# be mistaken for the brand or product name. Not exhaustive, just the common ones
# so real brand banners (KAIYO, ARDBEG, ...) win the brand slot.
TYPE_WORDS = {
    "WHISKIES", "WHISKY", "WHISKEY", "BOURBON", "SCOTCH", "VODKA", "VODKAS",
    "GIN", "GINS", "RUM", "RUMS", "TEQUILA", "TEQUILAS", "MEZCAL", "BRANDY",
    "COGNAC", "CORDIALS", "LIQUEUR", "LIQUEURS", "CANADIAN", "IRISH", "RYE",
    "RED", "WHITE", "ROSE", "BLUSH", "SPARKLING", "CHAMPAGNE", "STILL",
    "DESSERT", "SAKE", "VERMOUTH", "APERITIF", "BITTERS", "BLENDED", "MALT",
    "SCHNAPPS", "GRAPPA", "PORT", "SHERRY", "WINE", "SPIRITS", "CANS",
    "COCKTAILS", "MALT", "CRAFT", "PROSECCO", "MOSCATO", "RTD", "RTS",
}
COUNTRY_WORDS = {
    "JAPAN", "USA", "CANADA", "SCOTLAND", "IRELAND", "FRANCE", "MEXICO",
    "ITALY", "SPAIN", "GERMANY", "AUSTRALIA", "ARGENTINA", "CHILE",
    "PORTUGAL", "ENGLAND", "CARIBBEAN", "PUERTO", "BARBADOS", "JAMAICA",
    "GREECE", "AUSTRIA", "HUNGARY", "ISRAEL", "BRAZIL", "PERU", "CUBA",
    "DOMINICAN", "GUATEMALA", "NICARAGUA", "VENEZUELA", "RUSSIA", "POLAND",
    "SWEDEN", "FINLAND", "HOLLAND", "BELGIUM", "SWITZERLAND", "INTERNATIONAL",
    "DOMESTIC", "IMPORTED",
}

# item line: [+] itemnum  size  pack PK  proof(PF)|vintage(VTG)  rest(deals/month)
ITEM_RE = re.compile(
    r"^(\+)?\s*(\d{3,7})\s+(\d+(?:\.\d+)?\s*(?:ML|LT|L|OZ|GAL))\s+(\d+)\s*PK\b\s*"
    r"(?:(\d+(?:\.\d+)?)\s*PF\b|(\d{4})\s*VTG\b|(\d{4})\b)?\s*(.*)$",
    re.I,
)
RIP_RE = re.compile(r"^RIP:\s*(\d+)\b(.*)$", re.I)
PRICE_LINE_RE = re.compile(r"\b1\s*(BOTTLE|CASE|SLEEVE)\b", re.I)
DOLLAR_RE = re.compile(r"\$(-?\d+(?:\.\d+)?)")
UNIT_RE = re.compile(r"\$(\d+(?:\.\d+)?)\s*/\s*(EA|OZ)", re.I)


def _section_of(page):
    txt = page.extract_text() or ""
    first = txt.split("\n")[0] if txt else ""
    m = HEADER_RE.search(first)
    if not m:
        return None
    name = re.sub(r"\s+", " ", m.group(1)).strip().upper()
    # map header text to a known section key (partial/startswith tolerant)
    if name in config.SECTION_PARSER:
        return name
    for key in config.SECTION_PARSER:
        if key in name or name in key:
            return key
    return name  # unknown -> caller skips


def _font_class(fontname, size):
    """Classify a line by its dominant font. The book is rigidly styled:
    Kingsbridge-Bold = TYPE/COUNTRY headers, Asap-Bold = BRAND,
    Asap-SemiBold = PRODUCT label, Asap-Italic = description, Asap-Regular = data.
    """
    fn = fontname or ""
    if "Kingsbridge" in fn:
        return "type" if size >= 8.5 else "country"
    if "SemiBold" in fn:
        return "product"
    if "Bold" in fn:
        return "brand"
    if "Italic" in fn:
        return "desc"
    return "data"


def _column_lines_fonts(page, cuts):
    """Per-line text (with correct spacing, from words) plus dominant font class.
    Returns list per column of (top, text, fclass)."""
    words = [w for w in page.extract_words(extra_attrs=["fontname", "size"])
             if w["top"] > 40 and w["top"] < page.height - 20]
    ncol = len(cuts) + 1
    cols = [[] for _ in range(ncol)]
    for w in words:
        ci = 0
        while ci < len(cuts) and w["x0"] >= cuts[ci]:
            ci += 1
        cols[ci].append(w)
    out = []
    for col in cols:
        lines = collections.defaultdict(list)
        for w in col:
            lines[round(w["top"] / 2.0) * 2].append(w)
        seq = []
        for top in sorted(lines):
            row = sorted(lines[top], key=lambda w: w["x0"])
            text = " ".join(w["text"] for w in row)
            # weight font by word length so a long line's body font dominates
            fonts = collections.Counter()
            for w in row:
                fonts[(w.get("fontname"), round(w.get("size", 0), 1))] += len(w["text"])
            (fn, sz), _ = fonts.most_common(1)[0]
            seq.append((top, text.strip(), _font_class(fn, sz)))
        out.append(seq)
    return out


def _column_lines(page, cuts):
    """Group words into columns (by x0 against `cuts`) then into lines (by top).
    Returns list of column line-lists: [[(top, text), ...], ...]."""
    words = [w for w in page.extract_words(use_text_flow=False, keep_blank_chars=False)
             if w["top"] > 40 and w["top"] < page.height - 20]
    ncol = len(cuts) + 1
    cols = [[] for _ in range(ncol)]
    for w in words:
        c = 0
        while c < len(cuts) and w["x0"] >= cuts[c]:
            c += 1
        cols[c].append(w)
    out = []
    for col in cols:
        lines = collections.defaultdict(list)
        for w in col:
            lines[round(w["top"] / 2.0) * 2].append(w)
        seq = []
        for top in sorted(lines):
            row = sorted(lines[top], key=lambda w: w["x0"])
            seq.append((top, " ".join(w["text"] for w in row)))
        out.append(seq)
    return out


def _item_anchors(page):
    """x0 of the repeated 'ITEM' header tokens -> column boundaries."""
    xs = sorted(w["x0"] for w in page.extract_words() if w["text"].upper() == "ITEM")
    # de-dup near-equal
    uniq = []
    for x in xs:
        if not uniq or x - uniq[-1] > 30:
            uniq.append(x)
    return uniq


def _is_banner(text):
    t = text.strip()
    if not t or "$" in t:
        return False
    letters = [c for c in t if c.isalpha()]
    if not letters:
        return False
    upper = sum(1 for c in letters if c.isupper()) / len(letters)
    return upper > 0.85


def _split_flags(banner):
    """Trailing program flags off a brand banner: 'ARDBEG F LA GP JNC'."""
    toks = banner.split()
    flags = []
    while toks and toks[-1].upper() in PROGRAM_FLAGS:
        flags.insert(0, toks.pop())
    return " ".join(toks).strip(), (" ".join(flags) if flags else None)


# --------------------------------------------------------------------------
def _banner_kind(name):
    toks = name.split()
    if not toks:
        return "other"
    if all(w in COUNTRY_WORDS for w in toks):
        return "country"
    if all(w in TYPE_WORDS for w in toks):
        return "type"
    return "brand"


def parse_catalog(col_lines, page_no, section, items, combos, unparsed):
    """Parser A state machine, driven by per-line font class.

    type/country headers set context only; brand (Asap-Bold) and product
    (Asap-SemiBold) build the match name; italic lines are product_notes; data
    lines carry item/RIP/price rows."""
    page_brand = None   # last BRAND banner seen anywhere on the page (fallback)
    for ci, seq in enumerate(col_lines):
        ctx_brand = ctx_flags = ctx_type = ctx_country = None
        ctx_product = []
        cur = None
        notes = []
        combo_pending = None

        def close():
            nonlocal cur
            if cur:
                items.append(cur)
            cur = None

        for top, text, fclass in seq:
            t = text.strip()
            if not t:
                continue
            # ---- structured lines claimed FIRST, before font-based naming, so a
            # mis-fonted data row never becomes a brand/product. ----
            if "COMBO SAVINGS:" in t.upper():
                m = DOLLAR_RE.search(t)
                combo_pending = (" ".join(ctx_product) or ctx_brand or "",
                                 float(m.group(1)) if m else None)
                continue
            mr = RIP_RE.match(t)
            if mr:
                if cur is not None:
                    cur["rip_id"] = mr.group(1)
                    _apply_prices(cur, mr.group(2))
                else:
                    unparsed.append((page_no, ci, top, t))
                continue
            # A price/dollar row, BUT never swallow a new item line here: item
            # lines carry a deal string like '1C\\$60' (has a '$'), and with lazy
            # emit the prior item is still open, so without this guard the new
            # item was consumed as a price and lost (~938 items).
            if (cur is not None and not ITEM_RE.match(t)
                    and (PRICE_LINE_RE.search(t) or UNIT_RE.search(t) or DOLLAR_RE.search(t))):
                _apply_prices(cur, t)
                continue
            # ---- font-based naming context ----
            # NOTE: these do NOT emit the current item. A product/brand label can
            # appear BETWEEN an item line and its price rows (combos, wrapped
            # labels), so the item stays open and accumulates its prices until the
            # NEXT item line or the column end. Premature close() here dropped the
            # price on ~40% of catalogue items.
            if fclass in ("type", "country"):
                if fclass == "type":
                    ctx_type = t
                else:
                    ctx_country = t
                ctx_brand = ctx_flags = None
                ctx_product = []
                notes = []
                continue
            if fclass == "brand":
                name, flags = _split_flags(t)
                ctx_brand, ctx_flags = name, flags
                page_brand = name        # page-level fallback so items are never brandless
                ctx_product = []
                notes = []
                continue
            if fclass == "product":
                ctx_product = [t]   # a new product label replaces the prior one
                notes = []
                continue
            if fclass == "desc":
                notes.append(t)
                continue
            # ---- remaining data lines ----
            mi = ITEM_RE.match(t)
            if mi:
                close()
                plus, num, size, pack, pf, vtg1, vtg2, rest = mi.groups()
                tiers = util.parse_deal_tiers(t)
                prod = " ".join(ctx_product).strip()
                # an item must never be brandless: fall back to the last brand
                # banner seen on the page when the immediate context was reset.
                brand = ctx_brand or page_brand
                name = " ".join(p for p in (brand, prod) if p) or brand
                name = util.clean_display_name(name or "") or name
                cur = {
                    "page": page_no, "column": ci, "section": section,
                    "item_number_raw": num,
                    "item_number_norm": util.norm_item_catalog(num),
                    "is_changed": bool(plus),
                    "size_raw": size, "size_ml": util.parse_size_ml(size),
                    "pack_qty": int(pack),
                    "proof": float(pf) if pf else None,
                    "vintage": (vtg1 or vtg2),
                    "brand": brand, "product_name": name,
                    "product_notes": " ".join(notes) or None,
                    "program_flags": ctx_flags, "category": section,
                    "type": ctx_type, "country": ctx_country,
                    "front_line_case_price": None, "bottle_price": None,
                    "best_rip_bottle_price": None, "unit_price": None,
                    "unit_of_measure": None, "rip_id": None,
                    "deals": [(q, u, a, util.find_month(t)) for (q, u, a) in tiers],
                    "raw_attributes": {"item_text": t},
                }
                if combo_pending is not None:
                    combos.append({
                        "page": page_no, "item_number_norm": cur["item_number_norm"],
                        "title": combo_pending[0], "contents_raw": " ".join(notes) or None,
                        "savings_amount": combo_pending[1], "case_price": None,
                        "section": section,
                    })
                    combo_pending = None
                notes = []
                continue
            mr = RIP_RE.match(t)
            if mr and cur is not None:
                cur["rip_id"] = mr.group(1)
                _apply_prices(cur, mr.group(2))
                continue
            if cur is not None and (PRICE_LINE_RE.search(t) or UNIT_RE.search(t) or DOLLAR_RE.search(t)):
                _apply_prices(cur, t)
                continue
            close()
            unparsed.append((page_no, ci, top, t))
        close()


def _apply_prices(item, text):
    """Pull case / bottle / best-rip / unit prices off a child row.

    Column order on a CASE row is [BUY PER CS, BEST RIP PER BT]; some rows also
    carry a leading per-OZ/EA unit price (e.g. '1 CASE $7.14 $181.00 $181.00').
    So the case price is the SECOND-TO-LAST dollar and best-rip is the LAST, not
    the first (which can be the unit price)."""
    um = UNIT_RE.search(text)
    if um:
        item["unit_price"] = float(um.group(1))
        item["unit_of_measure"] = um.group(2).upper()
    dollars = [float(x) for x in DOLLAR_RE.findall(text)]
    up = text.upper()
    if "CASE" in up and dollars:
        if len(dollars) >= 2:
            item["front_line_case_price"] = dollars[-2]
            item["best_rip_bottle_price"] = dollars[-1]
            if len(dollars) >= 3 and item["unit_price"] is None:
                item["unit_price"] = dollars[0]  # leading /OZ or /EA price
        else:
            item["front_line_case_price"] = dollars[0]
    elif ("BOTTLE" in up or "SLEEVE" in up) and dollars:
        item["bottle_price"] = dollars[-1]
        if item["best_rip_bottle_price"] is None:
            item["best_rip_bottle_price"] = dollars[-1]


# --------------------------------------------------------------------------
BD_RE = re.compile(
    r"^(?P<name>.+?)\((?P<item>\d{6,10})\)\s*(?P<pk>\d+)\s*"
    r"\$(?P<amt>-?\d+(?:\.\d+)?)\s*(?P<mon>[A-Z]{3})?\s*$"
)


def parse_best_deal(col_lines, page_no, section, items, deals, unparsed):
    """Parser B: best-deal (2-col) rows. Partial-month handled separately."""
    for ci, seq in enumerate(col_lines):
        cat = None
        for top, text in seq:
            t = text.strip()
            if not t:
                continue
            m = BD_RE.match(t)
            if not m:
                if _is_banner(t) and len(t.split()) <= 3:
                    cat = t
                else:
                    unparsed.append((page_no, ci, top, t))
                continue
            name = m.group("name").strip().rstrip("-").strip()
            size = None
            ms = re.search(r"-\s*([\d.]+\s*(?:ML|LT|L|OZ))\s*$", name, re.I)
            if ms:
                size = ms.group(1)
                name = name[:ms.start()].strip()
            norm = util.norm_item_padded(m.group("item"))
            items.append({
                "page": page_no, "column": ci, "section": section,
                "item_number_raw": m.group("item"), "item_number_norm": norm,
                "is_changed": False, "size_raw": size,
                "size_ml": util.parse_size_ml(size or ""),
                "pack_qty": int(m.group("pk")), "proof": None, "vintage": None,
                "brand": name, "product_name": name, "product_notes": None,
                "program_flags": None, "category": cat, "type": None, "country": None,
                "front_line_case_price": None, "bottle_price": None,
                "best_rip_bottle_price": None, "unit_price": None,
                "unit_of_measure": None, "rip_id": None, "deals": [],
                "raw_attributes": {"buy_var": float(m.group("amt")), "source": "best_deal"},
            })
            deals.append({
                "item_number_norm": norm, "tier_qty": int(m.group("pk")),
                "tier_unit": "C", "discount_amount": float(m.group("amt")),
                "effective_month": util.find_month(m.group("mon") or ""),
                "source_section": section, "start_date": None, "end_date": None,
                "case_price": None, "bottle_price": None,
            })


PM_HEAD_RE = re.compile(r"^(?P<name>.+?)\((?P<item>\d{6,10})\)\s*$")
PM_ROW_RE = re.compile(
    r"^(?P<s>\d{4}/\d{2}/\d{2})\s+(?P<e>\d{4}/\d{2}/\d{2})\s+(?P<q>\d+)\s+"
    r"\$(?P<case>\d+(?:\.\d+)?)\s+\$(?P<btl>\d+(?:\.\d+)?)\s*$"
)


def parse_partial(page, page_no, section, items, deals, unparsed):
    """Partial-month is a single-column list: header line then date/qty rows."""
    cur = None
    for raw in (page.extract_text() or "").split("\n")[1:]:
        t = raw.strip()
        if not t or "PARTIAL MONTH" in t.upper() or t.upper().startswith("START"):
            continue
        mh = PM_HEAD_RE.match(t)
        if mh:
            name = mh.group("name").strip().rstrip("-").strip()
            size = None
            ms = re.search(r"-\s*([\d.]+\s*(?:ML|LT|L|OZ))\s*$", name, re.I)
            if ms:
                size = ms.group(1); name = name[:ms.start()].strip()
            norm = util.norm_item_padded(mh.group("item"))
            cur = norm
            items.append({
                "page": page_no, "column": 0, "section": section,
                "item_number_raw": mh.group("item"), "item_number_norm": norm,
                "is_changed": False, "size_raw": size,
                "size_ml": util.parse_size_ml(size or ""), "pack_qty": None,
                "proof": None, "vintage": None, "brand": name, "product_name": name,
                "product_notes": None, "program_flags": None, "category": None,
                "type": None, "country": None, "front_line_case_price": None,
                "bottle_price": None, "best_rip_bottle_price": None,
                "unit_price": None, "unit_of_measure": None, "rip_id": None,
                "deals": [], "raw_attributes": {"source": "partial_month"},
            })
            continue
        mr = PM_ROW_RE.match(t)
        if mr and cur:
            deals.append({
                "item_number_norm": cur, "tier_qty": int(mr.group("q")),
                "tier_unit": "C", "discount_amount": None,
                "effective_month": None, "source_section": section,
                "start_date": mr.group("s").replace("/", "-"),
                "end_date": mr.group("e").replace("/", "-"),
                "case_price": float(mr.group("case")), "bottle_price": float(mr.group("btl")),
            })
            continue
        unparsed.append((page_no, 0, 0, t))


RI_REF_RE = re.compile(r"#\s*(\d{5,7})")


def parse_retail(col_lines, page_no, section, deals, unparsed):
    """Parser C: brand-level retail-incentive tiers across 3 columns."""
    for ci, seq in enumerate(col_lines):
        pending_name = None
        for top, text in seq:
            t = text.strip()
            if not t:
                continue
            tiers = util.parse_retail_tiers(t)
            if tiers and pending_name:
                ref = RI_REF_RE.search(pending_name)
                norm = util.norm_item_padded(ref.group(1)) if ref else None
                for (q, u, a) in tiers:
                    deals.append({
                        "item_number_norm": norm, "tier_qty": q, "tier_unit": u,
                        "discount_amount": a, "effective_month": None,
                        "source_section": section, "start_date": None, "end_date": None,
                        "case_price": None, "bottle_price": None,
                        "brand_label": re.sub(r"\(\d+\)\s*$", "", pending_name).strip(),
                    })
                pending_name = None
            elif tiers and not pending_name:
                unparsed.append((page_no, ci, top, t))
            else:
                # a brand/label line (often ends with "(NN)" index)
                pending_name = t


def parse_combos(col_lines, page_no, section, combos, items, unparsed):
    """Parser D: combo packs use catalog-style item lines plus a title/savings."""
    for ci, seq in enumerate(col_lines):
        title = savings = contents = None
        for top, text in seq:
            t = text.strip()
            if not t:
                continue
            if re.search(r"COMBO.*\(\d+(?:\+\d+)+\)", t.upper()) or t.upper().startswith("COMBO"):
                title = t
                continue
            if "COMBO SAVINGS:" in t.upper():
                m = DOLLAR_RE.search(t)
                savings = float(m.group(1)) if m else None
                continue
            mi = ITEM_RE.match(t)
            if mi:
                num = mi.group(2)
                norm = util.norm_item_catalog(num)
                cp = None
                combos.append({
                    "page": page_no, "item_number_norm": norm, "title": title,
                    "contents_raw": contents, "savings_amount": savings,
                    "case_price": cp, "section": section,
                })
                title = savings = contents = None
                continue
            if re.match(r"^\d+-\d+", t) or "ML" in t.upper():
                contents = (contents + " " + t) if contents else t
            else:
                unparsed.append((page_no, ci, top, t))


# --------------------------------------------------------------------------
def extract(pdf_path=None, max_pages=None):
    pdf_path = str(pdf_path or config.PDF_PATH)
    items, deals, combos, unparsed = [], [], [], []
    section_pages = collections.Counter()
    detect_log = []
    with pdfplumber.open(pdf_path) as pdf:
        for idx, page in enumerate(pdf.pages):
            p1 = idx + 1
            if p1 < config.SKIP_BEFORE:
                continue
            if max_pages and p1 > max_pages:
                break
            section = _section_of(page)
            kind = config.SECTION_PARSER.get(section) if section else None
            detect_log.append((p1, section, kind))
            if not kind:
                continue
            section_pages[kind] += 1
            if kind in ("A", "D"):
                anchors = _item_anchors(page)
                if len(anchors) >= 3:
                    cuts = [anchors[1] - 6, anchors[2] - 6]
                else:
                    cuts = [config._THIRD * 1, config._THIRD * 2] if hasattr(config, "_THIRD") \
                        else [page.width / 3, 2 * page.width / 3]
                if kind == "A":
                    parse_catalog(_column_lines_fonts(page, cuts), p1, section, items, combos, unparsed)
                else:
                    parse_combos(_column_lines(page, cuts), p1, section, combos, items, unparsed)
            elif kind == "B":
                if "PARTIAL" in (section or ""):
                    parse_partial(page, p1, section, items, deals, unparsed)
                else:
                    anchors = _item_anchors(page)
                    cuts = [anchors[1] - 6] if len(anchors) >= 2 else [page.width / 2]
                    cl = _column_lines(page, cuts)
                    parse_best_deal(cl, p1, section, items, deals, unparsed)
            elif kind == "C":
                cuts = [page.width / 3, 2 * page.width / 3]
                cl = _column_lines(page, cuts)
                parse_retail(cl, p1, section, deals, unparsed)
    return {
        "items": items, "deals": deals, "combos": combos, "unparsed": unparsed,
        "section_pages": dict(section_pages), "detect_log": detect_log,
    }
