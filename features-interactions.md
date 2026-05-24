# Interaction Features (Detailed)

Features focused on user interactions, micro-UX, and workflows that connect different parts of the application. These are the "glue" features that make the app feel cohesive.

---

## 1. Right-Click Context Menu

A custom context menu appears on right-click of any product row, on any page across the app (Catalog, RIPs, Closeouts, Combos, Specials, Analytics, Tracking List, Orders, Decisions).

### Actions Available:
1. **View Product** — navigates to full product detail page
2. **Add to / Remove from Tracking List** — toggle star (shows current state)
3. **Add to Order** — expands into a sub-menu listing all draft orders by name + division badge; clicking an order adds the item to that order instantly
4. **Copy Code** — copies the product code to clipboard

### Behavior:
- Menu positions itself to stay within viewport (flips left/right or up/down near edges)
- Closes on outside click or Escape key
- Fetches list of draft orders on open (cached 30s)
- Shows "No draft orders" message if none exist
- Provided as a reusable `useContextMenu()` hook that any page can plug in with one line

---

## 2. Favorite Button (Star Toggle)

An inline star icon that appears on every product row in every table and inside the product popup/detail. Controls add/remove from the default tracking list.

### Add Flow (Click empty star):
1. Star click opens a **popover** (not a modal) anchored below the star
2. Popover has:
   - "Add to Order List" heading
   - Textarea: "Why are you adding this? (optional)" — for attaching a note at add time
   - Cancel / Add buttons
   - Keyboard: Enter = submit, Escape = close
3. On submit: product added to tracking list with the optional note
4. Popover closes, star fills (amber)

### Remove Flow (Click filled star):
- Single click immediately removes from tracking list (no confirmation)
- Star unfills

### Visual States:
- Empty star (not tracked): zinc/gray, hover turns amber
- Filled star (tracked): solid amber
- Disabled (loading): 50% opacity

### Note Indicator:
- If `showNote` is enabled, shows the note text (truncated, italic) next to the star
- Hover on truncated note shows full text via title tooltip

### Query Invalidation:
- On add/remove: invalidates both `["watchlist"]` and `["watchlist-order"]` caches so all views update

---

## 3. Product Quick-View Popup (Modal)

Clicking any product code anywhere in the app opens a global popup modal with a condensed product detail view. No page navigation required.

### Popup Contents:
1. **Header**: category, brand, description, code, size, pack, division codes, favorite star
2. **Pricing Grid** (2x2 or 4-column):
   - Case Cost
   - Bottle Cost
   - vs Previous (% change with color + "was $X" subtitle)
   - Best Discount Save (if applicable)
3. **Discount Tiers**: card per tier showing label, save amount, price after discount
4. **Active Promotions**: card per promotion with description and date range
5. **Price History**: edition-by-edition table (scrollable, max 48vh) with current edition highlighted
6. **"Open Full Detail" link** at bottom navigates to the full product detail page

