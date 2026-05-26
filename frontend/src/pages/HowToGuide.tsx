import type { ReactNode } from 'react';
import {
  BookOpen, Rocket, Store, LayoutDashboard, Package, Sparkles, Combine,
  BadgeDollarSign, Star, StickyNote, ShoppingCart, ClipboardList, Bell,
  Settings, UserCog, MousePointerClick, Globe, MessageCircle, BookMarked,
  Shield, Lightbulb, ListTodo,
} from 'lucide-react';
import './HowToGuide.css';

// In-page table of contents. Each entry maps to a section id below.
const TOC: { id: string; label: string; sub?: boolean }[] = [
  { id: 'welcome', label: 'Welcome' },
  { id: 'terms', label: 'Words you will see everywhere' },
  { id: 'account', label: 'Create your account' },
  { id: 'store', label: 'Add your store (first run)' },
  { id: 'navigate', label: 'Finding your way around' },
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'catalog', label: 'Catalog' },
  { id: 'quickview', label: 'Product details popup', sub: true },
  { id: 'newitems', label: 'New Items' },
  { id: 'combos', label: 'Combos' },
  { id: 'ripproducts', label: 'RIP Products' },
  { id: 'favorites', label: 'Favorites (watchlist)' },
  { id: 'todo', label: 'To-Do board' },
  { id: 'notes', label: 'Notes' },
  { id: 'cart', label: 'Cart' },
  { id: 'lists', label: 'Lists' },
  { id: 'orders', label: 'Orders (submitted)' },
  { id: 'alerts', label: 'Alerts' },
  { id: 'rightclick', label: 'Right-click menu', sub: true },
  { id: 'websearch', label: 'Search the web popup', sub: true },
  { id: 'configuration', label: 'Configuration' },
  { id: 'profile', label: 'Profile & password' },
  { id: 'admin', label: 'Admin-only tools' },
  { id: 'help', label: 'Feedback, sharing, cookies' },
  { id: 'glossary', label: 'Full glossary' },
];

function Section({ id, icon, title, children }: { id: string; icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <section id={id} className="htg-section">
      <h2><span className="ic">{icon}</span>{title}</h2>
      {children}
    </section>
  );
}

function Path({ children }: { children: ReactNode }) {
  return <div className="htg-pathline">Where to find it: <span className="where">{children}</span></div>;
}

function Callout({ children }: { children: ReactNode }) {
  return <div className="htg-callout"><span className="ic"><Lightbulb size={16} /></span><div>{children}</div></div>;
}

function Cols({ items }: { items: string[] }) {
  return <div className="htg-cols">{items.map(c => <span key={c} className="htg-col-chip">{c}</span>)}</div>;
}

function Term({ name, children }: { name: string; children: ReactNode }) {
  return <div className="htg-term"><div className="t">{name}</div><div className="d">{children}</div></div>;
}

function Shot({ src, alt }: { src: string; alt: string }) {
  return (
    <figure className="htg-shot">
      <a href={src} target="_blank" rel="noreferrer" title="Open full size">
        <img src={src} alt={alt} loading="lazy" />
      </a>
      <figcaption>{alt} <span style={{ opacity: 0.7 }}>(click to enlarge)</span></figcaption>
    </figure>
  );
}

