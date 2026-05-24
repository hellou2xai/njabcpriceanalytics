# Tracker (Watchlist) & Orders — Full UI/Data Specification

Copy-ready specification for rebuilding the Tracker page and Order Detail page in another application. All field names are generic where possible; domain-specific terms are in parentheses.

---

## PART A: TRACKER PAGE (Watchlist / Order List)

### A1. Page Layout

```
+--------------------------------------------------------------+
| HEADER                                                        |
|  Title: "My Order List"                                       |
|  Subtitle: "N saved products"                                 |
|  Buttons: [Templates] [History] [Export CSV]                  |
+--------------------------------------------------------------+
| BUY SIGNAL SUMMARY (pill badges)                              |
|  [3 BUY NOW] [2 GOOD BUY] [1 HOLD] [1 WAIT]                |
+--------------------------------------------------------------+
| TEMPLATES PANEL (collapsible)                                 |
+--------------------------------------------------------------+
| HISTORY PANEL (collapsible)                                   |
+--------------------------------------------------------------+
| FILTERS                                                       |
|  [Search input] [Category dropdown] [x] Group by category    |
+--------------------------------------------------------------+
| MAIN TABLE (sortable, scrollable)                             |
|  Star | Code | Description | Brand | Size | Case Cost |      |
|       |      | + buy signal|       |      | + trend   |      |
|  Btl Cost | RIP Save | Effective | Qty (Btl/Case) | Notes | |
|  Target | + Order                                             |
+--------------------------------------------------------------+
| ROW LIMIT: Showing N of M  [25|50|100|200]                   |
+--------------------------------------------------------------+
| SUMMARY BAR                                                   |
|  "N items in cart - Estimated total: $X,XXX.XX"              |
|  Category breakdown: Cat1: N items - $X | Cat2: N items - $X |
|  [Save as Order] button                                       |
+--------------------------------------------------------------+
```

### A2. API Data Contract — Tracked Item (OrderItem)

Each item returned from `GET /api/v1/watchlist/order` has:

```typescript
type TrackedItem = {
  // Identity
  product_code: string;
  description: string | null;
  size: string | null;
  pack: number | null;
  category_slug: string | null;
  category_display: string | null;
  brand_slug: string | null;
  brand_display: string | null;
  divisions: string | null;              // space-separated zone codes
  distributor_slug: string | null;
  distributor_name: string | null;

  // Current pricing
  case_cost: string | null;              // decimal as string, e.g. "195.55"
  btl_cost: string | null;

  // Best discount tier (top-level summary)
  has_rip: boolean;
  rip_tier: string | null;              // e.g. "5CS"
  rip_tier_cases: number | null;        // e.g. 5
  rip_save_amount: string | null;       // e.g. "22.50"
  rip_case_price: string | null;        // case cost after discount
  rip_btl_price: string | null;
  effective_case: string | null;         // case_cost - best discount
  effective_btl: string | null;
  rip_discount_pct: string | null;       // e.g. "11.5"

  // ALL discount tiers (array, sorted by tier_cases ascending)
  all_rips: RipTier[];

  // Price history intelligence (computed server-side)
  prev_case_cost: string | null;         // previous edition price
  price_pct_change: string | null;       // e.g. "-3.2" or "+5.1"
  price_direction: string | null;        // "up" | "down" | "flat" | "new"
  low_12m: string | null;               // lowest case_cost in 12 months
  high_12m: string | null;              // highest case_cost in 12 months
  avg_12m: string | null;               // average case_cost over 12 months
  months_at_price: number | null;        // consecutive months at current price
  at_12m_low: boolean;                   // current price = 12-month low
  at_12m_high: boolean;                  // current price = 12-month high
  had_rip_prev: boolean;                 // discount existed in previous edition

  // Buy intelligence (computed server-side)
  buy_signal: string;                    // "BUY_NOW" | "GOOD_BUY" | "HOLD" | "DEFER"
  buy_reasons: string[];                 // ["At 12-month low", "New RIP this edition"]

  // User-set fields
  target_case_price: string | null;      // price alert threshold
  target_btl_price: string | null;
  notes: string | null;                  // inline note
  created_at: string;                    // when added to tracker
};

type RipTier = {
  tier: string;                          // "1CS", "3CS", "5CS"
  tier_cases: number;                    // 1, 3, 5
  save_amount: string;                   // per-case savings
  case_price: string | null;             // case price at this tier
  btl_price: string | null;
  effective_case: string | null;         // case_cost - save_amount
  effective_btl: string | null;
  discount_pct: string | null;           // savings as % of case_cost
};
```

