# Application Features

Generic feature list extracted from a working implementation. All features are described without domain-specific hardcoding so they can be adapted to any data source (Excel, CSV, API, etc.).

---

## 1. Data Ingestion

### 1.1 Multi-Source Import
- Support multiple data sources (suppliers/vendors/providers) each with their own import template
- Source registry with slug, display name, region, active/inactive toggle

### 1.2 Edition-Based Versioning
- Each import creates a versioned "edition" (source + year + month)
- Content hash deduplication — identical re-uploads reuse existing edition
- Idempotent re-import by (source, year, month) — re-importing same period updates in place

### 1.3 Import Pipeline (6-Stage)
1. **Load & Status Tracking** — create run record, flip status to "running"
2. **Parse/Extract** — source-specific parser extracts structured rows from raw file (PDF, Excel, CSV)
3. **Normalize** — map raw category strings to canonical categories via alias table; derive brand/grouping from description
4. **Upsert Core Records** — upsert items by (source, code); delete + reinsert edition-specific data (idempotent)
5. **Upsert Subsidiary Data + Fuzzy Linking** — insert related data (offers, promotions, bundles); fuzzy-match unlinked records to catalog items
6. **Finalize** — refresh materialized views, evaluate alert rules, mark run complete

### 1.4 Import Run Management
- Track each import attempt: pending / running / completed / failed
- Per-section row counts stored as JSON
- Error capture (exception type + message) on failure
- Retry failed/stuck runs (reset to pending, re-enqueue)
- Run history with source context, timestamps, row counts

### 1.5 Local Parse + Remote Push Architecture
- Parse large files locally (unlimited RAM), POST structured JSON to server
- Server handles only DB upserts — no OOM risk from large files
- CLI tool with dry-run mode, polling, source selection

### 1.6 Template-Based Parsers
- Each source has its own parser template (handles layout differences)
- OCR/text-quality corrections (de-spacing, fragment merging)
- Column/field detection by position (configurable anchors)
- Context carrying across rows/pages (current group, sub-group, category)

---

## 2. Catalog / Item Browser

### 2.1 Full Product Catalog
- Browse all items across sources or filtered by single source
- Fields: code, description, size/unit, pack/quantity, category, brand/group, prices

### 2.2 Faceted Filtering
- Category tree (hierarchical)
- Brand/group multi-select with search
- Size/unit filter
- Division/zone filter (delivery zones, regions, tags)
- Price range slider (min/max)
- Boolean toggles (e.g., has discount, has promotion)

### 2.3 Search
- Full-text search across product code, description, brand

### 2.4 Sorting
- Sort by: name, price ascending, price descending, biggest price movers (absolute % change)
- Sortable table headers (click to toggle asc/desc) on all pages

### 2.5 Pagination
- Configurable page size (25 / 50 / 100 / 200)
- Offset-based pagination

### 2.6 Edition Browser
- List all editions across sources
- Mark current (latest non-future) edition per source

### 2.7 Category & Brand Endpoints
- List categories with item counts per source
- List brands with item counts, substring search

---

## 3. Item Detail

### 3.1 Full Item View
- All current fields: code, description, size, pack, category, brand, prices
- Previous price + delta percentage
- Action buttons: add/remove from tracking list, add to named order

### 3.2 Price History
- Per-edition data points: prices, best discount, effective cost
- Summary stats: 12-month min, max, average, current
- Price trend classification: rising / falling / stable
- Line chart visualization (price + effective price over time)
- Edition-by-edition breakdown table with change $ and change %

### 3.3 Discount/Offer Tiers
- All available discount tiers for current edition
- Per-tier: label, quantity threshold, savings amount, price after discount

### 3.4 Active Promotions
- List of currently active time-bounded promotions
- Date range, special price, days remaining

### 3.5 User Notes
- Add/edit/delete notes per item
- Soft-delete with audit trail
- Chronological display with timestamps

### 3.6 User Ratings
- Thumbs up/down per item per edition
- Aggregate counts displayed

---

## 4. Tracking List (Watchlist / Order List)

### 4.1 Default Tracking List
- One default list per user
- Add/remove items
- Persists across sessions

### 4.2 Enriched View with Buy Intelligence
- For each tracked item, compute server-side:
  - 12-month price low / high / average
  - Months at current price (stability indicator)
  - At 12-month low / high flags
  - Had discount in previous edition flag
  - Price direction: rising / falling / stable
  - **Buy signal**: BUY_NOW / GOOD_BUY / HOLD / DEFER
  - **Buy reasons**: list of plain-English explanations
  - All discount tiers + effective price after best discount
  - Discount percentage

### 4.3 Target Price Alerts
- Set target price per item
- Alert fires when price drops to or below target

### 4.4 Filters & Sort
- Search, category filter, sort options
- Source filter

---

## 5. Named Orders

