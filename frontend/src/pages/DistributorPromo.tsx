import { useState } from 'react';
import { Star, ShoppingCart, Eye, Newspaper } from 'lucide-react';
import './DistributorPromo.css';

/**
 * DistributorPromo — a NON-customer-facing pitch page that shows a distributor
 * how their book could be promoted on CELR. Two views:
 *   - "distributor"  → a magazine-style "Portfolio Edit" lookbook (the pitch)
 *   - "retail"       → how those same products surface to retailers in-app
 * Admin flips between them with the toggle at the top.
 *
 * This is a DUMMY page: the Top-20 list below is illustrative sample data, not a
 * live pricing query. Names/prices are placeholders for the mockup.
 */

const EDITION = 'July 2026';

type DealKind = 'RIP' | 'QD' | 'NEW' | 'ALLOCATED';
type CatKey =
  | 'tequila' | 'scotch' | 'vodka' | 'cognac' | 'bourbon' | 'sparkling'
  | 'liqueur' | 'rye' | 'gin' | 'rum' | 'wine_white' | 'wine_red';

interface Prod {
  rank: number;
  brand: string;
  name: string;
  cat: string;      // display label
  catKey: CatKey;   // colour key
  size: string;
  proof: number;
  cs: number;       // case price
  btl: number;      // bottle price
  list: number;     // frontline / list bottle price
  deal: { kind: DealKind; note: string };
  blurb: string;
}

