"""
Purchase Order rendering.

build_po_pdf(data) -> bytes renders the PDF; build_po_html(data) -> str renders
the same purchase order as an HTML order summary for the email body, so the rep
can read the whole order without opening the attachment. The caller (orders
endpoints in user_state.py) gathers the order, its priced lines, the sales rep
and the buyer, then hands a plain dict here. Both outputs read from that one
dict, so the PDF, the in-browser preview and the email body always match.
"""

from __future__ import annotations

import html
import io

from reportlab.lib.pagesizes import LETTER
from reportlab.lib.units import inch
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
)

BLUE = colors.HexColor("#2563eb")
SLATE = colors.HexColor("#0f172a")
MUTED = colors.HexColor("#64748b")
LINE = colors.HexColor("#e2e8f0")
ZEBRA = colors.HexColor("#f8fafc")

_styles = getSampleStyleSheet()
_TITLE = ParagraphStyle("po_title", parent=_styles["Heading1"], textColor=SLATE,
                        fontSize=22, leading=24, spaceBefore=0, spaceAfter=0)
_BRAND = ParagraphStyle("po_brand", parent=_styles["Normal"], textColor=BLUE,
                        fontSize=12, leading=14, alignment=2, fontName="Helvetica-Bold")
_BRAND_SUB = ParagraphStyle("po_brand_sub", parent=_styles["Normal"], textColor=MUTED,
                            fontSize=8, leading=10, alignment=2)
_LABEL = ParagraphStyle("po_label", parent=_styles["Normal"], textColor=MUTED,
                        fontSize=7.5, leading=9, fontName="Helvetica-Bold", spaceAfter=1)
_VALUE = ParagraphStyle("po_value", parent=_styles["Normal"], textColor=SLATE,
                        fontSize=9.5, leading=12)
_CELL = ParagraphStyle("po_cell", parent=_styles["Normal"], textColor=SLATE,
                       fontSize=8.5, leading=10.5)
_CELL_SUB = ParagraphStyle("po_cell_sub", parent=_styles["Normal"], textColor=MUTED,
                           fontSize=7, leading=8.5)
_HEAD = ParagraphStyle("po_head", parent=_styles["Normal"], textColor=colors.white,
                       fontSize=8, leading=10, fontName="Helvetica-Bold")


def _money(v) -> str:
    try:
        return f"${float(v):,.2f}"
    except (TypeError, ValueError):
        return ""


def _kv(label: str, value: str) -> Table:
    """A stacked label-over-value mini block used in the meta row."""
    t = Table([[Paragraph(label.upper(), _LABEL)], [Paragraph(value or "—", _VALUE)]],
              colWidths=[1.28 * inch])
    t.setStyle(TableStyle([("LEFTPADDING", (0, 0), (-1, -1), 0),
                           ("RIGHTPADDING", (0, 0), (-1, -1), 0),
                           ("TOPPADDING", (0, 0), (-1, -1), 0),
                           ("BOTTOMPADDING", (0, 0), (-1, -1), 1)]))
    return t


def _party(title: str, lines: list[str]) -> Table:
    rows = [[Paragraph(title.upper(), _LABEL)]]
    for i, ln in enumerate(lines):
        if not ln:
            continue
        style = _VALUE if i == 0 else _CELL
        rows.append([Paragraph(ln, style)])
    if len(rows) == 1:
        rows.append([Paragraph("—", _VALUE)])
    t = Table(rows, colWidths=[3.5 * inch])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), ZEBRA),
        ("BOX", (0, 0), (-1, -1), 0.5, LINE),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (0, 0), 7),
        ("BOTTOMPADDING", (0, -1), (0, -1), 7),
        ("TOPPADDING", (0, 1), (-1, -1), 1),
    ]))
    return t


def _footer(canvas, doc):
    canvas.saveState()
    w, _h = LETTER
    y = 0.5 * inch
    canvas.setStrokeColor(LINE)
    canvas.setLineWidth(0.5)
    canvas.line(0.6 * inch, y + 14, w - 0.6 * inch, y + 14)
    canvas.setFont("Helvetica-Bold", 8)
    canvas.setFillColor(BLUE)
    canvas.drawString(0.6 * inch, y, "Powered by CELR AI")
    canvas.setFont("Helvetica", 7)
    canvas.setFillColor(MUTED)
    canvas.drawRightString(w - 0.6 * inch, y, f"Page {doc.page}")
    canvas.drawCentredString(
        w / 2, y,
        "Prices shown are estimates from published distributor data and are not a guarantee.")
    canvas.restoreState()