### 5.1 Order CRUD
- Create named orders (draft)
- Update name, notes, division/zone
- Delete draft orders
- List orders with status, division, item count, total value

### 5.2 Order Workflow
- Status lifecycle: draft -> submitted
- Submit (finalize) action
- Archive/restore (hide/unhide)
- Clone order as new draft
- Copy all tracked items into order

### 5.3 Order Line Items
- Add / update / remove items
- Per-item: quantity (cases/units), selected discount tier
- Quantity fields: primary unit + secondary unit (e.g., cases + bottles)

### 5.4 Payment Analysis
- **Invoice total**: sum of (price x quantity) for all line items
- **Rebate total**: sum of applicable discount savings (with configurable cap)
- **Effective total**: invoice minus rebate
- Breakdown by category
- Per-line: line invoice, line rebate, line effective

### 5.5 Per-Line Recommendations
- Closeout/clearance action: "buy before discontinued"
- Defer warning: "upcoming promotion has better price in N days"
- Tier optimizer: "add N more units to reach next discount tier, save $X more"

### 5.6 Export
- Excel (XLSX) export with auto-column widths, formatted headers, payment summary
- Optional division/zone filter on export

### 5.7 Email Order
- Generate pre-filled email (mailto) with line items
- Recipient auto-selected from sales rep table by division

---

## 6. Dashboard

### 6.1 KPI Cards
- Total items, active discounts (with total savings pool), clearance items, price drops count, price increases count, tracked items count (with buy-now signal count)