const PRODUCTS: Prod[] = [
  { rank: 1,  brand: 'Clase Azul',      name: 'Reposado',              cat: 'Tequila',   catKey: 'tequila',    size: '750ml', proof: 80,   cs: 1290, btl: 107.5, list: 121, deal: { kind: 'ALLOCATED', note: 'Monthly allocation' }, blurb: 'The hand-painted decanter that sells itself off the back bar.' },
  { rank: 2,  brand: 'Don Julio',       name: '1942 Añejo',            cat: 'Tequila',   catKey: 'tequila',    size: '750ml', proof: 80,   cs: 1140, btl: 95,    list: 104, deal: { kind: 'RIP',       note: '$108 / cs rebate' }, blurb: 'The bottle every steakhouse guest points to by name.' },
  { rank: 3,  brand: 'The Macallan',    name: '12 Double Cask',        cat: 'Scotch',    catKey: 'scotch',     size: '750ml', proof: 86,   cs: 660,  btl: 55,    list: 62,  deal: { kind: 'RIP',       note: '$120 / cs rebate' }, blurb: 'The sherry-oak benchmark with year-round pull.' },
  { rank: 4,  brand: 'Grey Goose',      name: 'Original Vodka',        cat: 'Vodka',     catKey: 'vodka',      size: '1.75L', proof: 80,   cs: 360,  btl: 30,    list: 34,  deal: { kind: 'QD',        note: '5 cs → $2 / btl' }, blurb: 'The top-shelf well pour that moves by the pallet.' },
  { rank: 5,  brand: 'Casamigos',       name: 'Blanco',                cat: 'Tequila',   catKey: 'tequila',    size: '750ml', proof: 80,   cs: 540,  btl: 45,    list: 50,  deal: { kind: 'QD',        note: '10 cs → $3 / btl' }, blurb: 'Name recognition that closes the sale at the shelf.' },
  { rank: 6,  brand: 'Hennessy',        name: 'V.S.O.P Privilège',     cat: 'Cognac',    catKey: 'cognac',     size: '750ml', proof: 80,   cs: 780,  btl: 65,    list: 72,  deal: { kind: 'RIP',       note: '$84 / cs rebate' }, blurb: 'The step-up pour when V.S no longer cuts it.' },
  { rank: 7,  brand: "Tito's",          name: 'Handmade Vodka',        cat: 'Vodka',     catKey: 'vodka',      size: '1.75L', proof: 80,   cs: 288,  btl: 24,    list: 27,  deal: { kind: 'QD',        note: '15 cs → $1.50 / btl' }, blurb: 'The volume anchor that never sits on the shelf.' },
  { rank: 8,  brand: 'Woodford Reserve',name: "Distiller's Select",    cat: 'Bourbon',   catKey: 'bourbon',    size: '750ml', proof: 90,   cs: 396,  btl: 33,    list: 38,  deal: { kind: 'RIP',       note: '$60 / cs rebate' }, blurb: 'The Kentucky handshake for a serious cocktail list.' },
  { rank: 9,  brand: 'Veuve Clicquot',  name: 'Yellow Label Brut',     cat: 'Champagne', catKey: 'sparkling',  size: '750ml', proof: 24,   cs: 660,  btl: 55,    list: 62,  deal: { kind: 'ALLOCATED', note: 'Holiday allocation open' }, blurb: 'Celebration in a bottle — and the margin holds firm.' },
  { rank: 10, brand: 'Patrón',          name: 'Silver',                cat: 'Tequila',   catKey: 'tequila',    size: '750ml', proof: 80,   cs: 570,  btl: 47.5,  list: 53,  deal: { kind: 'QD',        note: '8 cs → $2.50 / btl' }, blurb: 'The margarita standard, for very good reason.' },
  { rank: 11, brand: 'Johnnie Walker',  name: 'Blue Label',            cat: 'Scotch',    catKey: 'scotch',     size: '750ml', proof: 80,   cs: 2760, btl: 230,   list: 249, deal: { kind: 'ALLOCATED', note: 'Gift-season allocation' }, blurb: 'The trophy bottle that anchors the entire top shelf.' },
  { rank: 12, brand: 'Aperol',          name: 'Aperitivo',             cat: 'Liqueur',   catKey: 'liqueur',    size: '750ml', proof: 22,   cs: 264,  btl: 22,    list: 25,  deal: { kind: 'NEW',       note: 'New book price' }, blurb: 'Spritz season turns these cases fast.' },
  { rank: 13, brand: 'Buffalo Trace',   name: 'Kentucky Straight',     cat: 'Bourbon',   catKey: 'bourbon',    size: '750ml', proof: 90,   cs: 300,  btl: 25,    list: 30,  deal: { kind: 'ALLOCATED', note: 'Allocated — ask your rep' }, blurb: 'Chased all year; it sells the moment it lands.' },
  { rank: 14, brand: 'Belvedere',       name: 'Pure',                  cat: 'Vodka',     catKey: 'vodka',      size: '750ml', proof: 80,   cs: 420,  btl: 35,    list: 40,  deal: { kind: 'RIP',       note: '$60 / cs rebate' }, blurb: 'Polish craft with a loyal on-premise following.' },
  { rank: 15, brand: 'Bulleit',         name: 'Rye Frontier',          cat: 'Rye',       catKey: 'rye',        size: '750ml', proof: 90,   cs: 324,  btl: 27,    list: 31,  deal: { kind: 'QD',        note: '10 cs → $2 / btl' }, blurb: "The bartender's rye for a proper Manhattan." },
  { rank: 16, brand: 'Bombay Sapphire', name: 'London Dry Gin',        cat: 'Gin',       catKey: 'gin',        size: '1.75L', proof: 94,   cs: 396,  btl: 33,    list: 37,  deal: { kind: 'QD',        note: '6 cs → $1.50 / btl' }, blurb: 'The botanical blue bottle with real shelf presence.' },
  { rank: 17, brand: 'Bacardí',         name: 'Superior Rum',          cat: 'Rum',       catKey: 'rum',        size: '1.75L', proof: 80,   cs: 240,  btl: 20,    list: 23,  deal: { kind: 'QD',        note: '20 cs → $1 / btl' }, blurb: 'Daiquiri and mojito backbone — pure volume.' },
  { rank: 18, brand: 'Kim Crawford',    name: 'Sauvignon Blanc',       cat: 'White Wine',catKey: 'wine_white', size: '750ml', proof: 25,   cs: 144,  btl: 12,    list: 15,  deal: { kind: 'NEW',       note: 'New vintage' }, blurb: 'A by-the-glass favourite that reorders itself.' },
  { rank: 19, brand: 'Josh Cellars',    name: 'Cabernet Sauvignon',    cat: 'Red Wine',  catKey: 'wine_red',   size: '750ml', proof: 27,   cs: 132,  btl: 11,    list: 14,  deal: { kind: 'QD',        note: '25 cs → $0.75 / btl' }, blurb: 'The everyday red America keeps buying.' },
  { rank: 20, brand: 'Baileys',         name: 'Original Irish Cream',  cat: 'Liqueur',   catKey: 'liqueur',    size: '750ml', proof: 34,   cs: 300,  btl: 25,    list: 28,  deal: { kind: 'RIP',       note: '$48 / cs rebate' }, blurb: 'The Q4 gifting engine — plan the stack now.' },
];

