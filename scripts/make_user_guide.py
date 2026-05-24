#!/usr/bin/env python
"""Generate the end-user guide PDF (docs/CELR_User_Guide.pdf).

Run: python scripts/make_user_guide.py
"""
from pathlib import Path

from reportlab.lib.pagesizes import LETTER
from reportlab.lib.units import inch
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, PageBreak, ListFlowable, ListItem,
)

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "CELR_User_Guide.pdf"

BLUE = colors.HexColor("#2563eb")
SLATE = colors.HexColor("#0f172a")
MUTED = colors.HexColor("#64748b")

styles = getSampleStyleSheet()
H1 = ParagraphStyle("H1", parent=styles["Heading1"], textColor=BLUE, fontSize=16, spaceBefore=16, spaceAfter=6)
H2 = ParagraphStyle("H2", parent=styles["Heading2"], textColor=SLATE, fontSize=12.5, spaceBefore=10, spaceAfter=3)
BODY = ParagraphStyle("Body", parent=styles["BodyText"], fontSize=10, leading=14, spaceAfter=5, textColor=SLATE)
BULLET = ParagraphStyle("Bullet", parent=BODY, leftIndent=12, spaceAfter=2)
TITLE = ParagraphStyle("TitleX", parent=styles["Title"], textColor=BLUE, fontSize=26, leading=30)
SUB = ParagraphStyle("Sub", parent=styles["Normal"], fontSize=12, textColor=MUTED, spaceAfter=2)

# Content as (kind, text). kind: h1, h2, p, b (bullet), gap, pagebreak.
CONTENT = [
    ("h1", "What this is"),
    ("p", "CELR Retail Pricing Intelligence reads the New Jersey ABC wholesale price lists and turns them into a buying tool for independent liquor retailers. It shows you, across your distributors, where the real deals are: discounts, RIP rebates, bundle combos, clearance, and month-to-month price changes. You can track products, build orders, and see your margin before you buy."),
    ("p", "The app runs in your browser at <b>nj.celr.ai</b>. It is in beta, so you will see a small BETA badge, and a Feedback button on every page."),

    ("h1", "Getting started"),
    ("h2", "Create your account"),
    ("b", "Go to nj.celr.ai and choose Create an account. Enter your name, email, and a password of at least 8 characters."),
    ("b", "You will get an activation email. Click the link in it to activate your account. If you do not see it within a minute, check your spam or junk folder."),
    ("b", "On the sign-in screen you can use Resend activation email if you need the link again, or Forgot password? to reset your password."),
    ("h2", "Add your stores"),
    ("p", "After signing in the first time, add your store. Type the store name and the address is filled in for you. Add every store you own: more stores means more useful, store-level analytics."),

    ("h1", "The dashboard"),
    ("p", "The dashboard is your starting point. Use the distributor filter at the top right to focus on one distributor or see all of them together."),
    ("h2", "Key metrics"),
    ("p", "A quick count of total items, active discounts and the savings pool, clearance items, price drops, price increases, and active RIP promotions for the current edition."),
    ("h2", "My workspace"),
    ("p", "Shortcuts to your favorites, orders in progress (drafts), submitted orders, and your notes."),
    ("h2", "Insights and opportunities"),
    ("p", "Tiles that surface the best opportunities. Click any tile to open the full list, where you can filter, sort, and Export to Excel:"),
    ("b", "Time-Sensitive Deals: deals with a specific start or end date inside the month, with stickers for one-day-only and under-a-week deals, and filters for the next few days, this week, next two weeks, next month, and past deals."),
    ("b", "Biggest Price Drops and Top Discount Opportunities."),
    ("b", "Price Changes month over month."),
    ("b", "Cross-distributor comparisons (who is cheaper for the same product) and distributor exclusives."),

    ("h1", "Catalog"),
    ("p", "The full product catalog with live pricing. Search by product name, UPC, or size. The search is smart, so 'glenlivet 12 375' matches the product and the size together."),
    ("b", "Open Filters on the left to narrow by deals (has discount, has RIP), distributor, price range, and category. With many columns, the table scrolls sideways so you can reach the rightmost columns."),
    ("b", "Columns show the case and bottle price, discount and RIP tiers, the amount you save, the effective (after-deal) price, and ROI / GP%."),
    ("b", "Right-click a row (or use the three-dots menu) for actions: View Product, Search the web for prices and details, Add to Order Analysis, Add to Favorites, Add to Order, and Copy Code."),
    ("b", "Add to Order lets you add the product to one of your draft orders, or choose New order for that distributor to start one on the spot."),
    ("b", "Use Tracked only to show just the products on your watchlist."),
    ("h2", "Product detail"),
    ("p", "Click View Product for the full breakdown: price waterfall (list to discount to RIP to what you pay), all discount and RIP tiers with ROI, every edition's prices, a price history chart, and a place to add notes."),

    ("h1", "Combos (bundle deals)"),
    ("p", "Multi-product bundles sold as a pack. Click any row to see the full breakdown: what each item costs separately, the bundle price, and your total saving. You can add the whole bundle to an order or to Order Analysis. Validity dates and a next-month outlook are shown for each combo."),

    ("h1", "RIP Products"),
    ("p", "Every product carrying a RIP rebate, with the current month and next month shown side by side so you can plan ahead. Filter by distributor, category, incentive type, minimum saving or GP%, and whether the tier is by case or by bottle."),

    ("h1", "Favorites and Notes"),
    ("b", "Favorites is your watchlist. Star a product anywhere to track it, set a target price, and add a note. You can be alerted when a product hits your target."),
    ("b", "Notes gathers every note you have written, on products, favorites, and orders, into one place so nothing gets lost."),

    ("h1", "Orders"),
    ("p", "Build the orders you will place with each distributor."),
    ("b", "An order is scoped to one distributor and (optionally) one sales rep. There is one open order per distributor and rep pair; creating for a pair you already have open simply opens that order."),
    ("b", "To create one, pick a distributor (required), optionally a sales rep, optionally a name, then Create Order. You can also start an order straight from the catalog or a combo with New order for that distributor."),
    ("b", "In an order, each line shows the case and bottle price, the best RIP saving, the effective cost, and GP%. GP% is shown for the full price versus the discounted price so you can see the margin the deal adds."),
    ("b", "The All Order Lines tab shows every line across your orders, grouped by distributor and sales rep, with totals."),
    ("b", "When an order is ready you can submit it; you can also clone an order or archive it."),

    ("h1", "Order Analysis"),
    ("p", "A working area to gather candidate products and combos from around the app, compare them, and save the result as an order when you are happy."),

    ("h1", "Alerts"),
    ("p", "Alerts flag the things worth acting on: new clearance, a watchlist product hitting your target price, new discounts, and significant price drops or increases."),

    ("h1", "Configuration"),
    ("p", "Your master data lives here: sales reps (each tied to a division and a distributor), divisions, and stores. Set these up so orders and analytics line up with how you actually buy."),

    ("h1", "Your profile"),
    ("p", "From your name at the bottom of the menu you can view and update your profile and change your password."),

    ("h1", "Feedback and beta"),
    ("p", "This app is in beta. Use the Feedback button at the bottom right of any page to report a bug or suggest an improvement; just type your note and send. Your account and the page you are on are attached automatically, so you do not need to add them."),

    ("h1", "Good to know"),
    ("b", "Pricing data is refreshed about once a month from the official price lists, so figures reflect the latest loaded edition."),
    ("b", "Retail and GP% figures based on a shelf price only appear where a retail price is available; the deal-versus-list GP% is always shown."),
    ("b", "If the app has been idle for a while, the very first page load can take a few extra seconds to wake up."),
]