### 6.2 Price Movement Panels
- Biggest price drops (top N)
- Biggest price increases (top N)
- Tracked-item movers (changes on items you're watching)

### 6.3 Top Opportunities
- Top discount opportunities: tier badge, savings amount, effective discount %
- Clearance deals: original vs best price, days on list

### 6.4 Category Breakdown
- Discounts by category (savings pool per category)
- Item counts per category

### 6.5 Recent Alerts
- Latest alert events with rule type, item, description, timestamp

### 6.6 Quick Navigation
- Links to catalog, discounts, clearance, tracking list

---

## 7. Discount / Offer Views

### 7.1 Discount Ranker
- All items with active discounts sorted by savings (highest yield first)
- Filters: source, category, min discount %, max quantity threshold
- Stability flag: same discount appeared in prior edition (reliable vs new)

### 7.2 Clearance / Inventory Reduction
- Items being discontinued or cleared out
- Original price vs best price, savings per unit
- Days on clearance list (estimated from first appearance)
- Min savings % filter

### 7.3 Bundles / Combos
- Bundle deals with component item breakdown
- Subcategory and search filters

### 7.4 Time-Bounded Promotions (Specials)
- Active promotions sorted by days remaining (most urgent first)
- Shows: item, special price, date range, days remaining
- Visual urgency indicator for expiring soon (<7 days)

---

## 8. Analytics

### 8.1 Single-Source Analytics Tabs
- Price drops / Price increases (biggest movers)
- New discounts / Lost discounts (appeared/disappeared this edition)
- Best value (lowest effective cost after discount)
- Clearance + Discount overlap (items with both)
- Category trends (avg price change by category, bar chart)
- New items / Discontinued items
- Tracked-item movers
- Buy now / Defer verdicts
- Low-confidence match review queue

### 8.2 Cross-Source Analytics Tabs
- Category coverage comparison (side-by-side)
- Discount coverage comparison (which source has more/better discounts per category)
- Brand availability comparison (available from one source but not the other)
- Price comparison (for linked items: source A vs source B price delta)

### 8.3 Shared Analytics Features
- Sortable tables on all tabs
- Inline add-to-tracking-list button
- Right-click context menu on any row
- Toggle: show only tracked items
- Configurable row limit

---

## 9. Decision Intelligence

### 9.1 Buy Sheet
- Comprehensive "what to buy this period" report
- Sections ranked by urgency:
  - **Last Chance**: clearance items (now or never)
  - **Strong Buy**: at 12-month low AND has discount
  - **Buy Now**: new discount this edition OR significant price drop
  - **Consider**: stable discount OR small price drop
  - **Defer**: at 12-month high OR price rising
  - **New Opportunities**: new items appearing for first time with discounts
- Market direction summary: prices falling / rising / stable
- Totals: new discounts gained, discounts lost, potential savings pool

### 9.2 Order Scorecard
- Grade each order 0-100 (A/B/C/D/F)
- 4 scoring metrics:
  - **Discount capture rate**: what % of available discounts are being utilized
  - **Category diversity**: spread across categories
  - **Clearance urgency**: are clearance items included
  - **Price timing**: are items being ordered when prices are favorable
- Actionable recommendations list

### 9.3 Missed Opportunities
- Items with active discounts / clearances / expiring promotions NOT in tracking list
- Summary KPIs: total opportunities, total savings missed, clearance count, expiring promotions
- Breakdown by opportunity type (bar chart)
- Filterable table with urgency indicators

### 9.4 AI Verdict (per item)
- LLM-powered buy/defer recommendation with confidence score and rationale
- Feature vector: current price, previous price, % change, discount tiers, stability, clearance status, active promotions with days to expiry
- Cached per (item, edition) — no redundant API calls
- Heuristic fallback when AI unavailable
- Force-refresh option

---

## 10. Alert Engine

### 10.1 Alert Rules (7 types)
| Rule | Trigger | Priority |
|------|---------|----------|
| New clearance | Item entered clearance list this edition | Highest |
| Target price hit | Price dropped to/below user's target | Very High |
| Promotion expiring soon | Active promotion ends within N days | High |
| Discount changed | Discount tier or amount changed vs prior edition | High |
| New discount | Discount appears for first time on an item | Medium-High |
| Price drop | Price decreased by >= N% | Medium |
| Price increase | Price increased by >= N% | Lower |

### 10.2 Alert Configuration
- Per-rule enable/disable
- Configurable thresholds (% for price changes, days for expiry)
- Channel selection: email / SMS / in-app

### 10.3 Alert Events
- Ranked by priority score
- Top N written per tenant per ingest
- Payload: item code, description, delta values
- Read/unread tracking
- Unread count badge in navigation

---

## 11. Cross-Source Item Linking

### 11.1 Product Linking
- Link equivalent items across different sources (e.g., same product from two suppliers)
- Fields: source A code, source B code, confidence, canonical description, brand, category
- Enables cross-source price comparison views

### 11.2 Fuzzy Matching
- Automatic fuzzy matching during import for subsidiary data (promotions, clearances)
- Configurable confidence threshold (e.g., 0.85)
- Matches above threshold: auto-linked
- Matches below threshold: queued for manual review

### 11.3 Low-Confidence Review Queue
- Items below confidence threshold presented for human review
- Shows: raw description, matched code, confidence score

---

## 12. Authentication & Multi-Tenancy

### 12.1 Authentication
- Bearer token authentication on all protected routes
- SSO-ready architecture (tenant/user/role models)

### 12.2 Multi-Tenancy
- Tenant model with org ID and plan
- User model with role: owner / admin / member
- Tenant-scoped data isolation

---

## 13. Sales Rep Management

### 13.1 Rep CRUD
- Add / edit / delete sales reps
- Fields: name, division/zone, email, phone
- Used for auto-populating order email recipients

---

## 14. Audit & Compliance

### 14.1 Audit Log
- Append-only log of all tracking list and notes writes
- Actions: insert / update / delete / soft_delete / restore
- Old values / new values JSON diff

### 14.2 Configurable Business Rules
- Rebate/discount caps (e.g., $1,000 annual cap)
- Quantity limits (e.g., 50-unit max per discount tier)
- Enforced at data model level, not just UI

---

## 15. Materialized Views / Computed Data

### 15.1 Price Change View
- Pre-computed price deltas: previous vs current edition
- Fields: case cost %, bottle cost %, absolute delta
- Refreshed after every successful import
- Powers: dashboard movers, catalog sort, alert engine

---

## 16. Frontend Architecture

### 16.1 App Shell
- Collapsible sidebar navigation (state persisted to localStorage)
- Source selector (pill buttons for each source + "All")
- Global context provider for selected source
- Global item detail popup (click any item anywhere)
- Responsive mobile layout with hamburger menu
- Protected routes (auth required)

### 16.2 Reusable Components
- **SortableTable**: clickable column headers with asc/desc arrows, used across all pages
- **FavoriteButton**: inline add-to-tracking-list from any table row
- **ContextMenu**: right-click any row for quick actions
- **PriceChart**: line chart (Recharts) for price history
- **TrackedOnlyToggle**: filter any view to show only tracked items
- **RowLimitSelect**: configurable page size

### 16.3 Pages
| Page | Path | Purpose |
|------|------|---------|
| Dashboard | `/` | KPIs, movers, opportunities, alerts |
| Catalog | `/catalog` | Browse/search/filter all items |
| Item Detail | `/catalog/:code` | Full item view with history, offers, notes |
| Discounts | `/rips` | Discount ranker by savings yield |
| Clearance | `/closeouts` | Clearance items with urgency |
| Bundles | `/combos` | Bundle deals with components |
| Promotions | `/specials` | Time-bounded specials by urgency |
| Orders | `/orders` | Named order list |
| Order Detail | `/orders/:id` | Order with payment analysis + recommendations |
| Tracking List | `/watchlist` | Enriched tracked items with buy signals |
| Analytics | `/analytics` | 12+ analysis tabs (single + cross-source) |
| Decisions | `/decisions` | Buy sheet, scorecard, missed opportunities |
| Alerts | `/alerts` | Alert event feed |
| Admin Import | `/admin/ingest` | Upload, run history, retry |
| Sales Reps | `/sales-reps` | Rep management |
| Settings | `/settings` | User/tenant config |