def build_po_pdf(data: dict) -> bytes:
    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=LETTER,
        leftMargin=0.6 * inch, rightMargin=0.6 * inch,
        topMargin=0.6 * inch, bottomMargin=0.85 * inch,
        title=f"Purchase Order {data.get('po_number', '')}",
    )
    story: list = []

    # --- Header: title + brand ---
    header = Table(
        [[Paragraph("PURCHASE ORDER", _TITLE),
          Table([[Paragraph("CELR", _BRAND)],
                 [Paragraph("Retail Pricing Intelligence", _BRAND_SUB)]],
                colWidths=[2.6 * inch])]],
        colWidths=[4.0 * inch, 2.6 * inch])
    header.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                                ("LEFTPADDING", (0, 0), (-1, -1), 0),
                                ("RIGHTPADDING", (0, 0), (-1, -1), 0)]))
    story.append(header)
    story.append(Spacer(1, 6))

    # --- Meta row: PO #, revision, date, distributor, division ---
    rev = data.get("revision") or 0
    meta = Table([[
        _kv("PO Number", data.get("po_number", "")),
        _kv("Revision", str(rev) if rev >= 1 else "Draft"),
        _kv("Date", data.get("date", "")),
        _kv("Distributor", data.get("distributor", "")),
        _kv("Division", data.get("division", "")),
    ]], colWidths=[1.32 * inch] * 5)
    meta.setStyle(TableStyle([
        ("LINEABOVE", (0, 0), (-1, 0), 1.2, BLUE),
        ("LINEBELOW", (0, 0), (-1, 0), 0.5, LINE),
        ("TOPPADDING", (0, 0), (-1, -1), 7),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
    ]))
    story.append(meta)
    story.append(Spacer(1, 4))

    # --- Vendor + Ship-To blocks side by side ---
    v = data.get("vendor", {})
    b = data.get("buyer", {})
    vendor_lines = [v.get("name", "")]
    if v.get("rep_name"):
        vendor_lines.append(f"Attn: {v['rep_name']} (Sales Rep)")
    if v.get("rep_email"):
        vendor_lines.append(v["rep_email"])
    if v.get("rep_phone"):
        vendor_lines.append(v["rep_phone"])
    buyer_lines = [b.get("name", "")]
    if b.get("address"):
        buyer_lines.append(b["address"])
    if b.get("license"):
        buyer_lines.append(f"License: {b['license']}")
    if b.get("phone"):
        buyer_lines.append(b["phone"])
    if b.get("email"):
        buyer_lines.append(b["email"])

    parties = Table([[_party("Vendor", vendor_lines), "", _party("Ship To / Buyer", buyer_lines)]],
                    colWidths=[3.5 * inch, 0.2 * inch, 3.5 * inch])
    parties.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"),
                                 ("LEFTPADDING", (0, 0), (-1, -1), 0),
                                 ("RIGHTPADDING", (0, 0), (-1, -1), 0)]))
    story.append(parties)
    story.append(Spacer(1, 14))

    # --- Line items ---
    head = [Paragraph(t, _HEAD) for t in
            ["#", "Description", "UPC", "Size", "Pk", "Cases", "Btls", "Case Cost", "Line Total"]]
    table_rows = [head]
    # group_rows tracks which row indexes are deal-group headers, so the
    # zebra-stripe + alignment logic below skips them.
    group_rows: list[int] = []
    prior_key = "__sentinel__"
    for ln in data.get("lines", []):
        cc = ln.get("combo_code") or None
        rc = ln.get("rip_code") or None
        cur_key = (f"combo:{cc}" if cc else (f"rip:{rc}" if rc else "none"))
        if cur_key != prior_key:
            if cur_key.startswith("combo:"):
                group_rows.append(len(table_rows))
                table_rows.append([
                    Paragraph(f"— Combo #{cc} · bundle priced together —", _LABEL),
                    "", "", "", "", "", "", "", "",
                ])
            elif cur_key.startswith("rip:"):
                group_rows.append(len(table_rows))
                table_rows.append([
                    Paragraph(f"— RIP {rc} · grouped rebate —", _LABEL),
                    "", "", "", "", "", "", "", "",
                ])
            elif prior_key != "__sentinel__":
                group_rows.append(len(table_rows))
                table_rows.append([
                    Paragraph("— No deal grouping —", _LABEL),
                    "", "", "", "", "", "", "", "",
                ])
        prior_key = cur_key

        desc = [Paragraph(ln.get("description", ""), _CELL)]
        if ln.get("rip_note"):
            desc.append(Paragraph(ln["rip_note"], _CELL_SUB))
        # The "#" column is now the running line count, ignoring group headers.
        n = len(table_rows) - 1 - len([g for g in group_rows if g < len(table_rows)])
        table_rows.append([
            Paragraph(str(n), _CELL),
            desc,
            Paragraph(ln.get("upc") or "—", _CELL),
            Paragraph(ln.get("size") or "—", _CELL),
            Paragraph(str(ln.get("pack") or "—"), _CELL),
            Paragraph(str(ln.get("cases") or 0), _CELL),
            Paragraph(str(ln.get("bottles") or 0), _CELL),
            Paragraph(_money(ln.get("case_cost")), _CELL),
            Paragraph(_money(ln.get("line_total")), _CELL),
        ])
    if len(table_rows) == 1:
        table_rows.append([Paragraph("No line items on this order.", _CELL)] + [""] * 8)

    col_w = [0.3, 1.85, 0.9, 0.6, 0.45, 0.6, 0.5, 0.82, 0.88]
    col_w = [c * inch for c in col_w]
    items = Table(table_rows, colWidths=col_w, repeatRows=1)
    style = [
        ("BACKGROUND", (0, 0), (-1, 0), SLATE),
        ("TOPPADDING", (0, 0), (-1, 0), 6),
        ("BOTTOMPADDING", (0, 0), (-1, 0), 6),
        ("TOPPADDING", (0, 1), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 1), (-1, -1), 5),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LINEBELOW", (0, 0), (-1, -1), 0.4, LINE),
        ("ALIGN", (4, 0), (-1, -1), "RIGHT"),
    ]
    # Style the RIP-group header rows: span all 9 columns, light blue
    # background, no zebra.
    for r in group_rows:
        style.append(("SPAN", (0, r), (-1, r)))
        style.append(("BACKGROUND", (0, r), (-1, r), ZEBRA))
        style.append(("ALIGN", (0, r), (-1, r), "LEFT"))
        style.append(("TOPPADDING", (0, r), (-1, r), 4))
        style.append(("BOTTOMPADDING", (0, r), (-1, r), 4))
    group_set = set(group_rows)
    for r in range(1, len(table_rows)):
        if r in group_set:
            continue
        if r % 2 == 0:
            style.append(("BACKGROUND", (0, r), (-1, r), ZEBRA))
    items.setStyle(TableStyle(style))
    story.append(items)

    # --- Totals ---
    sub = data.get("subtotal", 0.0)
    cases_total = sum(int(ln.get("cases") or 0) for ln in data.get("lines", []))
    totals = Table([
        ["", Paragraph("Total cases", _CELL), Paragraph(str(cases_total), _CELL)],
        ["", Paragraph("Estimated total", _VALUE), Paragraph(_money(sub), _VALUE)],
    ], colWidths=[4.5 * inch, 1.4 * inch, 1.0 * inch])
    totals.setStyle(TableStyle([
        ("ALIGN", (1, 0), (-1, -1), "RIGHT"),
        ("LINEABOVE", (1, 1), (-1, 1), 1, SLATE),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("FONTNAME", (1, 1), (-1, 1), "Helvetica-Bold"),
    ]))
    story.append(totals)

    # --- Notes ---
    if data.get("notes"):
        story.append(Spacer(1, 14))
        story.append(Paragraph("NOTES", _LABEL))
        story.append(Paragraph(str(data["notes"]).replace("\n", "<br/>"), _CELL))

    doc.build(story, onFirstPage=_footer, onLaterPages=_footer)
    return buf.getvalue()