### A3. Table Columns — Exact Specification

| # | Column Key | Header | Sortable | Align | Hide Below | Content |
|---|-----------|--------|----------|-------|------------|---------|
| 1 | `favorite` | (none) | No | left | never | **Star toggle** (filled=tracked, click removes) |
| 2 | `code` | Code | Yes | left | never | Product code (monospace, small). Below: source/distributor name as colored badge |
| 3 | `description` | Description | Yes | left | never | **Product name** (clickable, opens popup). Below: **Buy Signal Badge** + up to 2 reasons |
| 4 | `brand` | Brand | Yes | left | sm | Brand name, small gray text |
| 5 | `size` | Size | Yes | left | sm | Size + pack (e.g. "750ML / 6pk") |
| 6 | `case_cost` | Case Cost | Yes | right | never | **Price** (large). Below: **Price Trend** indicator (see A4) |
| 7 | `btl_cost` | Btl Cost | Yes | right | md | Bottle cost, small gray text |
| 8 | `rip_save` | RIP Save | Yes | right | never | **Best discount save amount** (green). Below: tier info "5CS min - 3 tiers" |
| 9 | `effective` | Effective | Yes | right | never | Case cost after best discount (green, bold) |
| 10 | `qty` | Qty | No | center | never | **Quantity stepper** (see A5) |
| 11 | `notes` | Notes | No | left | never | **Inline editable note** (see A6) |
| 12 | `target` | Target | No | right | md | **Inline target price** (see A7) |
| 13 | `add_to_order` | (none) | No | left | never | **"+ Order" button** with dropdown (see A8) |

### A4. Price Trend Indicator (per row)

Rendered in the Case Cost column, below the price value.

```
Direction = "down":  ↓ -3.2%    (green)
Direction = "up":    ↑ +5.1%    (red)
Direction = "flat":  → +0.0%    (gray)
Direction = "new":   "new"      (gray, small)

Below the arrow/percentage:
  "was $201.55"        (small gray, if prev_case_cost exists)
  "12m low"            (small green badge, if at_12m_low = true)
  "12m high"           (small red badge, if at_12m_high = true AND NOT at_12m_low)
```

### A5. Quantity Stepper (per row)

Two rows of stepper controls stacked vertically:

```
Btl  [-] [3] [+]    (bottles: label + minus + number input + plus)
Case [-] [2] [+]    (cases: label + minus + number input + plus)

Below (if item has discount tiers):
  RIP Progress Bar:
  [████████░░░░] 2/5CS    (amber bar, shows cases vs needed)
  [████████████] RIP unlocked!  (green bar, when cases >= tier_cases)
```

- Minus button disabled at 0
- Number input: no spinner arrows, centered, monospace
- Cart state stored in localStorage (`lpb_current_cart`), restored on page load
- Progress bar width = min(100%, (cartCases / tier_cases) * 100)

### A6. Inline Editable Note

```
[Add note...                  ]   (transparent border, blends into row)
                                   On hover: border appears
                                   On focus: white background, editable
                                   On blur: auto-saves if changed
                                   "Saved" flash (green, 1.5s) above field
```

API: `PATCH /watchlist/items/{code}` with `{ notes: "text" }`

### A7. Inline Target Price

```
[  —  ]   (small right-aligned input, transparent border)
           On hover/focus: border, editable
           On blur: auto-saves if changed
           "Saved" flash above field
           Decimal input mode for mobile
```

API: `PATCH /watchlist/items/{code}` with `{ target_case_price: 150.00 }`

### A8. "Add to Order" Button (per row)