export default function HowToGuide() {
  return (
    <div className="page htg">
      <h2>How To Guide</h2>
      <p className="htg-lead">
        A complete, plain-English walkthrough of CELR.ai, screen by screen. If you have never used the app
        before, read it top to bottom once. After that, use the table of contents to jump to any feature.
      </p>

      <div className="htg-shell">
        <nav className="htg-toc">
          <div className="htg-toc-title">On this page</div>
          {TOC.map(t => <a key={t.id} href={`#${t.id}`} className={t.sub ? 'sub' : ''}>{t.label}</a>)}
        </nav>

        <div className="htg-content">

          <Section id="welcome" icon={<BookOpen size={20} />} title="Welcome">
            <p>
              CELR.ai reads the monthly price books (the "CPL", or Current Price List) that New Jersey
              wholesalers file, and turns hundreds of pages into one searchable screen. It shows you the real
              cost of every product after discounts and rebates, which deals are about to expire, what changed
              since last month, and where you can save by buying from a different distributor.
            </p>
            <p>You will mostly do four things in the app:</p>
            <ul>
              <li><strong>Find deals</strong> worth acting on (Dashboard, Catalog, Combos, RIP Products).</li>
              <li><strong>Save products</strong> you care about to your Favorites and set a target price.</li>
              <li><strong>Build orders</strong> for each distributor and see exactly what you will pay and earn back.</li>
              <li><strong>Stay alerted</strong> when prices drop, deals end, or a target price is hit.</li>
            </ul>
            <Callout>
              Nothing you do here places a real order with a wholesaler. CELR.ai is a planning and analysis
              tool. You still order through your normal rep or portal. Always confirm a price with the
              wholesaler before you buy.
            </Callout>
          </Section>

          <Section id="terms" icon={<BookMarked size={20} />} title="Words you will see everywhere">
            <p className="muted">Five minutes here will make every other screen make sense.</p>
            <div className="htg-terms">
              <Term name="CPL (Current Price List)">The monthly price book each wholesaler files with the state. CELR.ai loads all of them so you do not have to read them.</Term>
              <Term name="Edition">One month's version of a wholesaler's price list (for example "May 2026"). The app compares editions to show what changed.</Term>
              <Term name="Distributor / Wholesaler">The supplier you buy from (Allied, Fedway, Opici, Highgrade, Peerless, and others). Also called a "division" in some places.</Term>
              <Term name="Frontline price (or List / Case price)">The plain list price the wholesaler charges, before any discount.</Term>
              <Term name="Discount tier">"Buy this many, pay this much less." A flat amount off per case once you reach a quantity (for example, buy 10 cases, take $2 off each).</Term>
              <Term name="RIP">A rebate the wholesaler pays on volume. Buy a set number of cases or bottles and get money back per case. RIPs often stack on top of a discount.</Term>
              <Term name="Effective price">What the product actually costs you after the best discount and RIP are applied. This is the number that matters when you compare deals.</Term>
              <Term name="Combo / Bundle">A pack of several products sold together for one price, usually cheaper than buying each item on its own.</Term>
              <Term name="Closeout / Clearance">A product the wholesaler is discontinuing and selling off, often at a steep discount.</Term>
              <Term name="GP% (Gross Profit %)">Your margin: the gap between your shelf (retail) price and your cost, as a percentage. Higher is better.</Term>
              <Term name="ROI%">For a rebate or discount, how much you get back relative to what you spend to unlock it.</Term>
              <Term name="Better Price">A badge telling you whether a product is cheaper this month or next month, so you know whether to buy now or wait.</Term>
              <Term name="Target price">The price you would be happy to pay. Set it on a favorite and the app alerts you when the market hits it.</Term>
              <Term name="Buy signal">A plain-language recommendation (Strong Buy, Buy Now, Good Buy, Hold, Defer, Last Chance) based on price trends and savings.</Term>
            </div>
          </Section>

          <Section id="account" icon={<Rocket size={20} />} title="Create your account">
            <Path>The sign-in screen, then "Create an account"</Path>
            <p>To sign up you provide:</p>
            <ul>
              <li><strong>Your name</strong> (recommended).</li>
              <li><strong>Email</strong> (required, and must be unique).</li>
              <li><strong>Phone number</strong> (required). Type digits in any common format, for example (201) 555-0100.</li>
              <li><strong>Password</strong> (required, at least 8 characters).</li>
              <li><strong>The Terms of Service and Privacy Policy checkbox</strong> (required). The "Create account" button stays disabled until you tick it. The two links open in a new tab so you can read them.</li>
            </ul>
            <p>Then:</p>
            <ol className="htg-steps">
              <li>Click <strong>Create account</strong>. We email you an activation link.</li>
              <li>Open the email and click the link (check your spam folder if it is not there). If it has not arrived, use <strong>Resend activation email</strong> on the popup or sign-in screen.</li>
              <li>Once activated, sign in with your email and password.</li>
            </ol>
            <p className="muted">
              Forgot your password? Use <strong>Forgot password?</strong> on the sign-in screen. We email a reset
              link; open it, set a new password (8+ characters), and sign in again.
            </p>
          </Section>

          <Section id="store" icon={<Store size={20} />} title="Add your store (first run)">
            <p>
              The first time you sign in, you must add at least one store before you can use the app. Type your
              store name and pick it from the address suggestions to auto-fill the address. You can also fill the
              fields in by hand (street, city, state, ZIP, phone, license number, notes).
            </p>
            <Callout>
              Add every store you own. The more stores you add, the more specific your pricing and deal analysis
              becomes. You can add, edit, or remove stores later from <strong>Configuration</strong> or <strong>Profile</strong>.
            </Callout>
          </Section>

          <Section id="navigate" icon={<LayoutDashboard size={20} />} title="Finding your way around">
            <p>The left menu is grouped into labelled sections of related screens:</p>
            <h3>Overview</h3>
            <ul>
              <li><strong>Dashboard</strong>: your daily overview.</li>
              <li><strong>Alerts</strong>: price and deal notifications (a red badge shows unread).</li>
            </ul>
            <h3>Find deals</h3>
            <ul>
              <li><strong>Catalog</strong>: every product, searchable and filterable.</li>
              <li><strong>New Items</strong>: products that just appeared this month.</li>
              <li><strong>Combos</strong>: bundle deals.</li>
              <li><strong>RIP Products</strong>: products with rebate offers.</li>
            </ul>
            <h3>My work</h3>
            <ul>
              <li><strong>Favorites</strong>: products you have starred (your watchlist).</li>
              <li><strong>To-Do</strong>: your task board (right-click any product to add one).</li>
              <li><strong>Notes</strong>: every note you have written, in one place.</li>
              <li><strong>Lists</strong>: reusable named product lists you build up and move into the cart.</li>
              <li><strong>Orders</strong>: your submitted orders (edit, cancel, or re-share them).</li>
            </ul>
            <p>
              And always in the <strong>top-right corner</strong>, the <strong>Cart</strong> icon (with a live
              item count) holds the products you are about to order, grouped by sales rep.
            </p>
            <h3>Setup &amp; Help</h3>
            <ul>
              <li><strong>Configuration</strong>: your stores, sales reps, and divisions.</li>
              <li><strong>How To Guide</strong>: this page.</li>
            </ul>
            <p>At the top and bottom of the menu:</p>
            <ul>
              <li><strong>Light / dark theme</strong>: the sun/moon button switches the colour scheme. Your choice is remembered.</li>
              <li><strong>Collapse / hide</strong>: shrink the menu to icons, or hide it entirely, to get more room. On a phone, tap the menu button to open it.</li>
              <li><strong>Share via WhatsApp</strong>: opens WhatsApp with a ready-made message so you can tell another owner about the app.</li>
              <li><strong>Profile</strong>: your account and password.</li>
              <li><strong>Log out</strong>.</li>
            </ul>
          </Section>

          <Section id="dashboard" icon={<LayoutDashboard size={20} />} title="Dashboard">
            <Path>The home screen (the first menu item)</Path>
            <Shot src="/guide/01-dashboard.png" alt="The Dashboard: key metrics across the top, your workspace and deal tiles below." />
            <p>
              The Dashboard is a summary. At the very top you can filter the whole page to one distributor with
              the distributor buttons.
            </p>
            <h3>Key Metrics (the six cards at the top)</h3>
            <p>Each card is a quick count and is clickable, taking you to the matching screen:</p>
            <ul>
              <li><strong>Total Items</strong> opens the Catalog. <strong>Active Discounts</strong> shows the total savings pool and opens Discounts. <strong>Clearance Items</strong> opens the closeout list.</li>
              <li><strong>Price Drops</strong> and <strong>Price Increases</strong> open Analytics. <strong>Active RIPs</strong> opens RIP Products.</li>
            </ul>
            <h3>My Workspace (your own data)</h3>
            <p>Tiles for your <strong>Favorites</strong>, your <strong>orders in progress</strong>, your <strong>submitted orders</strong>, and your <strong>Notes</strong>. Click a tile to open a list; click "Open ..." inside to jump to the full screen.</p>
            <h3>Insights &amp; Opportunities (the deal tiles)</h3>
            <p>Each tile shows a count and a 3-row preview. Click it to open a full table with its own search, filters, and export. The tiles:</p>
            <ul>
              <li><strong>New Items</strong>: products newly introduced, with the month they appeared.</li>
              <li><strong>Time-Sensitive Deals</strong>: deals with an end date, with day counters (red = expiring within 3 days). Filter by "Next 3 days", "This week", and so on.</li>
              <li><strong>Biggest Price Drops</strong>: the largest month-over-month reductions.</li>
              <li><strong>Top Discount Opportunities</strong>: the biggest savings per case right now, with a "buy now vs next month" hint.</li>
              <li><strong>Price Changes (Month over Month)</strong>: what is going up or down next month. Filter by Drops or Hikes.</li>
              <li><strong>Allied / Fedway / OPICI Cheaper</strong>: the same product (matched by barcode) priced at two distributors, showing who is cheaper and by how much.</li>
              <li><strong>Allied / Fedway Exclusive</strong>: products one distributor carries that the other does not.</li>
            </ul>
          </Section>

          <Section id="catalog" icon={<Package size={20} />} title="Catalog">
            <Path>Catalog in the left menu</Path>
            <p>The Catalog is the full product list and your main workspace for finding and ordering products.</p>
            <Shot src="/guide/02-catalog.png" alt="The Catalog: search and distributor buttons on top, the filter panel on the left, products with their discount and RIP tiers below each row." />
            <h3>Searching and filtering</h3>
            <ul>
              <li><strong>Search box</strong>: type a product name or a barcode (UPC). The count next to it shows how many products match.</li>
              <li><strong>Distributor buttons</strong> (top right): limit to one wholesaler or show all.</li>
              <li><strong>Show / Hide Filters</strong>: opens the filter panel on the left, where you can filter by <strong>Deals</strong> (has a RIP, has a discount, or <strong>In combo</strong> for bundle products), <strong>Distributors</strong>, <strong>Brand</strong>, <strong>Price range</strong>, <strong>Category</strong>, and <strong>Size</strong> (listed smallest to largest). Each option shows a count.</li>
              <li><strong>Tracked only</strong>: show just the products on your Favorites list.</li>
              <li><strong>Rows</strong>: how many products per page. <strong>Clear all</strong> removes every filter.</li>
            </ul>
            <h3>Reading a product row</h3>
            <p>Each row shows these columns:</p>
            <Cols items={['Favorite star + menu', 'Product (name + barcode)', 'Distributor', 'Type', 'Size', 'Case / Btl price', 'Tier', 'Save (cs / btl)', 'Effective (cs / btl)', 'ROI / GP%', 'Better Price', 'Qty', 'Order']} />
            <ul>
              <li><strong>Case / Btl</strong> is the list price per case and per bottle. <strong>Effective</strong> is what you actually pay after the best deal.</li>
              <li><strong>Tier</strong> says how many discount/RIP tiers exist. The tier detail rows appear indented beneath the product, each showing "Buy N = $X", the saving, the price after, and ROI. A tier turns green once your quantity reaches it.</li>
              <li><strong>Better Price</strong> tells you if this month or next month is cheaper.</li>
              <li>Each row leads with the <strong>product image</strong>. A <strong>dup UPC</strong> tag warns when a barcode is shared by more than one product.</li>
              <li>A <strong>🎁 In combo</strong> link means the product is part of a bundle; click it to open the combo in a popup window.</li>
            </ul>
            <h3>Adding to the cart</h3>
            <ul>
              <li>Use the <strong>Qty</strong> steppers to set cases and/or bottles, then click the <strong>+</strong> (Add to cart) button in the Order column. The product drops into your <strong>Cart</strong> (top-right), grouped by its sales rep.</li>
              <li>Click the <strong>star</strong> to save a product to Favorites, or right-click for more (Add to Cart, Add to List). Click anywhere else on the row to open the product details popup.</li>
            </ul>
          </Section>

          <Section id="quickview" icon={<Package size={18} />} title="The product details popup">
            <p>Click any product row (almost anywhere in the app) to open its details. This popup is the deepest view of a single product and shows:</p>
            <Shot src="/guide/13-product-details.png" alt="The product details popup: price summary, a list to discount to RIP to you-pay breakdown chart, and the discount and RIP tiers." />
            <ul>
              <li><strong>A price summary</strong>: case cost, bottle cost, best discount, and effective cost. If you opened it from a cross-distributor comparison, it shows both distributors side by side and marks the cheaper one.</li>
              <li><strong>A price breakdown</strong> chart: list price, minus discount, minus RIP, equals what you pay.</li>
              <li><strong>Discount tiers</strong> and <strong>RIP tiers</strong> tables: every "buy N, save $X" level with the price after and ROI.</li>
              <li><strong>All editions breakdown</strong>: the product's price every month, sortable by clicking a column.</li>
              <li><strong>A price history chart</strong>: the effective price over time, with the trend and best month.</li>
              <li><strong>Notes</strong>: read, add, or delete your private notes on this product.</li>
              <li>The <strong>star</strong> at the top adds or removes it from Favorites.</li>
            </ul>
          </Section>

          <Section id="newitems" icon={<Sparkles size={20} />} title="New Items">
            <Path>New Items in the left menu</Path>
            <Shot src="/guide/03-new-items.png" alt="New Items: the catalog filtered to newly introduced products, with month buttons and an Introduced column." />
            <p>
              This is the Catalog filtered to products that are genuinely new this month, meaning their barcode
              was not in the wholesaler's previous price list. It has all the same filters, deal details, and
              ordering tools as the Catalog, plus:
            </p>
            <ul>
              <li>An <strong>Introduced</strong> column showing the month a product first appeared.</li>
              <li><strong>Month buttons</strong> at the top to show only items introduced in a given month (each shows a count).</li>
            </ul>
          </Section>

          <Section id="combos" icon={<Combine size={20} />} title="Combos">
            <Path>Combos in the left menu</Path>
            <Shot src="/guide/04-combos.png" alt="Combos: bundle deals with savings, percentage off, validity, and an outlook for next month." />
            <p>Combos are bundles of products sold together for one price. Use this screen to spot bundles that save more than buying the items separately.</p>
            <ul>
              <li>Filter by distributor, minimum savings, and whether the bundle is valid this month, next month, or both. The cards at the top show total combos, average savings, and the biggest saving.</li>
              <li>The table shows the bundle, its price, the regular value, the saving, the % off, and an <strong>Outlook</strong> (for example "ends this month" or "better deal next month").</li>
              <li>Click a bundle to open its breakdown: every item in the pack, the regular price of each, the combo price, and what you save. From there you can <strong>Add bundle to Order</strong> or <strong>Add bundle to Order Analysis</strong>.</li>
            </ul>
            <Callout>If a bundle shows a warning icon, the underlying discount figure looks unusual (very high or negative). Double-check it against the wholesaler before relying on it.</Callout>
          </Section>

          <Section id="ripproducts" icon={<BadgeDollarSign size={20} />} title="RIP Products">
            <Path>RIP Products in the left menu</Path>
            <Shot src="/guide/05-rip-products.png" alt="RIP Products: this month vs next month side by side, with the rebate tier, saving, effective price, and a Better badge." />
            <p>Every product that carries a rebate (RIP) or discount, with this month and next month side by side so you can time your buy.</p>
            <ul>
              <li>Filter by distributor, incentive type (discount or RIP), category, minimum saving per case, minimum GP%, tier unit (cases or bottles), and "new next month".</li>
              <li>For each product you see the <strong>Case</strong> price, the <strong>RIP</strong> tier, the <strong>Save</strong> per case, and the <strong>Effective</strong> price, for both the current and next month, plus a <strong>Better</strong> badge (This Month, Next Month, Same, Ends, or New Next).</li>
              <li>Star a product to track it, or click the row for full details.</li>
            </ul>
          </Section>

          <Section id="favorites" icon={<Star size={20} />} title="Favorites (your watchlist)">
            <Path>Favorites in the left menu</Path>
            <Shot src="/guide/06-favorites.png" alt="Favorites: your starred products with buy signals, tiers, target price, notes, and a running cart total." />
            <p>Everything you star lands here. It is built for tracking prices and turning a shortlist into an order.</p>
            <ul>
              <li>Each row shows the buy signal, price with an up/down trend arrow, the saving and tiers, the effective price, and quantity steppers.</li>
              <li><strong>Target</strong>: set the price you want; you get an alert when the market reaches it.</li>
              <li><strong>Notes</strong>: jot a private note inline.</li>
              <li><strong>Group by category</strong> splits the list into sections with subtotals.</li>
              <li>Set quantities and the <strong>cart bar at the bottom</strong> tracks your running total. Click <strong>Save as Order</strong> to turn the cart into a draft order, or use the <strong>+</strong> on a row to add a single product to an order.</li>
              <li><strong>Templates</strong> save a cart you reuse often; <strong>History</strong> lets you re-order from a past cart; <strong>Export CSV</strong> downloads your list.</li>
            </ul>
          </Section>

          <Section id="todo" icon={<ListTodo size={20} />} title="To-Do board">
            <Path>To-Do in the left menu</Path>
            <Shot src="/guide/14-todo.png" alt="The To-Do board: four weekly buckets of sticky-note cards you can drag between weeks." />
            <p>A simple task board so a follow-up never slips. Add a to-do two ways:</p>
            <ul>
              <li><strong>Right-click any product</strong> anywhere and choose <strong>Add to To-Do</strong>. Enter what to do, a note, and a due date. The product and the page you were on are saved with it, so you have the context to decide later.</li>
              <li><strong>New To-Do</strong> button at the top of the board (or the <strong>+</strong> on a week column) for a task not tied to a product.</li>
            </ul>
            <p>
              The board has <strong>four weekly buckets</strong>: This week, Next week, In 2 weeks, and 3+ weeks /
              Later. Cards look like sticky notes. <strong>Drag a card to another week to reschedule it</strong>.
              On each card you can <strong>edit</strong> (pencil), <strong>mark done</strong>, or <strong>delete</strong>,
              and click the product to open its details. Completed items collect in a Done list at the bottom.
            </p>
          </Section>

          <Section id="notes" icon={<StickyNote size={20} />} title="Notes">
            <Path>Notes in the left menu</Path>
            <Shot src="/guide/07-notes.png" alt="Notes: write standalone sticky notes, plus a feed of every note you have written." />
            <h3>Sticky notes</h3>
            <ul>
              <li>Use the box at the top to <strong>write a sticky note</strong>: an optional title, the text, and a colour. Click <strong>Add note</strong> and it appears in the grid below.</li>
              <li><strong>Edit</strong> any sticky in place (pencil), recolour it, or <strong>delete</strong> it (bin).</li>
              <li>Click the <strong>To-Do</strong> icon on a sticky to turn it into a task: it prefills the note and lets you set a due date, then it shows up on your To-Do board.</li>
            </ul>
            <h3>Everything else</h3>
            <p>
              Below the stickies is a single feed of every note you have written elsewhere: on a product, a
              favorite, an order, or an order line. Filter by where the note came from, or search the text. Click
              a note to jump back to what it was attached to.
            </p>
          </Section>

          <Section id="cart" icon={<ShoppingCart size={20} />} title="Cart">
            <Path>The cart icon in the top-right corner (it shows a live item count)</Path>
            <Shot src="/guide/16-cart.png" alt="The Cart: items grouped by sales rep with the deal info and tiers, a header note per rep, save-for-later, and Send All Orders to Reps." />
            <p>
              The cart is where you gather everything you want to buy. Add products from anywhere with the
              <strong> +</strong> button on a row or the right-click <strong>Add to Cart</strong> action.
            </p>
            <ul>
              <li><strong>Grouped by sales rep</strong>: items are organised by distributor and the rep who covers it. When a distributor has one rep it is chosen automatically; otherwise pick the rep from the dropdown (and change it any time). The rep&apos;s phone and email show under each group.</li>
              <li><strong>Same deal info as the catalogue</strong>: each line shows the case/bottle price, the effective price, the saving, and the discount/RIP tiers, so you can bump quantities to hit a better tier before sending.</li>
              <li><strong>Notes</strong>: add a note on any line (it lands on that order line) and a header note per rep (it becomes the order&apos;s note).</li>
              <li><strong>Save for later</strong>: park an item in the section below the cart without removing it.</li>
              <li><strong>Send All Orders to Reps</strong>: one click turns each rep&apos;s group into a submitted order and emails the PO to that rep. All of a rep&apos;s lines go into a single order.</li>
            </ul>
            <Callout>After you send, please follow up with your sales rep. Sending emails the PO; nothing is ordered automatically with the wholesaler.</Callout>
          </Section>

          <Section id="lists" icon={<ClipboardList size={20} />} title="Lists">
            <Path>Lists in the left menu</Path>
            <Shot src="/guide/15-lists.png" alt="Lists: multiple named product lists with checkboxes to move selected items to the cart or delete them." />
            <p>
              Lists are reusable, named collections of products, handy for planning (a seasonal reset, a promo,
              a regular reorder). Create as many as you like.
            </p>
            <ul>
              <li><strong>Add products</strong> from anywhere with the right-click <strong>Add to List</strong> action; pick a list or create a new one.</li>
              <li><strong>Tick</strong> the items you want, then <strong>Move to cart</strong> (they stay in the list, so it is reusable) or <strong>Delete selected</strong>.</li>
              <li><strong>Rename</strong> or <strong>delete</strong> a whole list from its header.</li>
            </ul>
          </Section>

          <Section id="orders" icon={<ShoppingCart size={20} />} title="Orders (submitted)">
            <Path>Orders in the left menu</Path>
            <Shot src="/guide/08-orders.png" alt="Orders: your submitted orders with totals; open one to edit, cancel, or re-share it." />
            <p>Orders holds the purchase orders you have <strong>submitted</strong> from the cart. Open any order to review it, and:</p>
            <ul>
              <li><strong>Edit and re-submit</strong>: reopen an order to change quantities or lines, then submit again as a new revision (the rep gets the updated PO).</li>
              <li><strong>Cancel</strong> an order, or <strong>re-share</strong> the PDF with the rep.</li>
            </ul>
            <h3>Inside an order</h3>
            <ul>
              <li><strong>Add products</strong> by typing a name or barcode in the search box, or pull in your starred products with <strong>Copy from Tracked</strong>.</li>
              <li>Set <strong>cases and bottles</strong> per line. As you reach a RIP tier, it lights up green and the rebate is applied.</li>
              <li>Enter your <strong>Retail price</strong> per bottle and the app shows your <strong>GP%</strong> (margin) both at the deal price and the list price.</li>
              <li>The cards at the top show <strong>Payment Needed Now</strong> (the invoice), the <strong>RIP Rebate</strong> you will earn back, and your <strong>Effective Cost</strong>. A breakdown by category sits below.</li>
              <li><strong>Recommendations</strong> may suggest buying a closeout now, adding a few cases to reach a better tier, or waiting.</li>
              <li><strong>Preview PDF</strong> shows the purchase order exactly as your rep will receive it: a standard PO with your store and the distributor, every line priced, and totals. Open it in a new tab or download it.</li>
              <li><strong>Submit Order</strong> asks you to confirm, then emails that PO PDF to the order&apos;s sales rep (your email is set as reply-to, so they can answer you directly) and locks the order. If the rep has no email on file, the order still submits and you can send the PDF yourself.</li>
              <li>Use <strong>Clone Order</strong> to copy it, or <strong>Delete</strong> to remove it.</li>
            </ul>
            <p className="muted">A rep needs an email saved under Configuration &rarr; Sales Reps for the order to be emailed automatically.</p>
            <p className="muted">The <strong>All Order Lines</strong> tab shows every product across all your orders in one flat list.</p>
          </Section>

          <Section id="alerts" icon={<Bell size={20} />} title="Alerts">
            <Path>Alerts in the left menu (red badge shows unread)</Path>
            <Shot src="/guide/09-alerts.png" alt="Alerts: a grouped digest split into Opportunities and Watch-outs, one tile per category." />
            <p>
              Alerts is an <strong>automatic digest</strong>. It builds itself (no buttons to press) and refreshes
              overnight and whenever you open it. Everything is organised into one tile per category, split into
              two groups so you can see at a glance what to chase and what to avoid:
            </p>
            <h3>Opportunities (don&apos;t miss)</h3>
            <ul>
              <li><strong>Time-sensitive deals</strong>: ending within about a week.</li>
              <li><strong>New RIP rebates</strong> and <strong>new combo bundles</strong> this month.</li>
              <li><strong>Clearance / closeouts</strong> and <strong>price drops</strong>.</li>
              <li><strong>Target price hit</strong>: a favorite reached the price you set.</li>
            </ul>
            <h3>Watch-outs (avoid a mistake)</h3>
            <ul>
              <li><strong>Order check</strong>: a line in your draft orders is a couple of cases short of a bigger rebate, or is cheaper at another distributor.</li>
              <li><strong>Buy now</strong> (gets pricier next month) and <strong>cheaper next month</strong> (consider waiting).</li>
              <li><strong>Lost discounts</strong> and <strong>price increases</strong>.</li>
            </ul>
            <p>
              Each tile shows a count and the top items. <strong>Click a tile to jump to the screen with the
              details</strong> (for example the RIP tile opens RIP Products). Use <strong>Mark all read</strong> to
              clear the badge.
            </p>
          </Section>

          <Section id="rightclick" icon={<MousePointerClick size={18} />} title="The right-click menu">
            <p>Right-click any product row (or use the three-dot button) for quick actions:</p>
            <ul>
              <li><strong>View Product</strong>: open the details popup.</li>
              <li><strong>Search the web</strong>: look up retail prices and listings online (see below).</li>
              <li><strong>Add to Cart</strong>: drop it into your cart, ready to send to the rep.</li>
              <li><strong>Add to Favorites</strong>: star it.</li>
              <li><strong>Add to List</strong>: add it to one of your named lists (or a new one).</li>
              <li><strong>Add to To-Do</strong>: capture a task about this product (what to do, a note, a due date) on your To-Do board.</li>
              <li><strong>Copy Code</strong>: copy the barcode to your clipboard.</li>
            </ul>
          </Section>

          <Section id="websearch" icon={<Globe size={18} />} title="The 'Search the web' popup">
            <p>
              Opened from the right-click menu, this looks up the product on the public web to show retail prices
              and listings, so you can compare your wholesale cost to what stores charge. It shows your wholesale
              price for reference, and (if you allow location access) tries to show prices near you. Results and
              links open in a new tab.
            </p>
          </Section>

          <Section id="configuration" icon={<Settings size={20} />} title="Configuration">
            <Path>Configuration in the left menu</Path>
            <Shot src="/guide/10-configuration.png" alt="Configuration: tabs for Stores, Sales Reps, and Divisions." />
            <p>Your master data, in three tabs:</p>
            <ul>
              <li><strong>Stores</strong>: add, edit, or remove your store locations (with address lookup).</li>
              <li><strong>Sales Reps</strong>: keep a directory of your distributor reps (name, distributor, division, email, phone). Each rep belongs to one distributor: pick the distributor first and the Division list then shows only that distributor&apos;s divisions. Use the pencil to <strong>edit</strong> a rep. The email here is where a submitted order&apos;s PO is sent.</li>
              <li><strong>Divisions</strong>: your own grouping labels. A division belongs to a distributor, so choose the distributor when you add one.</li>
            </ul>
          </Section>

          <Section id="profile" icon={<UserCog size={20} />} title="Profile & password">
            <Path>Profile at the bottom of the left menu</Path>
            <Shot src="/guide/11-profile.png" alt="Profile: edit your name and email, change your password, and manage your stores." />
            <ul>
              <li>Update your <strong>name and email</strong>.</li>
              <li><strong>Change your password</strong> (enter the current one, then the new one twice).</li>
              <li>Manage your <strong>stores</strong> without leaving the page.</li>
            </ul>
          </Section>

          <Section id="admin" icon={<Shield size={20} />} title="Admin-only tools">
            <p className="muted">These appear only for administrators and are not part of normal daily use.</p>
            <ul>
              <li><strong>Addnl Pages</strong> links to extra analysis screens: <strong>Discounts</strong> (best savings ranked), <strong>Clearance</strong> (closeouts), <strong>Promotions</strong> (the raw RIP list), <strong>Analytics</strong> (price movers and trends), <strong>Decisions</strong> (a ranked buy sheet with buy signals), and <strong>QA</strong> (a data-quality scan).</li>
              <li><strong>Admin</strong> shows usage, the user list, feedback, share activity, and lets an admin edit the WhatsApp share message.</li>
              <li><strong>Activity</strong> is the usage analytics view: time spent per screen, a per-user breakdown, top actions, and a per-user detail with their recent trail, over a 7/30/90-day range.</li>
            </ul>
          </Section>

          <Section id="help" icon={<MessageCircle size={20} />} title="Feedback, sharing, and cookies">
            <ul>
              <li><strong>Feedback widget</strong>: the floating button in the corner. Send a bug or an idea any time; it tags your account and the page you were on.</li>
              <li><strong>Share via WhatsApp</strong>: in the left menu; opens WhatsApp with a ready message and the app link.</li>
              <li><strong>Cookie preferences</strong>: when you first visit you choose which cookies to allow (necessary cookies are always on; analytics and marketing are your choice). You can change this any time from the footer of the public site.</li>
            </ul>
          </Section>

          <Section id="glossary" icon={<BookMarked size={20} />} title="Full glossary">
            <div className="htg-terms">
              <Term name="Barcode (UPC)">The product's universal product code. The app matches products across distributors and months by barcode, which is more reliable than the name.</Term>
              <Term name="Buy signal">Strong Buy, Buy Now, Good Buy, Hold, Defer, or Last Chance, based on savings and where the price is heading.</Term>
              <Term name="Cart">Your saved cart of products to order, grouped by sales rep, in the top-right corner. "Send All Orders to Reps" turns each group into one submitted order, emailed to that rep.</Term>
              <Term name="Closeout / Clearance">A product being discontinued and sold off, usually cheap. A "permit" number may be shown for NJ closeout stock.</Term>
              <Term name="CPL / Edition">The monthly wholesaler price list, and the specific month's copy of it.</Term>
              <Term name="Discount tier vs RIP">A discount tier is a flat amount off per case at a quantity; a RIP is a rebate (money back) on volume. They can apply together, and the effective price reflects both.</Term>
              <Term name="Division">A grouping label, either the distributor's own product division or one you create in Configuration.</Term>
              <Term name="Draft vs Submitted order">A draft is editable; submitting locks it as a record of what you sent.</Term>
              <Term name="Effective price">Your true cost after the best discount and RIP. Use it to compare deals fairly.</Term>
              <Term name="Frontline / List / Case price">The plain list price before discounts.</Term>
              <Term name="GP% (deal vs list)">Your margin against your effective (deal) cost, and against the full list cost. The deal GP% is what you actually make.</Term>
              <Term name="ROI%">How much a rebate or discount returns relative to the spend needed to unlock it.</Term>
              <Term name="Target price">Your desired price on a favorite; triggers an alert when reached.</Term>
              <Term name="Vintage">For wine and sparkling, the year. The same barcode can cover several vintages, so the app keeps them separate.</Term>
            </div>
            <Callout>
              Still stuck on a screen? Use the floating <strong>Feedback</strong> button to ask, and we will help and
              improve this guide.
            </Callout>
          </Section>

        </div>
      </div>
    </div>
  );
}
