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

# Content as (kind, text). kind: h1, h2, p, b (bullet), pagebreak.
CONTENT = [
    ("h1", "What this is"),
    ("p", "CELR Retail Pricing Intelligence reads the New Jersey ABC wholesale price lists every month and turns them into a buying tool for independent liquor retailers. Instead of flipping through PDFs from each distributor, you get one searchable view of every product, every discount, every RIP rebate, every bundle combo, and every clearance item, with the maths already done."),
    ("p", "The questions it answers: where is this product cheapest right now, how much do I save if I hit the next quantity tier, which deals end this week, who beats whom on the same item, and what is my margin if I buy on the deal. You can track products, build orders per distributor, and see the profit before you commit."),
    ("p", "It runs in your browser at <b>nj.celr.ai</b>. It is in beta, so you will see a small BETA badge in the corner and a Feedback button on every page."),
    ("h2", "A note on the terms"),
    ("b", "Edition: one month's price list from a distributor (for example 2026-06). The app usually compares the current edition with next month's."),
    ("b", "Discount: a quantity break printed in the price list (buy more cases, pay less per case)."),
    ("b", "RIP: a rebate or incentive program. Buying a set quantity earns a rebate, which lowers your effective cost."),
    ("b", "Combo: a fixed bundle of several products sold together at one pack price."),
    ("b", "Effective price: what you actually end up paying per case after discounts and RIP rebates are applied."),
    ("b", "GP%: gross profit margin. The app shows it both at the full (list) price and at the discounted price, so you can see how much margin the deal adds."),

    ("pagebreak", ""),
    ("h1", "Getting started"),
    ("h2", "Create and activate your account"),
    ("b", "Go to nj.celr.ai and choose Create an account. Enter your name, email, and a password of at least 8 characters."),
    ("b", "You will receive an activation email. Click the link to activate your account. A popup after sign-up reminds you of this and tells you to check spam."),
    ("b", "Cannot find the email? Wait a minute, check your spam or junk folder, and if needed use Resend activation email on the sign-in screen."),
    ("b", "Forgot your password later? Use Forgot password? on the sign-in screen to get a reset link by email."),
    ("h2", "Add your stores"),
    ("p", "The first time you sign in you are asked to add a store. Type the store name and the address is looked up and filled in for you. Add every store you own. The more complete your store list, the more useful the store-level analytics become. You can manage stores later under Configuration."),

    ("h1", "Finding your way around"),
    ("p", "The left menu is your map. In short:"),
    ("b", "Dashboard: the headline numbers and the best opportunities right now."),
    ("b", "Catalog: every product, with search, filters, and deal columns."),
    ("b", "Combos: bundle deals and their breakdowns."),
    ("b", "RIP Products: products with rebate tiers, this month next to next month."),
    ("b", "Favorites: your tracked products (watchlist)."),
    ("b", "Notes: every note you have written, in one place."),
    ("b", "Orders: the orders you are building for each distributor."),
    ("b", "Order Analysis: a scratch pad to compare items before committing."),
    ("b", "Configuration: your master data (sales reps, divisions, stores)."),
    ("b", "Alerts: things worth acting on, like price drops and target hits."),

    ("pagebreak", ""),
    ("h1", "The dashboard"),
    ("p", "The dashboard is your starting point. The distributor buttons at the top right (All, Allied, Fedway, and so on) filter everything on the page to one distributor or show them all together."),
    ("h2", "Key metrics"),
    ("p", "The row of cards gives the shape of the current edition at a glance: total items in the catalog, active discounts (with the total savings pool in dollars), clearance items, the number of price drops and price increases versus last month, and active RIP promotions."),
    ("h2", "My workspace"),
    ("p", "Quick links to your own things: saved favorites, orders in progress (drafts you are still building), submitted orders, and your notes, each showing a couple of recent entries."),
    ("h2", "Insights and opportunities"),
    ("p", "These tiles do the hunting for you. Each shows a preview; click it to open the full, sortable list with filters and an Export to Excel button. Click any product row to open its full detail."),
    ("b", "Time-Sensitive Deals: deals whose window is a specific range inside the month (not the whole month), so they are easy to miss. A red 1-DAY ONLY or amber UNDER A WEEK sticker flags the urgent ones. Filter by Next 3 days, This week, Next 2 weeks, Next month, or Past deals, and by distributor. Columns include the original case price, the discount, the net (after-deal) case and bottle price, days left, and GP%."),
    ("b", "Biggest Price Drops: the largest reductions versus the previous edition."),
    ("b", "Top Discount Opportunities: the largest savings per case, filterable by distributor, category, and deal type."),
    ("b", "Price Changes (month over month): what went up or down between this edition and next."),
    ("b", "Cross-distributor comparisons: for the same product carried by two distributors, which one is cheaper (for example Allied vs Fedway), and by how much."),
    ("b", "Exclusives: products one distributor carries that the other does not."),

    ("pagebreak", ""),
    ("h1", "Catalog"),
    ("p", "The Catalog is the full product list with live pricing. It is where most browsing happens."),
    ("h2", "Searching"),
    ("p", "The search box is smart: it matches product name, UPC, and size in one query. Typing 'glenlivet 12 375' finds the Glenlivet 12 in the 375ml size. You can also paste a UPC."),
    ("h2", "Filtering"),
    ("b", "Open the Filters panel on the left to narrow the list by deals (Has RIP offer, Has discount, or their opposites), distributor, price range per case, and category (Wine, Spirits, Beer, and so on)."),
    ("b", "Tracked only shows just the products on your Favorites list, so you can watch your own shortlist."),
    ("b", "When the filters are open and the table is wide, the table scrolls sideways so the rightmost columns and the row actions are always reachable."),
    ("h2", "Reading the columns"),
    ("b", "CASE / BTL: the list price per case and per bottle."),
    ("b", "TIER: how many quantity tiers are available below the list price (the deeper you buy, the lower the per-case cost)."),
    ("b", "SAVE (CS / BTL): how much you save per case and per bottle at the best tier."),
    ("b", "EFFECTIVE (CS / BTL): the price you actually pay after the best discount and RIP rebate."),
    ("b", "ROI / GP%: the return on the deal and the gross margin."),
    ("b", "BETTER PRICE: whether another distributor has the same item cheaper."),
    ("h2", "Expanding a product"),
    ("p", "Rows with deals expand to show the individual discount and RIP tiers underneath (for example Buy 5 cs = $15.00, Buy 20 cs = $75.00), each with the price and saving at that tier, so you can see exactly where the breaks are."),

    ("h1", "The quick-action (right-click) menu"),
    ("p", "Right-click any product row in the catalog (or use the three-dots button) for a menu of actions on that product:"),
    ("b", "View Product: open the full product detail (see the next section)."),
    ("b", "Search the web (prices and details): look the product up online for street prices and tasting or product details, without leaving the app."),
    ("b", "Add to Order Analysis: drop it onto your comparison scratch pad."),
    ("b", "Add to Favorites: start tracking it on your watchlist (toggles to Remove from Favorites)."),
    ("b", "Add to Order: add it to one of your open draft orders, or choose New order for that distributor to start the first order right there."),
    ("b", "Copy Code: copy the UPC or product code to your clipboard."),

    ("pagebreak", ""),
    ("h1", "Product detail"),
    ("p", "View Product opens the full picture for one item. It is the deepest single-product view in the app."),
    ("b", "Price breakdown waterfall: a visual of list price, then the discount reduction, then the RIP reduction, ending at what you pay."),
    ("b", "Discount tiers: each quantity break with the saving per case, the resulting per-case price, and the ROI at that tier."),
    ("b", "RIP tiers: each rebate tier showing what to buy (cases or bottles), the bundle rebate, the per-case saving, the resulting price, the cost to hit it, and the ROI."),
    ("b", "All editions breakdown: a sortable table of every month on record for this item, with list price, best discount, RIP per case, effective price, and total saving, so you can spot a pattern."),
    ("b", "Price history: a chart of the effective cost over time, plus a short summary of the trend, the best month, the biggest saving, the current price versus list, and the price range."),
    ("b", "Compare and month-over-month: you can compare the same product across two distributors side by side, or this month against next month, to decide where and when to buy."),
    ("b", "Notes: add a note about the product right from this view; it shows up later in the Notes screen."),

    ("h1", "Combos (bundle deals)"),
    ("p", "Combos are fixed bundles of several products sold together at one pack price. The Combos screen lists them all; click any row to open the full breakdown."),
    ("h2", "The breakdown"),
    ("b", "A plain-language summary: what the items would cost bought separately (the regular value), the bundle price you pay, and the dollars and percentage you save."),
    ("b", "A visual savings bar showing the percentage off."),
    ("b", "An item table: every product in the bundle with its regular price, its combo price, and the saving on each, so you can see which items carry the deal."),
    ("b", "A heads-up warning when the distributor's figures look inconsistent (an unusually high implied discount), so you verify before ordering."),
    ("b", "Deal dates: when the combo is valid, plus a next-month outlook (continues, ends, or starts next month, with the next-month price where it continues)."),
    ("h2", "Acting on a combo"),
    ("b", "Add bundle to Order adds every product in the bundle to one of your orders as separate lines, all tagged to the combo. Add bundle to Order Analysis drops it onto the comparison pad."),
    ("b", "On the list, filter by validity (this month, next month, both) and by a minimum saving, and click a row to open its detail."),

    ("pagebreak", ""),
    ("h1", "RIP Products (rebate analysis)"),
    ("p", "This screen is built around RIP rebate programs. It lists every product that carries a RIP, with the current month and next month shown side by side, so you can plan a buy before the program changes."),
    ("b", "Each tier reads as a simple instruction, for example 1 btl = $330 or 1 cs = $999, meaning the rebate you earn at that quantity."),
    ("b", "For both the current and next edition you see the case price, the RIP tier, the saving, and the effective price, plus a GP% and a flag when next month is better, the same, or new."),
    ("b", "Filter by distributor, category, incentive type (discount or RIP), a specific RIP code, a minimum saving per case or minimum GP%, whether tiers are counted by case or by bottle, and whether the program is new next month."),
    ("p", "Use it to answer: which rebates are worth chasing this month, and which are about to change."),

    ("h1", "Favorites and Notes"),
    ("h2", "Favorites (your watchlist)"),
    ("b", "Star a product anywhere to track it. On Favorites you can set a target price and add a note for each one."),
    ("b", "Use the Tracked only filter on the Catalog to see just your favorites, and let Alerts tell you when a favorite hits your target price."),
    ("h2", "Notes"),
    ("p", "Notes pulls together every note you have written, whether on a product, a favorite, an order, or an order line, into a single feed so nothing gets lost. Each note links back to where it came from."),

    ("pagebreak", ""),
    ("h1", "Orders"),
    ("p", "Orders is where you turn the deals you have found into an actual buy list for each distributor."),
    ("h2", "How orders are organised"),
    ("b", "An order belongs to one distributor and, optionally, one sales rep. You keep one open (draft) order per distributor and rep pair, so your in-progress buying stays tidy. Creating an order for a pair you already have open simply reopens it rather than making a duplicate."),
    ("h2", "Creating an order"),
    ("b", "On the Orders screen, pick a distributor (required), optionally a sales rep and a name, then Create Order."),
    ("b", "Or start one without leaving what you are doing: in the Catalog right-click menu or a combo, choose New order for that distributor."),
    ("b", "When you add a product, the app checks it belongs to that order's distributor, so a Fedway item cannot land in an Allied order by mistake."),
    ("h2", "Inside an order"),
    ("b", "Each line shows the case and bottle cost, the best RIP saving, the effective cost, the quantities you enter (cases and bottles), and the line total."),
    ("b", "GP% is shown both ways: at the full price and at the discounted price, so you can see the margin the deal adds. Where you have entered a shelf (retail) price, the retail-based margin appears too."),
    ("b", "RIP tiers on a line are colour-coded so the tier you have unlocked and the best-value tier stand out."),
    ("b", "Save your changes with the Save button; quantities, notes, and retail prices are kept."),
    ("h2", "Across all orders"),
    ("b", "The All Order Lines tab shows every line from every order together, grouped by distributor and sales rep, with the same rich figures and running totals, so you can review a full buying plan in one view."),
    ("b", "You can submit an order when it is ready, clone an order, copy your favorites into an order, and archive orders you are done with."),

    ("h1", "Order Analysis"),
    ("p", "Order Analysis is a scratch pad. Drop in candidate products and combos from around the app (via the right-click menu or the combo detail), compare them in one place, and when you are happy, save the result as an order. A small badge on the menu shows how many items you have gathered."),

    ("pagebreak", ""),
    ("h1", "Alerts"),
    ("p", "Alerts flag the things worth acting on for the latest edition: new clearance items, a watchlist product hitting your target price, new discounts, and significant price drops or increases. You can mark alerts as read, and the menu shows an unread count."),

    ("h1", "Configuration"),
    ("p", "Configuration holds your master data, so orders and analytics match how you actually buy:"),
    ("b", "Sales reps: each with a division and the distributor they cover."),
    ("b", "Divisions: your own grouping for orders and reps."),
    ("b", "Stores: add or edit your stores; the address is looked up from the store name."),

    ("h1", "Your profile and feedback"),
    ("b", "From your name at the bottom of the menu you can view and update your profile and change your password."),
    ("b", "The Feedback button at the bottom right of every page lets you report a bug or suggest an improvement. Just type your note and send; your account and the page you are on are attached automatically, so the team has the context."),

    ("h1", "Good to know"),
    ("b", "Pricing data is refreshed about once a month from the official price lists, so figures reflect the latest loaded edition. Several views compare the current edition with next month where next month is available."),
    ("b", "Margins based on a shelf price only appear where a retail price is known; the deal-versus-list GP% is always shown."),
    ("b", "If the app has been idle for a while, the very first page load can take a few extra seconds to wake up. After that it is quick."),
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
        elif kind == "pagebreak":
            flow.append(PageBreak())
    flush_bullets()

    doc.build(flow)
    print(f"Wrote {OUT} ({OUT.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    build()