const CAT_COLORS: Record<CatKey, { ink: string; glass: string }> = {
  tequila:    { ink: '#586a2b', glass: '#e9e8ce' },
  scotch:     { ink: '#7a4a22', glass: '#ecdfcd' },
  vodka:      { ink: '#37576b', glass: '#dbe6ec' },
  cognac:     { ink: '#8a5320', glass: '#eddcc4' },
  bourbon:    { ink: '#93551f', glass: '#ebddc4' },
  sparkling:  { ink: '#927327', glass: '#efe6c6' },
  liqueur:    { ink: '#6b4a7a', glass: '#e6dced' },
  rye:        { ink: '#a15a1f', glass: '#eddcc2' },
  gin:        { ink: '#2f6d5f', glass: '#d6e7e0' },
  rum:        { ink: '#7a3f1f', glass: '#eed9c4' },
  wine_white: { ink: '#8a7d2e', glass: '#eee9cd' },
  wine_red:   { ink: '#7a2e3a', glass: '#ecd6d9' },
};

const money = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: n % 1 ? 2 : 0 });

const rank2 = (n: number) => String(n).padStart(2, '0');

function DealTag({ deal }: { deal: Prod['deal'] }) {
  return <span className={`dp-dealtag dp-dealtag--${deal.kind.toLowerCase()}`}>{deal.kind === 'RIP' ? 'Rebate' : deal.kind === 'QD' ? 'Qty deal' : deal.kind === 'NEW' ? 'New' : 'Allocated'} · {deal.note}</span>;
}

/** Typographic "label plate" — stands in for a bottle shot on this dummy page. */
function Plate({ p, size = 'md' }: { p: Prod; size?: 'md' | 'lg' }) {
  const c = CAT_COLORS[p.catKey];
  return (
    <div
      className={`dp-glass dp-glass--${size}`}
      style={{ ['--glass' as string]: c.glass, ['--ink' as string]: c.ink }}
    >
      <div className="dp-plate">
        <span className="dp-plate-cat">{p.cat}</span>
        <span className="dp-plate-rule" />
        <span className="dp-plate-brand">{p.brand}</span>
        <span className="dp-plate-name">{p.name}</span>
        <span className="dp-plate-spec">{p.size} · {p.proof}° proof</span>
      </div>
    </div>
  );
}

/* ------------------------------- Distributor view ------------------------------- */