```
[+ Order ▼]   (small button)

Dropdown (positioned right-aligned, below button):
  ┌──────────────────────────┐
  │ ADD TO DRAFT ORDER       │  (section header, small gray)
  │ Friday Order    12 items │  (click = add item to this order)
  │ Weekend GS      3 items │
  │ ────────────────────────│
  │ + Create new order...    │  (click = show inline name input)
  │   [Order name...      ]  │
  │   [Create & Add]         │
  └──────────────────────────┘

On success: flash "Added!" with link to order detail
On error: flash "Failed: message"
Flash duration: 4 seconds
```

### A9. Buy Signal Badge

```
Styled badge (10px, bold, uppercase, rounded, bordered):

BUY_NOW:   green background/border, green text "BUY NOW"
GOOD_BUY:  sky/blue background/border, blue text "GOOD BUY"
HOLD:      gray background/border, gray text "HOLD"
DEFER:     amber background/border, amber text "WAIT"

Below badge (if reasons exist):
  "At 12-month low · New RIP this edition"   (max 2 reasons, dot-separated)
```

### A10. RIP Save Column Detail

```
If no discount:  "—" (gray dash)

If has discount:
  "$22.50"          (green, bold, monospace — best save amount)
  "5CS min · 3 tiers"  (small gray — minimum cases + tier count)
```

### A11. Buy Signal Summary Bar

Rendered above the table as horizontal pill badges:

```
[3 BUY NOW]  [2 Good Buy]  [1 Hold]  [1 Wait]
   green         sky/blue      gray      amber
```

Only badges with count > 0 are shown.

### A12. Cart Summary Bar (bottom of table)

```
If cart has items:
  "5 items in cart · Estimated total: $1,234.56"    [Save as Order]
  Vodka: 2 items · $489.00 | Whiskey: 3 items · $745.56

If cart is empty:
  "7 tracked products · Set quantities or save all to an order"
```

- Total cost uses qualifying discount tier price: if cartCases >= tier_cases, use that tier's effective_case
- Category breakdown only shown if > 1 category has items

### A13. "Save as Order" Flow

1. Click "Save as Order" button
2. Browser prompt: "Enter a name for this order:" (default: "Order MM/DD/YYYY")
3. Creates real order via `POST /orders` API
4. Copies all tracked items via `POST /orders/{id}/copy-from-watchlist`
5. Syncs cart quantities via `PATCH /orders/{id}/items/{code}` for each item with qty > 0
6. Saves to localStorage history (max 50 entries)
7. Navigates to `/orders/{id}` (the new order detail page)

### A14. Templates Panel

Toggleable panel (click "Templates" button in header).

```
┌──────────────────────────────────────────────────────┐
│ Order Templates                                       │
│ [Template name...              ] [Save Cart]          │
│                                                       │
│ Friday Usual    5 items · 5/20/2026   [Load] [Delete] │
│ Weekend Big     12 items · 5/18/2026  [Load] [Delete] │
└──────────────────────────────────────────────────────┘
```

- Save: stores current cart quantities (items with qty > 0) under a name
- Load: replaces current cart with template's quantities
- Storage: localStorage key `lpb_order_templates`

### A15. History Panel

```
┌──────────────────────────────────────────────────────┐
│ Order History                                         │
│                                                       │
│ Friday Order  11:30 AM · 7 items · $1,234.56         │
│                                    [View Order] [Re-order] │
│ Saturday Run  3:15 PM · 3 items · $456.78            │
│                                              [Re-order] │
└──────────────────────────────────────────────────────┘
```

- "View Order" links to `/orders/{id}` (if created via API)
- "Re-order" loads that order's cart quantities back into current cart

### A16. Filters

```
[Search products...         ] [All categories ▼] [x] Group by category
```

- Search: 250ms debounce, sent as `?search=` to API
- Category: dropdown populated from distinct categories in current data
- Group by category: checkbox toggle
  - When ON: table split into sections, each with category header showing name + count + subtotal

### A17. Group by Category View

```
┌──────────────────────────────────────────────────────────┐
│ VODKA (3)                            Subtotal: $731.63   │
│ ──────────────────────────────────────────────────────── │
│ ★ 3976020 | BLUE 80 PROOF | Absolut | 1.75L | $242.94  │
│ ★ 1234560 | PREMIUM       | Grey G  | 750ML | $298.50  │
│ ★ 7890120 | CITRON        | Absolut | 1L    | $190.19  │
│                                                          │
│ WHISKEY (2)                          Subtotal: $349.09   │
│ ──────────────────────────────────────────────────────── │
│ ★ 0014240 | ALABAMA 85PF  | Clyde M | 750ML | $195.55  │
│ ★ 0013290 | BOURBON 92PF  | Clyde M | 50ML  | $153.55  │
└──────────────────────────────────────────────────────────┘
```

