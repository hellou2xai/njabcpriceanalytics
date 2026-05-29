/**
 * Pro Insights teaser block on the Dashboard.
 *
 * Four POS-driven retail-intelligence tiles with placeholder sample data
 * that gives the buyer a realistic feel for what the upgrade unlocks:
 *
 *   - What I Should Buy          (reorder list driven by sell-through)
 *   - Dead Stock Analysis        (slow movers, cash tied up)
 *   - New Products to Try        (Catalog new items matched to bestsellers)
 *   - Cash Flow Forecast         (in / out of inventory over next 4 weeks)
 *
 * Every tile carries the Pro badge + a "Need POS Integration for Real Data"
 * sticker, and clicking the tile body opens a drill-down modal with a
 * deeper, table-shaped preview so the value-prop reads as a real report,
 * not a marketing chip.
 */
import { useState } from 'react';
import {
  ShoppingBag, TrendingDown, Sparkles, DollarSign, ArrowRight, X, Plug,
} from 'lucide-react';

// ---------------------------------------------------------------------------
// Sample data. Numbers + product names are realistic for an NJ wine + spirits
// retailer so the preview feels like a real report. Replace with live POS
// data once integration is plumbed.
// ---------------------------------------------------------------------------

type Money = number; // dollars

interface ReorderRow {
  product: string;
  size: string;
  onHand: number;            // bottles in stock right now
  velocity: number;          // bottles sold per day, 30-day avg
  daysOfCover: number;       // onHand / velocity
  suggestedCases: number;    // recommended cases to buy
  caseCost: Money;           // best effective case price this/next month combined
  marginPct: number;
  bestRip: string | null;    // RIP code + qty for the rebate carrying the basket
  bestRipRebate: Money;      // dollar rebate at the chosen tier
  bestMonth: 'this' | 'next' | 'flat'; // which edition is cheapest
  urgency: 'critical' | 'low' | 'comfortable';
}

const REORDER: ReorderRow[] = [
  { product: 'TITO\'S HANDMADE VODKA',   size: '750ML', onHand:  9, velocity: 2.8, daysOfCover:  3, suggestedCases: 6, caseCost: 195.00, marginPct: 24, bestRip: 'RIP 30142 · 5 cs',  bestRipRebate:  60, bestMonth: 'this',  urgency: 'critical' },
  { product: 'JAMESON IRISH WHISKEY',    size: '750ML', onHand: 14, velocity: 1.9, daysOfCover:  7, suggestedCases: 4, caseCost: 232.00, marginPct: 22, bestRip: 'RIP 21088 · 4 cs',  bestRipRebate:  84, bestMonth: 'next',  urgency: 'critical' },
  { product: 'KENDALL JACKSON CHARD',    size: '750ML', onHand: 22, velocity: 2.4, daysOfCover:  9, suggestedCases: 5, caseCost: 132.00, marginPct: 28, bestRip: 'RIP 41205 · 5 cs',  bestRipRebate:  45, bestMonth: 'flat',  urgency: 'low' },
  { product: 'BUFFALO TRACE BOURBON',    size: '750ML', onHand:  7, velocity: 1.1, daysOfCover:  6, suggestedCases: 3, caseCost: 268.00, marginPct: 26, bestRip: null,              bestRipRebate:   0, bestMonth: 'this',  urgency: 'critical' },
  { product: 'CAYMUS CABERNET',          size: '750ML', onHand: 18, velocity: 1.4, daysOfCover: 13, suggestedCases: 3, caseCost: 552.00, marginPct: 32, bestRip: 'RIP 50018 · 3 cs',  bestRipRebate: 120, bestMonth: 'next',  urgency: 'low' },
  { product: 'ABSOLUT VODKA',            size: '1.75L', onHand:  4, velocity: 0.8, daysOfCover:  5, suggestedCases: 2, caseCost: 169.00, marginPct: 19, bestRip: 'RIP 30217 · 2 cs',  bestRipRebate:  24, bestMonth: 'this',  urgency: 'critical' },
  { product: 'CASAMIGOS BLANCO',         size: '750ML', onHand: 11, velocity: 1.6, daysOfCover:  7, suggestedCases: 4, caseCost: 488.00, marginPct: 30, bestRip: 'RIP 33119 · 4 cs',  bestRipRebate: 100, bestMonth: 'this',  urgency: 'critical' },
  { product: 'JOSH CELLARS CABERNET',    size: '750ML', onHand: 28, velocity: 3.1, daysOfCover:  9, suggestedCases: 7, caseCost:  98.00, marginPct: 35, bestRip: 'RIP 41032 · 5 cs',  bestRipRebate:  35, bestMonth: 'next',  urgency: 'low' },
  { product: 'MAKER\'S MARK BOURBON',    size: '750ML', onHand: 16, velocity: 1.5, daysOfCover: 11, suggestedCases: 3, caseCost: 278.00, marginPct: 24, bestRip: 'RIP 21466 · 3 cs',  bestRipRebate:  42, bestMonth: 'flat',  urgency: 'low' },
  { product: 'WHISPERING ANGEL ROSE',    size: '750ML', onHand: 12, velocity: 2.2, daysOfCover:  5, suggestedCases: 5, caseCost: 215.00, marginPct: 29, bestRip: 'RIP 47008 · 5 cs',  bestRipRebate:  75, bestMonth: 'next',  urgency: 'critical' },
];