# ---- HTML order summary (email body) ----

_SLATE = "#0f172a"
_MUTED = "#64748b"
_BLUE = "#2563eb"
_LINE = "#e2e8f0"
_ZEBRA = "#f8fafc"


def _e(v) -> str:
    """HTML-escape a value, treating None/NaN as a dash."""
    if v is None:
        return "-"
    if isinstance(v, float) and v != v:
        return "-"
    return html.escape(str(v))


def _party_html(title: str, lines: list[str]) -> str:
    body = "".join(
        f'<div style="font-size:13px;color:{_SLATE};{"font-weight:600;" if i == 0 else ""}">{html.escape(l)}</div>'
        for i, l in enumerate(lines) if l
    ) or f'<div style="font-size:13px;color:{_SLATE}">-</div>'
    return (
        f'<td valign="top" width="50%" style="padding:10px 12px;background:{_ZEBRA};'
        f'border:1px solid {_LINE};border-radius:6px">'
        f'<div style="font-size:11px;font-weight:700;color:{_MUTED};text-transform:uppercase;'
        f'letter-spacing:.3px;margin-bottom:4px">{html.escape(title)}</div>{body}</td>'
    )


def build_po_html(data: dict) -> str:
    """Render the purchase order as an inline-styled HTML block for the email
    body. Mirrors the PDF exactly so the rep need not open the attachment."""
    v = data.get("vendor", {}) or {}
    b = data.get("buyer", {}) or {}

    def meta_cell(label: str, value) -> str:
        return (
            f'<td style="padding:6px 10px 6px 0">'
            f'<div style="font-size:10px;font-weight:700;color:{_MUTED};text-transform:uppercase">{html.escape(label)}</div>'
            f'<div style="font-size:13px;color:{_SLATE}">{_e(value)}</div></td>'
        )

    rev = data.get("revision") or 0
    meta = (
        '<table cellpadding="0" cellspacing="0" width="100%" '
        f'style="border-top:2px solid {_BLUE};margin:6px 0 14px"><tr>'
        + meta_cell("PO Number", data.get("po_number"))
        + meta_cell("Revision", str(rev) if rev >= 1 else "Draft")
        + meta_cell("Date", data.get("date"))
        + meta_cell("Distributor", data.get("distributor"))
        + meta_cell("Division", data.get("division") or "-")
        + "</tr></table>"
    )

    vendor_lines = [v.get("name", "")]
    if v.get("rep_name"):
        vendor_lines.append(f'Attn: {v["rep_name"]} (Sales Rep)')
    if v.get("rep_email"):
        vendor_lines.append(v["rep_email"])
    if v.get("rep_phone"):
        vendor_lines.append(v["rep_phone"])
    buyer_lines = [b.get("name", "")]
    for k in ("address", "license", "phone", "email"):
        if b.get(k):
            buyer_lines.append(f'License: {b[k]}' if k == "license" else b[k])

    parties = (
        '<table cellpadding="0" cellspacing="0" width="100%" style="margin-bottom:14px"><tr>'
        + _party_html("Vendor", vendor_lines)
        + '<td width="12"></td>'
        + _party_html("Ship To / Buyer", buyer_lines)
        + "</tr></table>"
    )

    th = (f'style="background:{_SLATE};color:#fff;font-size:11px;font-weight:700;'
          f'padding:7px 6px;text-align:left"')
    th_r = th.replace("text-align:left", "text-align:right")
    head = (
        f'<tr><th {th}>#</th><th {th}>Description</th><th {th}>UPC</th><th {th}>Size</th>'
        f'<th {th_r}>Pk</th><th {th_r}>Cases</th><th {th_r}>Btls</th>'
        f'<th {th_r}>Case Cost</th><th {th_r}>Line Total</th></tr>'
    )

    body_rows = []
    prior_key = "__sentinel__"
    for i, ln in enumerate(data.get("lines", []), start=1):
        # Group header: combos take priority over RIPs, then untied. A header
        # row is inserted whenever the group key changes between lines (lines
        # were pre-sorted in _gather_po so they cluster). The header spans the
        # whole table and is colour-coded by group kind.
        cc = ln.get("combo_code") or None
        rc = ln.get("rip_code") or None
        cur_key = (f"combo:{cc}" if cc else (f"rip:{rc}" if rc else "none"))
        if cur_key != prior_key:
            if cur_key.startswith("combo:"):
                body_rows.append(
                    f'<tr><td colspan="9" style="padding:6px 8px;background:#fff7ed;'
                    f'border-top:1px solid #f59e0b;border-bottom:1px solid {_LINE};'
                    f'font-size:11px;font-weight:700;color:#b45309;letter-spacing:.3px">'
                    f'\U0001f381 Combo #{_e(cc)} · bundle priced together</td></tr>'
                )
            elif cur_key.startswith("rip:"):
                body_rows.append(
                    f'<tr><td colspan="9" style="padding:6px 8px;background:#eff6ff;'
                    f'border-top:1px solid {_BLUE};border-bottom:1px solid {_LINE};'
                    f'font-size:11px;font-weight:700;color:{_BLUE};letter-spacing:.3px">'
                    f'\U0001f517 RIP {_e(rc)} · grouped rebate</td></tr>'
                )
            elif prior_key != "__sentinel__":
                body_rows.append(
                    f'<tr><td colspan="9" style="padding:6px 8px;background:{_ZEBRA};'
                    f'border-top:1px solid {_LINE};border-bottom:1px solid {_LINE};'
                    f'font-size:11px;font-weight:700;color:{_MUTED};letter-spacing:.3px">'
                    f'No deal grouping</td></tr>'
                )
        prior_key = cur_key

        bg = _ZEBRA if i % 2 == 0 else "#ffffff"
        td = (f'style="padding:6px;border-bottom:1px solid {_LINE};font-size:12px;'
              f'color:{_SLATE};background:{bg}"')
        td_r = td.replace("padding:6px;", "padding:6px;text-align:right;")
        desc = _e(ln.get("description"))
        if ln.get("rip_note"):
            desc += f'<br><span style="color:{_MUTED};font-size:11px">{_e(ln["rip_note"])}</span>'
        body_rows.append(
            f"<tr><td {td}>{i}</td><td {td}>{desc}</td><td {td}>{_e(ln.get('upc'))}</td>"
            f"<td {td}>{_e(ln.get('size'))}</td><td {td_r}>{_e(ln.get('pack'))}</td>"
            f"<td {td_r}>{_e(ln.get('cases') or 0)}</td><td {td_r}>{_e(ln.get('bottles') or 0)}</td>"
            f"<td {td_r}>{_money(ln.get('case_cost'))}</td><td {td_r}>{_money(ln.get('line_total'))}</td></tr>"
        )
    if not body_rows:
        body_rows.append(
            f'<tr><td colspan="9" style="padding:8px;font-size:12px;color:{_MUTED}">No line items on this order.</td></tr>'
        )

    items = (
        '<table cellpadding="0" cellspacing="0" width="100%" '
        f'style="border-collapse:collapse;border:1px solid {_LINE}">'
        + head + "".join(body_rows) + "</table>"
    )

    cases_total = sum(int(ln.get("cases") or 0) for ln in data.get("lines", []))
    totals = (
        '<table cellpadding="0" cellspacing="0" width="100%" style="margin-top:8px"><tr>'
        f'<td style="text-align:right;font-size:13px;color:{_SLATE};padding:2px 6px">Total cases</td>'
        f'<td width="90" style="text-align:right;font-size:13px;color:{_SLATE};padding:2px 6px">{cases_total}</td></tr>'
        f'<tr><td style="text-align:right;font-size:14px;font-weight:700;color:{_SLATE};padding:2px 6px;border-top:1px solid {_SLATE}">Estimated total</td>'
        f'<td width="90" style="text-align:right;font-size:14px;font-weight:700;color:{_SLATE};padding:2px 6px;border-top:1px solid {_SLATE}">{_money(data.get("subtotal"))}</td></tr>'
        "</table>"
    )

    notes = ""
    if data.get("notes"):
        notes = (
            f'<div style="margin-top:14px"><div style="font-size:11px;font-weight:700;color:{_MUTED};'
            f'text-transform:uppercase;margin-bottom:3px">Notes</div>'
            f'<div style="font-size:12px;color:{_SLATE}">{html.escape(str(data["notes"])).replace(chr(10), "<br>")}</div></div>'
        )

    return (
        '<div style="border:1px solid ' + _LINE + ';border-radius:8px;padding:16px;margin:8px 0">'
        f'<div style="font-size:16px;font-weight:700;color:{_SLATE};margin-bottom:2px">Purchase Order</div>'
        + meta + parties + items + totals + notes
        + '</div>'
    )