---

## PART B: ORDER DETAIL PAGE

### B1. Page Layout

```
+--------------------------------------------------------------+
| HEADER BAR                                                    |
|  [←] Order Name (click to edit) [GS badge] [DRAFT badge]    |
|  Created 5/21/2026 · Updated 5/22/2026                      |
|                                                               |
|  [Copy from Tracked] [Export Excel] [Clone Order]            |
|  [Email Rep ▼] [Submit Order] [Delete]                       |
+--------------------------------------------------------------+
| DIVISION SELECTOR (pill buttons)                              |
|  [All] [L] [S] [D] [GS] [FB] [JD] [IV]                    |
+--------------------------------------------------------------+
| PAYMENT ANALYSIS PANEL (3 cards)                              |
|  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐         |
|  │ PAYMENT NOW  │ │ REBATE LATER │ │ EFFECTIVE    │         |
|  │ $4,567.89    │ │ $456.78      │ │ $4,111.11   │         |
|  └──────────────┘ └──────────────┘ └──────────────┘         |
|  RIP as % of order: 10.0%                                    |
|  BY CATEGORY TABLE                                            |
+--------------------------------------------------------------+
| RECOMMENDATIONS BANNER (collapsible)                          |
|  Recommendations (3) ▸                                        |
|  [CLO] Closeout item — buy before discontinued               |
|  [WAIT] Upcoming special in 3 days has better price          |
|  [RIP] Add 2 more cases to reach 5CS tier, save $22 more    |
+--------------------------------------------------------------+
| PRODUCT TABLE (sortable)                                      |
|  Product | Brand | Cat | Div | Case Cost | RIP by Case |    |
|  After RIP | Qty Cases | Qty Btls | Line Invoice |          |
|  Line RIP | Line Effective | Notes | Recs + Remove          |
+--------------------------------------------------------------+
| ROW LIMIT                                                     |
+--------------------------------------------------------------+
| ADD PRODUCT PANEL (draft only)                                |
|  [Product code...        ] [Add]                             |
+--------------------------------------------------------------+
| SUMMARY FOOTER                                                |
|  Items: 12  Cases: 45  Bottles: 8                            |
|  Invoice: $4,567.89  RIP Rebate: $456.78  Effective: $4,111 |
+--------------------------------------------------------------+
```

### B2. API Data Contract — Order Detail

```typescript
type OrderDetail = {
  id: string;
  name: string;                          // editable
  division: string | null;               // zone filter
  status: string;                        // "draft" | "submitted" | "completed"
  order_notes: string | null;
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
  items: OrderLine[];
  payment: PaymentAnalysis;
  recommendations: OrderRecommendation[];
};

type OrderLine = {
  product_code: string;
  description: string | null;
  size: string | null;
  pack: number | null;
  category_slug: string | null;
  category_display: string | null;
  brand_slug: string | null;
  brand_display: string | null;
  divisions: string | null;
  case_cost: string | null;
  btl_cost: string | null;
  qty_cases: number;                     // editable
  qty_bottles: number;                   // editable
  selected_rip_tier: string | null;
  notes: string | null;                  // editable inline
  has_rip: boolean;
  rip_tiers: OrderRipTier[];             // ALL tiers for this item
  best_rip_save: string | null;
  line_invoice: string | null;           // case_cost * qty_cases (server-computed)
  line_rip_rebate: string | null;        // savings for qualifying tier * qty
  line_effective: string | null;         // line_invoice - line_rip_rebate
  recommendations: OrderRecommendation[];
  is_closeout: boolean;
};

type OrderRipTier = {
  tier: string;                          // "1CS", "3CS", "5CS"
  tier_cases: number;                    // 1, 3, 5
  save_amount: string;                   // per-case savings at this tier
  case_price: string | null;             // case price after this discount
  btl_price: string | null;
};

type PaymentAnalysis = {
  invoice_total: string;                 // sum of all line_invoice
  rip_rebate_total: string;              // sum of all line_rip_rebate (capped)
  effective_total: string;               // invoice - rebate
  rip_pct_of_order: string | null;       // rebate / invoice * 100
  by_category: PaymentCategoryBreakdown[];
};

type PaymentCategoryBreakdown = {
  category: string;
  invoice: string;
  rebate: string;
  effective: string;
  item_count: number;
};

type OrderRecommendation = {
  type: string;                          // "closeout" | "defer" | "rip_optimizer"
  message: string;                       // human-readable advice
  priority: string;                      // "high" | "medium" | "low"
};
```