interface DeadStockRow {
  product: string;
  size: string;
  onHand: number;
  daysSinceLastSale: number;
  cashTiedUp: Money;
  costBasis: Money;
  recommendedAction: 'mark down' | 'return' | 'bundle' | 'monitor';
}

const DEAD_STOCK: DeadStockRow[] = [
  { product: 'CHATEAU 2017 OBSCURE',         size: '750ML', onHand: 24, daysSinceLastSale: 187, cashTiedUp: 1248.00, costBasis: 1248.00, recommendedAction: 'mark down' },
  { product: 'NICHE CRAFT BOURBON BLEND',    size: '750ML', onHand: 18, daysSinceLastSale: 142, cashTiedUp:  864.00, costBasis:  864.00, recommendedAction: 'mark down' },
  { product: 'SEASONAL EGGNOG LIQUEUR',      size: '750ML', onHand: 36, daysSinceLastSale: 198, cashTiedUp:  720.00, costBasis:  720.00, recommendedAction: 'bundle'    },
  { product: 'IMPORTED AMARO HERBAL',        size: '500ML', onHand: 22, daysSinceLastSale: 156, cashTiedUp:  616.00, costBasis:  616.00, recommendedAction: 'return'    },
  { product: 'COCONUT-INFUSED RUM PINK',     size: '750ML', onHand: 30, daysSinceLastSale: 112, cashTiedUp:  540.00, costBasis:  540.00, recommendedAction: 'bundle'    },
  { product: 'ESTATE PINOT GRIGIO 2021',     size: '750ML', onHand: 16, daysSinceLastSale:  98, cashTiedUp:  416.00, costBasis:  416.00, recommendedAction: 'monitor'   },
  { product: 'VERMOUTH SWEET TRADITIONAL',   size: '750ML', onHand: 14, daysSinceLastSale: 173, cashTiedUp:  336.00, costBasis:  336.00, recommendedAction: 'mark down' },
  { product: 'LIQUEUR ELDERFLOWER',          size: '750ML', onHand: 11, daysSinceLastSale: 124, cashTiedUp:  297.00, costBasis:  297.00, recommendedAction: 'monitor'   },
];

interface NewProductRow {
  product: string;
  size: string;
  category: string;
  rationale: string;
  expectedVelocity: number;
  rip: string | null;
  introCost: Money;
  matchScore: number; // 0-100
}