### Behavior:
- Global context provider — any component can call `open(code, distributor)` to show popup
- Closes on Escape, click outside, or close button
- Backdrop overlay (semi-transparent black)
- Max height 85vh with scroll
- Click stop propagation (clicking inside popup doesn't trigger backdrop close)
- Fetches product detail + price history in parallel on open

### Usage Pattern:
- `<ProductLink code="0047640">` — renders clickable code that opens popup
- Used in every table across the app

---

## 4. Favorite-to-Order Flow

The complete workflow from discovering a product to having it in a finalized order.

### Step 1: Discover + Track
- Browse Catalog, RIPs, Closeouts, Specials, Analytics, Buy Sheet, or any table
- Right-click → "Add to Watch List", or click the star
- Optionally add a note explaining why ("great RIP this month", "closeout price")

### Step 2: Review Intelligence on Tracking List
- Visit Tracking List page
- See buy signals computed for each tracked item:
  - BUY_NOW / GOOD_BUY / HOLD / DEFER badges
  - Plain-English reasons ("At 12-month low", "New RIP this edition", "Price rising — consider deferring")
  - 12-month low/high/avg context
  - Effective price after best discount
- Set target prices for alerts

### Step 3: Create Named Order
- Go to Orders page → "Create Order"
- Set name, division/zone, notes
- Use "Copy from Watch List" to bulk-copy all tracked items into the order

### Step 4: Refine Order
- On Order Detail page:
  - Set quantities (cases + bottles) per line item
  - Select specific discount tier per item
  - See per-line recommendations:
    - "Add 2 more cases to reach next discount tier"
    - "This is a closeout — buy before discontinued"
    - "Upcoming promotion in 3 days has better price — consider deferring"
  - Payment analysis updates live:
    - Invoice Total (what you pay now)
    - Rebate Total (what comes back later, capped per business rules)
    - Effective Total (net cost)
    - Breakdown by category

### Step 5: Score + Optimize
- Visit Decisions → Order Scorecard
- See grade (A-F) with 4 metrics: discount capture rate, category diversity, clearance urgency, price timing
- Follow actionable recommendations to improve the order

### Step 6: Export or Submit
- Export to Excel (full or filtered by division)
- Email order to sales rep (auto-fills recipient from rep table)
- Submit order (draft → submitted, locks editing)

### Alternative Entry Points:
- Right-click any product → "Add to Order" → select draft order (skips tracking list entirely)
- From Product Detail page → "Add to Order" dropdown listing draft orders
- From Buy Sheet → inline "Add to Watch List" button per recommendation

---

## 5. Notes System

### Per-Product Notes (Product Detail Page):
- Notes section at bottom of product detail page
- Add form: text input + "Add" button
- Submit on Enter or click
- Chronological list with:
  - Note body (whitespace preserved)
  - Timestamp
  - Soft-delete (removes from view, retained in DB for audit)
- Notes scoped to product + distributor

### Notes at Favorite-Time:
- When adding a product to tracking list via the star popover, optional note textarea
- Note persists as a tracking list item note
- Shown inline next to the star on tables with `showNote` enabled

### Order-Level Notes:
- Each named order has an `order_notes` text field
- Editable on order detail page header
- Included in Excel export

### Audit Trail:
- All note writes (add, edit, delete) logged to append-only audit log
- Old values / new values captured as JSON diff
- Action types: insert / update / delete / soft_delete / restore

---

## 6. Ratings System (Thumbs Up/Down)

### Per-Item Ratings on Discount Tiers:
- Each discount tier can be rated thumbs up or thumbs down
- Scoped to (user, product, edition)
- Toggle behavior: clicking same rating removes it
- Aggregate counts shown: total up, total down
- Score percentage calculated and displayed

### Visual Modes:
- **Full mode** (Product Detail): larger buttons with counts, progress bar showing sentiment %
  - Green bar >=60%, amber 40-60%, red <40%
- **Compact mode** (table rows): small inline buttons with counts + score %
  - Color-coded score: green/zinc/red

### State:
- `my_rating`: null (not rated), 1 (up), -1 (down)
- Clicking active rating = toggle off (delete)
- Optimistic invalidation on rate/remove

---

## 7. Tracked-Only Toggle

A toggle switch available on Analytics, RIPs, Closeouts, and other table pages.

### Behavior:
- When ON: filters the current view to show only items that are in the user's tracking list
- Intersects the page's normal data with tracking list product codes
- Toggle state is local to each page instance (not persisted)
- Shows tracking list item count in the toggle label

### Use Case:
- "Show me only the closeouts that affect products I'm actually tracking"
- "Which of MY products have price drops this month?"

---

## 8. Clickable Product Links

Any product code displayed anywhere in the app is a clickable link.

### Behavior:
- Renders as monospace, navy-colored text
- Hover: orange color + underline
- Click: opens the Product Quick-View Popup (not navigation)
- Stop propagation: clicking the code doesn't trigger the row click handler

### Usage:
- Present in every table: Catalog, RIPs, Closeouts, Combos, Specials, Analytics tabs, Tracking List, Order Detail, Buy Sheet, Alerts

---

## 9. Inline Add-to-List from Any Table

Beyond the star and right-click menu, specific pages have inline action buttons:

### Buy Sheet (Decisions):
- Each recommendation row has an "Add" button
- One-click add to tracking list directly from the buy sheet

### Analytics Tabs:
- FavoriteButton (star) rendered in each table row
- Quick-add without leaving the analysis view

### Alerts:
- Product code is a clickable popup link
- Star for tracking directly from alert feed

---

## 10. Source (Distributor) Selector

### Global Selector:
- Pill buttons in the app header: one per source + "All"
- Selected source stored in React context, propagated to all pages
- Changing source refreshes all data on the current page

### Per-Page Behavior:
- Catalog, RIPs, Closeouts, Combos, Specials: filter by selected source
- Dashboard: KPIs and movers scoped to selected source
- Analytics: single-source tabs use selected source; cross-source tabs always show comparison
- Tracking List: can contain items from multiple sources, filter by source

---

## 11. Sortable Table Headers

### Behavior:
- Click column header to sort ascending
- Click again to sort descending
- Click third time to remove sort (or cycle back to ascending)
- Sort indicator arrow shown next to active column
- Only one column sorted at a time

### Applied To:
- Catalog, RIPs, Closeouts, Combos, Specials, Tracking List, Orders, Order Detail, Analytics (all tabs), Buy Sheet, Missed Opportunities, Alerts

### Column Types:
- String sort (alphabetical)
- Numeric sort (price, percentage, count)
- Custom sort value function (e.g., sort by underlying number while displaying formatted string)

---

## 12. Sidebar Filter Panel (Catalog)

A persistent filter sidebar on the Catalog page with multiple collapsible filter sections. Drives the faceted search experience.

### Filter Sections:

**Deals / Discount Toggle:**
- "Has RIP offer" checkbox (shows count of items with discounts)
- "No RIP" checkbox (mutually exclusive)

**Sales Divisions:**
- Checkbox per division code (e.g., L, GS, FB, JD, IV)
- Each shows product count
- Multi-select (AND filter)
- Scrollable if many divisions (max-height 200px)

**Price Range (Case):**
- Min/Max text inputs with "Go" button
- Shows overall range from facets ("$X — $Y") as hint text
- Decimal input mode for mobile keyboards

**Category:**
- Hierarchical category tree with checkboxes
- Multi-select
- Product count per category
- Loaded from API with distributor filter

**Brand:**
- Searchable checkbox list
- Search input filters the list as you type (multi-word search)
- Initially shows top 7, "Show all N..." expands full list, "Show less" collapses
- Scrollable container (max-height 240px)
- Multi-select with product counts

**Size:**
- Searchable checkbox list (same component as brands)
- Default collapsed (opens on click)
- Multi-select with product counts

### Shared Filter Behaviors:
- **Collapsible sections**: each section has a toggle header with chevron arrow (rotates on collapse)
- **Active filter count**: header shows total active filter count
- **"Clear all (N)" button**: resets all filters at once (preserves search text and sort)
- **Checkbox items**: hover highlight, label + count layout, truncated long labels
- **Toggle set logic**: clicking a checked item unchecks it (set toggle, not radio)
- **Facet data from API**: `/catalog/facets?distributor=` returns divisions, sizes, brands, price range, totals

### Layout:
- Sidebar on left (desktop), full-width above results (mobile)
- Filters apply immediately on change (no separate "Apply" button except price range)

---

---

## 13. Row Limit Selector

Dropdown on table pages to control how many rows are displayed.

### Options:
- 25 / 50 / 100 / 200 rows
- Default varies by page context
- Applied client-side or as `limit` query param to API

---

## 13. Inline Cart (Tracking List Page)

The tracking list page has a built-in cart system for setting quantities before creating a named order.

### Per-Item Quantity Inputs:
- Bottles field (number input, inline in table row)
- Cases field (number input, inline in table row)
- Changes persist to localStorage automatically (`lpb_current_cart`)
- Cart restored on page reload

### Discount Progress Bar:
- When an item has discount tiers, a progress bar shows how close the cart quantity is to unlocking the next tier
- Visual: colored bar (amber = progress, emerald = unlocked)
- Label: "3/5CS" or "RIP unlocked!" when threshold met
- Dynamically updates as user changes case quantity

### Cart Summary Panel:
- Total items count
- Total cost (computed using qualifying discount tier based on cart cases)
- Breakdown by category: item count + cost per category
- Updates live as quantities change

### Buy Signal Summary:
- Count of BUY_NOW / GOOD_BUY / HOLD / DEFER signals across all tracked items
- Displayed as colored badges in the header

---

## 14. Order Templates (localStorage)

Save and reload cart configurations as named templates.

### Save Template:
- Name input + "Save Template" button
- Saves current cart quantities (all items with qty > 0) to localStorage
- Overwrites existing template with same name

### Load Template:
- Template list dropdown showing all saved templates
- Click to load: replaces current cart with template's quantities
- Delete button per template

### Template Storage:
- Key: `lpb_order_templates`
- Format: `{ name, cart: Record<code, {bottles, cases}>, savedAt }`

---

## 15. Order History (localStorage)

Track previously created orders locally for quick reference and reload.

### Save to History:
- "Save as Order" button prompts for order name
- Creates a real named order via API
- Copies all tracked items into the order
- Syncs cart quantities to the order items
- Saves entry to localStorage history (max 50 entries)
- Navigates to the new order detail page

### History Entry Fields:
- Order ID (links to real DB order)
- Name, cart snapshot, total cost, item count, timestamp

### Load from History:
- History panel shows past orders
- Click to reload cart quantities from a past order

---

## 16. Inline Editable Notes (Tracking List)

Each tracked item has an inline note field directly in the table row.

### Behavior:
- Text input, initially transparent/borderless (looks like plain text)
- On hover: border appears
- On focus: white background, full editing
- On blur: auto-saves if changed
- "Saved" flash animation confirms save (green text, 1.5s fade)
- Placeholder: "Add note..."

---

## 17. Inline Target Price (Tracking List)

Each tracked item has an inline target price field in the table row.

### Behavior:
- Small numeric input, right-aligned, initially transparent
- On hover/focus: border appears, editable
- On blur: auto-saves if changed
- "Saved" flash animation on save
- Triggers alert when actual price drops to or below target
- Supports both target case price and target bottle price

---

## 18. Price Trend Indicator

Visual indicator shown per item on the tracking list and other views.

### Display:
- Arrow: down (green), up (red), flat (gray), "new" (for first-time items)
- Percentage: "+2.3%" or "-4.1%"
- Previous price: "was $X.XX" in small text below
- 12-month badges: "12m low" (green) or "12m high" (red)
- All in a compact stacked layout per table cell

---

## 19. CSV Export (Tracking List)

Client-side CSV export of the current order list with cart quantities.

### Columns:
- SKU, Description, Size, Pack, Category, Brand
- Case Price, RIP Save, After RIP Case, GP% w/RIP
- Buy Signal, Bottles, Cases, Line Total, Note

### Behavior:
- Only includes items with qty > 0
- Grand total row appended at bottom
- Proper CSV quoting (handles commas and quotes in descriptions)
- Downloads as `order-YYYY-MM-DD.csv`
- Browser-side Blob + download link (no server call)

---

## 20. Add-to-Order Button (Per Row)

Inline button in tracking list table rows to add an item (with quantities) to a named order.

### Flow:
1. Click "Add to Order" arrow button
2. Dropdown appears listing all draft orders (name + division badge)
3. Includes "New Order" option at bottom
4. Click existing order: adds item with current cart qty, shows success flash with link to order
5. Click "New Order": shows inline name input, creates order via API, then adds item
6. Flash message with order name + clickable link to navigate to order detail

### Visual Feedback:
- "Added!" flash with checkmark (green, 3s duration)
- Flash includes order name as a clickable link
- Dropdown auto-closes on success

---

## 21. Group by Category Toggle (Tracking List)

Toggle to group tracked items by their category.

### Behavior:
- When ON: items grouped under category headers
- Category headers show: category name + item count
- Within each group: same sortable table layout
- When OFF: flat list (default)

---

## 22. Collapsible Sidebar Navigation

### Features:
- Expand/collapse toggle (desktop only, hidden on mobile)
- Collapsed state: icons only, labels hidden, narrow width (64px)
- Expanded state: icons + labels, full width (240px)
- Collapsed state: icon tooltips show label on hover
- State persisted to localStorage (`lpb_sidebar_collapsed`)
- Smooth transition animation (200ms)
- Distributor selector hidden when collapsed

### Mobile:
- Sidebar hidden by default, slides in from left
- Hamburger menu button in top bar
- Semi-transparent backdrop overlay
- Closes on route change, backdrop click, or close button

### Navigation Structure:
- Main nav: Dashboard, Catalog, RIPs, Closeouts, Combos, Specials, Orders, Tracked, Analytics, Decisions, Alerts
- Bottom nav (separated): Sales Reps, Settings
- Active route highlighted with accent color
- SVG icons per nav item

---

## 23. Login / Auth Flow

### Login Page:
- Username + password form
- Token returned and stored in localStorage
- Auto-redirect to dashboard on success
- Protected routes redirect to login if no token

### Session Persistence:
- Token persisted in localStorage (`lpb_auth_token`)
- Username persisted separately (`lpb_auth_user`)
- All API calls include `Authorization: Bearer <token>` header
- Logout clears both storage keys

---

## 24. Distributor State Persistence

The selected distributor/source persists across page navigations and sessions.

### Implementation:
- Stored in localStorage (`lpb_distributor`)
- React context provider wraps entire app
- All child components access via `useDistributor()` hook
- Changing distributor refreshes all data queries on current page
- Default: first distributor in list

---

## 25. Responsive Layout

### Breakpoints:
- Mobile (<1024px): full-width content, hamburger sidebar, stacked layouts
- Desktop (>=1024px): persistent sidebar, multi-column grids

### Responsive Elements:
- Sidebar: slide-in on mobile, persistent on desktop
- Tables: horizontal scroll on mobile, hidden columns below breakpoints (`hideBelow: "sm" | "md" | "lg"` per column)
- Grids: 1-col mobile → 2-4 col desktop (KPI cards, price cards)
- Padding/spacing: tighter on mobile
- Top bar: shows app branding on mobile (hidden on desktop when sidebar visible)