### B3. Table Columns — Exact Specification

| # | Column Key | Header | Sortable | Align | Hide Below | Content |
|---|-----------|--------|----------|-------|------------|---------|
| 1 | `description` | Product | Yes | left | never | **Name** (clickable popup). Below: "750ML / 6pk · 0014240" (size + code) |
| 2 | `brand` | Brand | Yes | left | md | Brand name, small gray |
| 3 | `category` | Category | Yes | left | lg | Category name, small gray |
| 4 | `divisions` | Div | Yes | left | lg | Division codes (monospace, small gray) |
| 5 | `case_cost` | Case Cost | Yes | right | never | Price (monospace) |
| 6 | `rip_save` | RIP by Case | Yes | left | never | **All discount tiers listed vertically** (see B4) |
| 7 | `line_effective_unit` | After RIP | Yes | right | sm | case_cost minus best_rip_save (green if has discount) |
| 8 | `qty_cases` | Qty Cases | Yes | center | never | **Quantity stepper**: CS [-] 5 [+] |
| 9 | `qty_bottles` | Qty Btls | Yes | center | sm | **Quantity stepper**: Btl [-] 2 [+] |
| 10 | `line_invoice` | Line Invoice | Yes | right | md | case_cost * qty_cases (monospace) |
| 11 | `line_rip_rebate` | Line RIP | Yes | right | md | discount rebate for this line (amber, bold). "—" if none |
| 12 | `line_effective` | Line Effective | Yes | right | never | line_invoice - line_rip_rebate (green, bold) |
| 13 | `notes` | Notes | No | left | lg | **Inline editable note** (same as tracker) |
| 14 | `recs` | Recs | No | left | never | **Recommendation badges** + **Remove button** (draft only) |

### B4. RIP by Case Column — Line-by-Line Tier Display

Each discount tier is rendered as a separate row within the cell:

```
┌──────────────────────────────────────────┐
│ [1CS] save $15.00/cs                     │   (gray background — not met)
│ [3CS] save $18.50/cs        BEST         │   (light amber — best tier, not met)
│ [5CS] save $22.50/cs          ✓          │   (green background — qty meets this tier)
└──────────────────────────────────────────┘
```

Per tier row:
- **Tier badge**: rounded pill, "5CS" bold
  - Green background if `qty_cases >= tier_cases` (tier is met)
  - Gray background if not met
- **Save amount**: "save $22.50/cs" (green text, monospace)
- **Checkmark** (✓): shown when tier is met (`qty_cases >= tier_cases`)
- **"BEST" label**: shown on the highest-save tier when NOT met (amber text, tiny)
- **Row background**:
  - `bg-emerald-50 border border-emerald-200` when met
  - `bg-amber-50/50 border border-amber-100` for best tier (not met)
  - No background for other tiers

If no discount: single "—" dash (gray)

### B5. Payment Analysis Panel

Three cards in a responsive grid (1 col mobile, 3 col desktop):

```
┌─────────────────────┐  ┌─────────────────────┐  ┌─────────────────────┐
│ PAYMENT NEEDED NOW  │  │ RIP REBATE           │  │ EFFECTIVE COST      │
│ (Invoice)           │  │ (cheque later)       │  │                     │
│                     │  │                      │  │                     │
│ $4,567.89           │  │ $456.78              │  │ $4,111.11           │
│                     │  │                      │  │                     │
│ white bg            │  │ amber bg/border      │  │ green bg/border     │
│ zinc-900 text       │  │ amber-800 text       │  │ emerald-800 text    │
│                     │  │                      │  │ bold                │
└─────────────────────┘  └─────────────────────┘  └─────────────────────┘

Below: "RIP as % of order: 10.0%"  (amber, only if > 0)
```