const NEW_PRODUCTS: NewProductRow[] = [
  { product: 'HIGH NOON SUN SIPS VARIETY', size: '12X12OZ', category: 'RTD',     rationale: 'Matches your top-selling RTD bestsellers; trending +38% YoY in NJ',  expectedVelocity: 2.4, rip: 'RIP 10047', introCost: 24.99, matchScore: 94 },
  { product: 'ESPOLON BLANCO TEQUILA',     size: '750ML',   category: 'Tequila', rationale: 'Tequila grew 22% in your store; this lands in your $20–30 sweet spot', expectedVelocity: 1.6, rip: null,         introCost: 21.99, matchScore: 89 },
  { product: 'CHANDON BLANC DE NOIRS',     size: '750ML',   category: 'Sparkling', rationale: 'Sparkling SKUs up 18% Mar→May; this is the best-selling NV in segment',    expectedVelocity: 1.1, rip: 'RIP 11200', introCost: 22.99, matchScore: 87 },
  { product: 'KIM CRAWFORD SAUV BLANC',    size: '750ML',   category: 'Wine',    rationale: 'You miss a high-velocity Sauv Blanc above $14; adds basket size',          expectedVelocity: 1.9, rip: null,         introCost: 18.99, matchScore: 85 },
  { product: 'BULLEIT RYE',                size: '750ML',   category: 'Whiskey', rationale: 'Whiskey velocity #1 in your category; sub for sold-out Bulleit Bourbon',   expectedVelocity: 1.4, rip: 'RIP 30017', introCost: 32.99, matchScore: 82 },
  { product: 'BIRA HARD CIDER VARIETY',    size: '12PK',    category: 'Cider',   rationale: 'New segment your competitors are stocking; small initial buy',            expectedVelocity: 0.7, rip: null,         introCost: 12.49, matchScore: 71 },
];

interface CashFlowWeek {
  week: string;
  buyIn: Money;
  sellOut: Money;
  net: Money;
}

const CASH_FLOW: CashFlowWeek[] = [
  { week: 'This Week',   buyIn: 12_400, sellOut: 18_900, net:  6_500 },
  { week: 'Week + 1',    buyIn: 14_200, sellOut: 19_600, net:  5_400 },
  { week: 'Week + 2',    buyIn: 15_800, sellOut: 21_100, net:  5_300 },
  { week: 'Week + 3',    buyIn: 13_100, sellOut: 20_400, net:  7_300 },
];

// ---------------------------------------------------------------------------
// Tile UI
// ---------------------------------------------------------------------------

type DrillDownId = 'reorder' | 'dead-stock' | 'new-products' | 'cash-flow';

interface TileMeta {
  id: DrillDownId;
  label: string;
  icon: React.ElementType;
  accent: string;
  headlineValue: string;
  headlineSub: string;
  bullets: { dot: string; text: string }[];
}

const TILES: TileMeta[] = [
  {
    id: 'reorder',
    label: 'What I Should Buy',
    icon: ShoppingBag,
    accent: '#b45309',
    headlineValue: '42 cs',
    headlineSub: 'across 10 SKUs running short this week',
    bullets: [
      { dot: '#dc2626', text: '5 SKUs at < 7 days of cover' },
      { dot: '#ea580c', text: '$10.1k buy, $2.5k RIP rebate locked' },
      { dot: '#16a34a', text: '4 SKUs cheaper next month, 5 best now' },
    ],
  },
  {
    id: 'dead-stock',
    label: 'Dead Stock Analysis',
    icon: TrendingDown,
    accent: '#7c3aed',
    headlineValue: '$5.0k',
    headlineSub: 'cash tied up in 8 SKUs not selling',
    bullets: [
      { dot: '#dc2626', text: '3 SKUs sitting > 150 days' },
      { dot: '#f59e0b', text: '4 SKUs flagged for markdown' },
      { dot: '#0d9488', text: '1 SKU eligible for distributor return' },
    ],
  },
  {
    id: 'new-products',
    label: 'New Products to Try',
    icon: Sparkles,
    accent: '#0ea5e9',
    headlineValue: '6 picks',
    headlineSub: 'matched to your bestseller profile',
    bullets: [
      { dot: '#16a34a', text: 'Avg match score: 85 / 100' },
      { dot: '#2563eb', text: '3 have an active RIP rebate' },
      { dot: '#7c3aed', text: 'Sourced from this month\'s New Items' },
    ],
  },
  {
    id: 'cash-flow',
    label: 'Cash Flow Forecast',
    icon: DollarSign,
    accent: '#16a34a',
    headlineValue: '+$24.5k',
    headlineSub: 'projected net cash, next 4 weeks',
    bullets: [
      { dot: '#16a34a', text: 'Sell-out > buy-in every week' },
      { dot: '#f59e0b', text: 'Largest buy week: Week + 2' },
      { dot: '#2563eb', text: 'Tracks vs your real POS sales' },
    ],
  },
];