function MagazineView() {
  const [cover, ...rest] = PRODUCTS;
  return (
    <div className="dp-mag">
      <header className="dp-mast">
        <div className="dp-mast-top">
          <span className="dp-kicker">Distributor Portfolio · Curated on CELR</span>
          <span className="dp-issue">Vol. 07 — {EDITION} Edition</span>
        </div>
        <h1 className="dp-word">Fedway</h1>
        <div className="dp-mast-bottom">
          <span className="dp-sub">The Portfolio Edit · Top 20</span>
          <span className="dp-mast-line" />
          <span className="dp-mast-note">Internal preview — not customer facing</span>
        </div>
      </header>

      <section className="dp-cover">
        <div className="dp-cover-copy">
          <span className="dp-eyebrow">Cover · {cover.cat}</span>
          <h2 className="dp-cover-name">
            <span className="dp-cover-brand">{cover.brand}</span>
            <span className="dp-cover-prod">{cover.name}</span>
          </h2>
          <p className="dp-cover-blurb">{cover.blurb}</p>
          <dl className="dp-spec">
            <div><dt>Case</dt><dd>{money(cover.cs)}</dd></div>
            <div><dt>Bottle</dt><dd>{money(cover.btl)}</dd></div>
            <div><dt>Size</dt><dd>{cover.size}</dd></div>
            <div><dt>Proof</dt><dd>{cover.proof}°</dd></div>
          </dl>
          <DealTag deal={cover.deal} />
        </div>
        <div className="dp-cover-art">
          <span className="dp-cover-num">{rank2(cover.rank)}</span>
          <Plate p={cover} size="lg" />
        </div>
      </section>

      <div className="dp-countdown-head">
        <span className="dp-countdown-label">The Countdown</span>
        <span className="dp-countdown-sub">Ranked 02–20 · by case movement</span>
      </div>

      <section className="dp-grid">
        {rest.map((p) => (
          <article key={p.rank} className="dp-card">
            <div className="dp-card-art">
              <span className="dp-card-num">{rank2(p.rank)}</span>
              <Plate p={p} />
            </div>
            <div className="dp-card-copy">
              <span className="dp-card-cat">{p.cat}</span>
              <h3 className="dp-card-name"><b>{p.brand}</b> {p.name}</h3>
              <p className="dp-card-blurb">{p.blurb}</p>
              <div className="dp-card-foot">
                <span className="dp-card-price">{money(p.btl)}<i>/btl</i></span>
                <DealTag deal={p.deal} />
              </div>
            </div>
          </article>
        ))}
      </section>

      <footer className="dp-mag-foot">
        <span className="dp-word dp-word--sm">Fedway</span>
        <span>Presented on CELR · {EDITION} · Prices shown are illustrative for this preview.</span>
      </footer>
    </div>
  );
}

/* --------------------------------- Retail view --------------------------------- */

function RetailView() {
  return (
    <div className="dp-retail">
      <div className="dp-retail-intro">
        <h2>How retailers see Fedway on CELR</h2>
        <p>The same 20 products as they surface to buyers — price-forward, deal-tagged, and ready to add to a cart.</p>
      </div>
      <div className="dp-retail-grid">
        {PRODUCTS.map((p) => {
          const c = CAT_COLORS[p.catKey];
          const save = p.list - p.btl;
          return (
            <article key={p.rank} className="dp-rt-card">
              <div
                className="dp-rt-thumb"
                style={{ ['--glass' as string]: c.glass, ['--ink' as string]: c.ink }}
              >
                <div className="dp-rt-plate">
                  <span>{p.brand}</span>
                  <span>{p.name}</span>
                </div>
                <button className="dp-rt-fav" aria-label="Save to favorites"><Star size={15} /></button>
              </div>
              <div className="dp-rt-body">
                <span className="dp-rt-dist">Fedway</span>
                <h4 className="dp-rt-name">{p.brand} {p.name}</h4>
                <span className="dp-rt-meta">{p.size} · {p.cat} · {p.proof}°</span>
                <div className="dp-rt-price">
                  <span className="dp-rt-btl">{money(p.btl)}</span>
                  <span className="dp-rt-list">{money(p.list)}</span>
                  <span className="dp-rt-save">Save {money(save)}/btl</span>
                </div>
                <DealTag deal={p.deal} />
                <button className="dp-rt-add"><ShoppingCart size={15} /> Add to cart</button>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}

/* ----------------------------------- Page shell ----------------------------------- */

export default function DistributorPromo() {
  const [view, setView] = useState<'distributor' | 'retail'>('distributor');
  return (
    <div className="dpromo" data-view={view}>
      <div className="dp-switchbar">
        <div className="dp-switch" role="tablist" aria-label="Preview mode">
          <button
            role="tab"
            aria-selected={view === 'distributor'}
            className={view === 'distributor' ? 'is-active' : ''}
            onClick={() => setView('distributor')}
          >
            <Newspaper size={15} /> Distributor view
          </button>
          <button
            role="tab"
            aria-selected={view === 'retail'}
            className={view === 'retail' ? 'is-active' : ''}
            onClick={() => setView('retail')}
          >
            <Eye size={15} /> Retail view
          </button>
        </div>
        <span className="dp-switch-note">Admin preview · Fedway · {EDITION}</span>
      </div>
      {view === 'distributor' ? <MagazineView /> : <RetailView />}
    </div>
  );
}