### B6. By Category Breakdown Table

```
┌────────────────────────────────────────────────────────────┐
│ BY CATEGORY                                                 │
├──────────────┬───────┬──────────┬─────────┬───────────────┤
│ Category     │ Items │ Invoice  │ Rebate  │ Effective     │
├──────────────┼───────┼──────────┼─────────┼───────────────┤
│ Vodka        │   5   │ $1,214.70│ $112.50 │ $1,102.20    │
│ Whiskey      │   3   │ $   549.09│ $  45.00│ $   504.09  │
│ Tequila      │   4   │ $2,804.10│ $299.28 │ $2,504.82    │
└──────────────┴───────┴──────────┴─────────┴───────────────┘
  Items/Invoice/Rebate columns hidden on mobile (sm breakpoint)
```

### B7. Recommendations Banner

Collapsible section with count in header:

```
▸ Recommendations (3)     (click to expand/collapse)

[CLO]  closeout  high     TEQUILA OCHO PLATA — Closeout item, buy before discontinued
[WAIT] defer     medium   BLUE 80 PROOF — Upcoming special in 3 days has better price
[RIP]  rip_opt   low      BOURBON 92 — Add 2 more cases to reach 5CS tier, save $22.50
```

Badge styles:
- `closeout` (CLO): rose/red background
- `defer` (WAIT): amber background
- `rip_optimizer` (RIP): sky/blue background

Each recommendation has `type`, `message`, `priority` displayed in a bordered card.

### B8. Division Selector

Horizontal row of pill buttons for filtering order items by delivery zone:

```
(All) (L) (S) (D) (GS) (FB) (JD) (IV)
```

- "All" selected by default (no filter)
- Click a division: filters table to items whose `divisions` field contains that code
- Click active division again: deselects (back to All)
- Active button: navy background, white text
- Inactive button: white background, gray text, gray border

Division color coding (used for badge on order header):
- L=violet, S=sky, D=amber, GS=emerald, FB=rose, JD=orange, IV=indigo

### B9. Header Bar Actions

| Button | Condition | Action |
|--------|-----------|--------|
| **← Back** | Always | Navigate to `/orders` |
| **Order Name** | Always | Click to edit inline (see B10) |
| **Division Badge** | If set | Colored pill showing division code |
| **Status Badge** | Always | "DRAFT" (gray), "SUBMITTED" (blue), "COMPLETED" (green) |
| **Copy from Tracked** | Always | Bulk-add all items from tracking list |
| **Export Excel** | Always | Download XLSX via fetch+blob, respects division filter |
| **Clone Order** | Always | Creates duplicate as new draft, navigates to it |
| **Email Rep ▼** | Always | Dropdown of sales reps, generates mailto: link with order items |
| **Submit Order** | Draft only | Finalizes: draft → submitted |
| **Delete** | Draft only | Confirmation dialog, then hard delete + navigate to list |

### B10. Inline Editable Order Name

```
Default:    "Friday Order"     (click to edit)
Editing:    [Friday Order     ] (auto-focused input, underline style)
            Enter = save, Escape = cancel, blur = save if changed
```

### B11. Email Rep Dropdown

```
[Email Rep ▼]

┌──────────────────────────────────────────┐
│ John Smith        L      john@dist.com   │  (click = generate mailto)
│ Jane Doe          GS     jane@dist.com   │
│ ──────────────────────────────────────── │
│ Custom email...                          │  (no rep, opens compose)
└──────────────────────────────────────────┘

If no reps configured:
│ Compose email...                         │
│ Add sales reps in Settings               │  (link to /settings)
```

API: `POST /sales-reps/email/{order_id}` returns `{ to, subject, body }`. Frontend opens `mailto:` URL.

### B12. Add Product Panel (draft only)

```
ADD PRODUCT
[Product code (e.g. 12345)     ] [Add]
```

- Submit on Enter or click "Add"
- Error message below if product code not found
- Only shown when order status = "draft"