interface ProTileProps {
  meta: TileMeta;
  onOpen: () => void;
}

function ProTile({ meta, onOpen }: ProTileProps) {
  const Icon = meta.icon;
  return (
    <button type="button" className="pro-tile" onClick={onOpen}>
      <div className="pro-tile-head">
        <div className="pro-tile-icon" style={{ background: `${meta.accent}1f`, color: meta.accent }}>
          <Icon size={20} />
        </div>
        <span className="pro-tile-badge">Pro</span>
      </div>
      <div className="pro-tile-title">{meta.label}</div>
      <div className="pro-tile-headline">
        <span className="pro-tile-headline-value" style={{ color: meta.accent }}>{meta.headlineValue}</span>
        <span className="pro-tile-headline-sub">{meta.headlineSub}</span>
      </div>
      <ul className="pro-tile-bullets">
        {meta.bullets.map((b, i) => (
          <li key={i}>
            <span className="pro-tile-dot" style={{ background: b.dot }} />
            {b.text}
          </li>
        ))}
      </ul>
      <div className="pro-tile-footer">
        <span className="pro-tile-pos-sticker">
          <Plug size={11} /> Need POS Integration for Real Data
        </span>
        <span className="pro-tile-cta">
          Detailed drill-down <ArrowRight size={13} />
        </span>
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Drill-down modal
// ---------------------------------------------------------------------------

interface DrillDownProps {
  id: DrillDownId;
  onClose: () => void;
}

function ReorderDrill() {
  const totalUnits = REORDER.reduce((a, c) => a + c.suggestedCases, 0);
  const totalCost = REORDER.reduce((a, c) => a + c.suggestedCases * c.caseCost, 0);
  const critical = REORDER.filter(r => r.urgency === 'critical').length;
  const avgMargin = Math.round(REORDER.reduce((a, c) => a + c.marginPct, 0) / REORDER.length);
  const totalRebate = REORDER.reduce((a, c) => a + c.bestRipRebate * c.suggestedCases, 0);
  return (
    <>
      <div className="pro-drill-stats">
        <Stat label="Recommended buy" value={`${totalUnits} cs`} />
        <Stat label="Cash needed" value={`$${totalCost.toLocaleString()}`} />
        <Stat label="Critical SKUs" value={`${critical} of ${REORDER.length}`} tone="bad" />
        <Stat label="RIP rebate on basket" value={`$${totalRebate.toLocaleString()}`} tone="good" />
        <Stat label="Avg basket margin" value={`${avgMargin}%`} tone="good" />
      </div>
      <table className="pro-drill-table pro-drill-table--reorder">
        <thead>
          <tr>
            <th>Product</th><th>Size</th>
            <th className="r">On hand</th>
            <th className="r">Velocity / day</th>
            <th className="r">Days cover</th>
            <th className="r">Suggested buy</th>
            <th>Best RIP deal</th>
            <th>Best month</th>
            <th className="r">Case cost</th>
            <th className="r">Margin</th>
            <th>Urgency</th>
          </tr>
        </thead>
        <tbody>
          {REORDER.map((r, i) => (
            <tr key={i}>
              <td>{r.product}</td>
              <td>{r.size}</td>
              <td className="r">{r.onHand} btl</td>
              <td className="r">{r.velocity.toFixed(1)}</td>
              <td className="r">{r.daysOfCover} d</td>
              <td className="r"><strong>{r.suggestedCases} cs</strong></td>
              <td>
                {r.bestRip ? (
                  <span className="pro-rip-deal">
                    <span className="pro-rip-deal-code">{r.bestRip}</span>
                    <span className="pro-rip-deal-amount">−${r.bestRipRebate}/cs</span>
                  </span>
                ) : <span style={{ color: 'var(--text-muted)' }}>—</span>}
              </td>
              <td><BestMonthBadge month={r.bestMonth} /></td>
              <td className="r">${r.caseCost.toFixed(2)}</td>
              <td className="r">{r.marginPct}%</td>
              <td><UrgencyBadge urgency={r.urgency} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="pro-drill-explain">
        With POS connected, this list updates daily from your real sell-through, current on-hand, and incoming POs.
        Each row pairs the recommended buy with the strongest active RIP and flags whether the cheapest effective
        price lands this month or waits for next month, so you don't pay full price the day before a rebate kicks in.
      </p>
    </>
  );
}

function DeadStockDrill() {
  const totalCash = DEAD_STOCK.reduce((a, c) => a + c.cashTiedUp, 0);
  const markDown = DEAD_STOCK.filter(r => r.recommendedAction === 'mark down').length;
  const returns  = DEAD_STOCK.filter(r => r.recommendedAction === 'return').length;
  const bundle   = DEAD_STOCK.filter(r => r.recommendedAction === 'bundle').length;
  return (
    <>
      <div className="pro-drill-stats">
        <Stat label="Cash tied up" value={`$${totalCash.toLocaleString()}`} tone="bad" />
        <Stat label="SKUs flagged" value={`${DEAD_STOCK.length}`} />
        <Stat label="Mark down" value={`${markDown} SKUs`} tone="warn" />
        <Stat label="Distributor return" value={`${returns} SKUs`} tone="good" />
      </div>
      <table className="pro-drill-table">
        <thead>
          <tr>
            <th>Product</th><th>Size</th><th className="r">On hand</th>
            <th className="r">Days since last sale</th><th className="r">Cash tied up</th><th>Recommended action</th>
          </tr>
        </thead>
        <tbody>
          {DEAD_STOCK.map((r, i) => (
            <tr key={i}>
              <td>{r.product}</td><td>{r.size}</td>
              <td className="r">{r.onHand} btl</td>
              <td className="r">{r.daysSinceLastSale} d</td>
              <td className="r"><strong>${r.cashTiedUp.toLocaleString()}</strong></td>
              <td><ActionBadge action={r.recommendedAction} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="pro-drill-explain">
        With POS connected, "days since last sale" comes from your real ledger, not an estimate.
        Mark-down candidates auto-route to a worksheet; return-eligible SKUs check against each distributor's return policy in your contract.
      </p>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 8 }}>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Top wedge: <strong>{bundle} SKUs</strong> would clear faster as bundles than as standalone markdowns.</span>
      </div>
    </>
  );
}

function NewProductsDrill() {
  const avgScore = Math.round(NEW_PRODUCTS.reduce((a, c) => a + c.matchScore, 0) / NEW_PRODUCTS.length);
  const withRip = NEW_PRODUCTS.filter(r => !!r.rip).length;
  return (
    <>
      <div className="pro-drill-stats">
        <Stat label="Picks for your store" value={`${NEW_PRODUCTS.length}`} />
        <Stat label="Avg match score" value={`${avgScore} / 100`} tone="good" />
        <Stat label="With active RIP" value={`${withRip}`} />
        <Stat label="Source" value="This edition's New Items" />
      </div>
      <table className="pro-drill-table pro-drill-table--new">
        <thead>
          <tr>
            <th className="col-product">Product</th>
            <th className="col-size">Size</th>
            <th className="col-cat">Category</th>
            <th className="col-rationale">Why this fits</th>
            <th className="r col-vel">Velocity / day</th>
            <th className="col-rip">RIP</th>
            <th className="r col-cost">Intro cost</th>
            <th className="r col-match">Match</th>
          </tr>
        </thead>
        <tbody>
          {NEW_PRODUCTS.map((r, i) => (
            <tr key={i}>
              <td className="col-product">{r.product}</td>
              <td className="col-size">{r.size}</td>
              <td className="col-cat">{r.category}</td>
              <td className="col-rationale">{r.rationale}</td>
              <td className="r col-vel">{r.expectedVelocity.toFixed(1)}</td>
              <td className="col-rip">{r.rip ?? <span style={{ color: 'var(--text-muted)' }}>—</span>}</td>
              <td className="r col-cost">${r.introCost.toFixed(2)}</td>
              <td className="r col-match"><ScorePill score={r.matchScore} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="pro-drill-explain">
        Match scores combine your category mix, your price-tier spread, your local trend data, and the New Items feed.
        Higher score = closer fit to what's actually moving at your store.
      </p>
    </>
  );
}

function CashFlowDrill() {
  const totalIn = CASH_FLOW.reduce((a, c) => a + c.buyIn, 0);
  const totalOut = CASH_FLOW.reduce((a, c) => a + c.sellOut, 0);
  const totalNet = totalOut - totalIn;
  const maxBar = Math.max(...CASH_FLOW.flatMap(w => [w.buyIn, w.sellOut]));
  return (
    <>
      <div className="pro-drill-stats">
        <Stat label="Buy-in (4 wk)"  value={`$${totalIn.toLocaleString()}`} />
        <Stat label="Sell-out (4 wk)" value={`$${totalOut.toLocaleString()}`} tone="good" />
        <Stat label="Net cash" value={`+$${totalNet.toLocaleString()}`} tone="good" />
        <Stat label="Largest buy week" value="Week + 2" />
      </div>
      <div className="pro-cash-chart">
        {CASH_FLOW.map((w, i) => (
          <div key={i} className="pro-cash-row">
            <span className="pro-cash-week">{w.week}</span>
            <div className="pro-cash-bars">
              <div className="pro-cash-bar pro-cash-bar--in"
                   style={{ width: `${(w.buyIn / maxBar) * 100}%` }}
                   title={`Buy-in: $${w.buyIn.toLocaleString()}`}>
                <span>${(w.buyIn / 1000).toFixed(1)}k</span>
              </div>
              <div className="pro-cash-bar pro-cash-bar--out"
                   style={{ width: `${(w.sellOut / maxBar) * 100}%` }}
                   title={`Sell-out: $${w.sellOut.toLocaleString()}`}>
                <span>${(w.sellOut / 1000).toFixed(1)}k</span>
              </div>
            </div>
            <span className="pro-cash-net">+${w.net.toLocaleString()}</span>
          </div>
        ))}
        <div className="pro-cash-legend">
          <span><span className="pro-cash-key pro-cash-key--in"></span>Buy-in (inventory purchases)</span>
          <span><span className="pro-cash-key pro-cash-key--out"></span>Sell-out (revenue projected from POS)</span>
        </div>
      </div>
      <p className="pro-drill-explain">
        Sell-out is forecast from your trailing 8-week velocity by SKU, adjusted for known events (holidays, distributor promos).
        Buy-in stays editable: drag a week to test a different reorder plan.
      </p>
    </>
  );
}

const DRILL_META: Record<DrillDownId, { title: string; sub: string }> = {
  'reorder':      { title: 'What I Should Buy',       sub: 'A reorder worksheet driven by sell-through, on-hand, and incoming POs.' },
  'dead-stock':   { title: 'Dead Stock Analysis',     sub: 'SKUs sitting on the shelf with no recent sales, ranked by cash tied up.' },
  'new-products': { title: 'New Products to Try',     sub: 'New items matched to your bestseller profile and your local trend data.' },
  'cash-flow':    { title: 'Cash Flow Forecast',      sub: 'Projected inventory buy-in vs. revenue sell-out over the next four weeks.' },
};

function DrillDown({ id, onClose }: DrillDownProps) {
  const meta = DRILL_META[id];
  return (
    <div className="pro-drill-overlay"
         role="dialog" aria-modal="true"
         onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="pro-drill-modal">
        <div className="pro-drill-head">
          <div className="pro-drill-head-text">
            <span className="catalog-pro-badge">Pro</span>
            <h3>{meta.title}</h3>
            <p>{meta.sub}</p>
          </div>
          <div className="pro-drill-head-side">
            <span className="pro-drill-pos-sticker">
              <Plug size={12} /> Need POS Integration for Real Data
            </span>
            <button type="button" className="pro-drill-close" onClick={onClose} aria-label="Close">
              <X size={18} />
            </button>
          </div>
        </div>
        <div className="pro-drill-body">
          {id === 'reorder'      && <ReorderDrill />}
          {id === 'dead-stock'   && <DeadStockDrill />}
          {id === 'new-products' && <NewProductsDrill />}
          {id === 'cash-flow'    && <CashFlowDrill />}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' | 'warn' }) {
  return (
    <div className={`pro-stat tone-${tone ?? 'neutral'}`}>
      <div className="pro-stat-value">{value}</div>
      <div className="pro-stat-label">{label}</div>
    </div>
  );
}

function UrgencyBadge({ urgency }: { urgency: ReorderRow['urgency'] }) {
  const map = {
    'critical':    { label: 'Critical',    cls: 'urgency-critical' },
    'low':         { label: 'Low stock',   cls: 'urgency-low' },
    'comfortable': { label: 'Comfortable', cls: 'urgency-ok' },
  };
  const m = map[urgency];
  return <span className={`pro-pill ${m.cls}`}>{m.label}</span>;
}

function BestMonthBadge({ month }: { month: ReorderRow['bestMonth'] }) {
  const map = {
    'this': { label: 'This month', cls: 'month-this',
              title: 'Cheapest effective case price lands in the current edition — buy now.' },
    'next': { label: 'Next month', cls: 'month-next',
              title: 'Effective case price drops next edition — wait if you can.' },
    'flat': { label: 'Same',       cls: 'month-flat',
              title: 'No move between this month and next.' },
  } as const;
  const m = map[month];
  return <span className={`pro-pill ${m.cls}`} title={m.title}>{m.label}</span>;
}

function ActionBadge({ action }: { action: DeadStockRow['recommendedAction'] }) {
  const map = {
    'mark down': { label: 'Mark down', cls: 'action-markdown' },
    'return':    { label: 'Return',    cls: 'action-return'   },
    'bundle':    { label: 'Bundle',    cls: 'action-bundle'   },
    'monitor':   { label: 'Monitor',   cls: 'action-monitor'  },
  };
  const m = map[action];
  return <span className={`pro-pill ${m.cls}`}>{m.label}</span>;
}

function ScorePill({ score }: { score: number }) {
  const tone = score >= 85 ? 'good' : score >= 70 ? 'warn' : 'bad';
  return <span className={`pro-pill score-${tone}`}>{score}</span>;
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export default function ProInsightsTiles() {
  const [openId, setOpenId] = useState<DrillDownId | null>(null);
  return (
    <>
      <div className="section-label pro-section-label">
        Pro Insights <span className="catalog-pro-badge">Preview</span>
        <span className="pro-section-sub">— sample data; connect your POS for live numbers</span>
      </div>
      <div className="dashboard-tile-grid pro-tile-grid">
        {TILES.map(t => (
          <ProTile key={t.id} meta={t} onOpen={() => setOpenId(t.id)} />
        ))}
      </div>
      {openId && <DrillDown id={openId} onClose={() => setOpenId(null)} />}
    </>
  );
}