def build():
    OUT.parent.mkdir(parents=True, exist_ok=True)
    doc = SimpleDocTemplate(
        str(OUT), pagesize=LETTER,
        leftMargin=0.85 * inch, rightMargin=0.85 * inch,
        topMargin=0.8 * inch, bottomMargin=0.7 * inch,
        title="CELR Retail Pricing Intelligence - User Guide",
    )
    flow = [
        Spacer(1, 1.6 * inch),
        Paragraph("CELR Retail Pricing Intelligence", TITLE),
        Spacer(1, 6),
        Paragraph("User Guide", SUB),
        Paragraph("NJ ABC wholesale price intelligence for liquor retailers", SUB),
        Paragraph("nj.celr.ai", SUB),
        PageBreak(),
    ]

    bullets: list = []

    def flush_bullets():
        if bullets:
            flow.append(ListFlowable(
                [ListItem(Paragraph(b, BULLET), leftIndent=10, value="•") for b in bullets],
                bulletType="bullet", start="•",
            ))
            bullets.clear()

    for kind, text in CONTENT:
        if kind == "b":
            bullets.append(text)
            continue
        flush_bullets()
        if kind == "h1":
            flow.append(Paragraph(text, H1))
        elif kind == "h2":
            flow.append(Paragraph(text, H2))
        elif kind == "p":
            flow.append(Paragraph(text, BODY))
    flush_bullets()

    doc.build(flow)
    print(f"Wrote {OUT} ({OUT.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    build()