### B13. Summary Footer

Sticky footer bar:

```
Items: 12    Cases: 45    Bottles: 8        Invoice: $4,567.89
                                            RIP Rebate: $456.78  (amber)
                                            Effective: $4,111.11 (green, bold)
```

Left side: counts (items, cases, bottles) — small uppercase labels
Right side: financial totals (invoice, rebate, effective) — colored, monospace

### B14. Quantity Stepper (Order Detail variant)

Simpler than tracker version — display only, no progress bar:

```
CS [-] 5 [+]     (cases stepper)
Btl [-] 2 [+]    (bottles stepper, hidden below sm)
```

Each change calls `PATCH /orders/{id}/items/{code}` immediately (no localStorage cart).

### B15. Recommendation Badges (per row)

Small colored badges in the last column, next to the remove button:

```
[CLO]  = rose badge (closeout item)
[WAIT] = amber badge (defer recommendation)
[RIP]  = sky badge (tier optimizer suggestion)
```

Hover tooltip shows full recommendation message.
Remove button (trash icon) only shown for draft orders.

---

## PART C: ORDERS LIST PAGE

### C1. API Type

```typescript
type OrderSummary = {
  id: string;
  name: string;
  division: string | null;
  status: string;                        // "draft" | "submitted" | "completed"
  order_notes: string | null;
  item_count: number;
  total_cases: number;
  total_bottles: number;
  invoice_total: string | null;
  rip_rebate_total: string | null;
  effective_total: string | null;
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
  hidden_at: string | null;              // non-null = archived
};
```

### C2. List Page Actions

| Action | Endpoint |
|--------|----------|
| List orders | `GET /orders?status=&division=&include_hidden=` |
| Create order | `POST /orders` with `{ name, division?, order_notes? }` |
| Update order | `PATCH /orders/{id}` |
| Delete order | `DELETE /orders/{id}` |
| Submit | `POST /orders/{id}/submit` |
| Hide/Archive | `POST /orders/{id}/hide` |
| Unhide | `POST /orders/{id}/unhide` |
| Clone | `POST /orders/{id}/clone` |
| Copy tracked items | `POST /orders/{id}/copy-from-watchlist` |
| Export | `GET /orders/{id}/export?format=xlsx&division=` |
| Email | uses sales rep API to generate mailto data |

---

## PART D: API ENDPOINTS (complete list for tracker + orders)

### Tracker / Watchlist

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/watchlist` | Simple list of tracked items |
| GET | `/watchlist/order` | **Enriched list** with all intelligence fields |
| POST | `/watchlist/items` | Add item `{ code, distributor?, notes? }` |
| PATCH | `/watchlist/items/{code}` | Update `{ target_case_price?, target_btl_price?, notes? }` |
| DELETE | `/watchlist/items/{code}` | Remove item |

### Orders

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/orders` | List all orders (filter by status, division, include_hidden) |
| POST | `/orders` | Create `{ name, division?, order_notes? }` |
| GET | `/orders/{id}` | Full detail + items + payment analysis + recommendations |
| PATCH | `/orders/{id}` | Update `{ name?, division?, status?, order_notes? }` |
| DELETE | `/orders/{id}` | Delete order |
| POST | `/orders/{id}/items` | Add item `{ code, qty_cases?, qty_bottles?, notes? }` |
| PATCH | `/orders/{id}/items/{code}` | Update `{ qty_cases?, qty_bottles?, selected_rip_tier?, notes? }` |
| DELETE | `/orders/{id}/items/{code}` | Remove item |
| POST | `/orders/{id}/copy-from-watchlist` | Bulk copy all tracked items |
| POST | `/orders/{id}/submit` | Finalize (draft → submitted) |
| POST | `/orders/{id}/hide` | Archive |
| POST | `/orders/{id}/unhide` | Restore |
| POST | `/orders/{id}/clone` | Duplicate as new draft |
| GET | `/orders/{id}/export?format=xlsx&division=` | Download Excel |

### Notes

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/products/{code}/notes` | List notes for product |
| POST | `/products/{code}/notes` | Add note `{ body }` |
| PATCH | `/notes/{id}` | Edit note |
| DELETE | `/notes/{id}` | Soft-delete note |
