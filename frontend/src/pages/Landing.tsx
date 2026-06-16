import { useState, useEffect, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Sun, Moon, ArrowRight, Store, Truck, Factory, Menu, X, Check,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import WhatsAppShareButton from '../components/WhatsAppShare';
import { shareOnWhatsAppCached } from '../lib/share';
import './Landing.css';

// Same behaviour as the app's theme toggle: persist to localStorage and set
// data-theme on <html>. Lives here too so the landing (which renders outside
// the app Layout) respects the saved theme and can switch it.
function useTheme() {
  const [theme, setTheme] = useState<'dark' | 'light'>(
    () => (localStorage.getItem('theme') as 'dark' | 'light') ?? 'light',
  );
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);
  return { theme, toggle: () => setTheme(t => (t === 'dark' ? 'light' : 'dark')) };
}

const CAPABILITIES = [
  { n: '01', badge: '+15-25%', feature: false, title: 'Catch every RIP dollar',
    desc: 'We ingest every wholesaler CPL on day one of the month and surface the rebates matched to what your store actually buys. The dollars you never knew were yours.' },
  { n: '02', badge: 'Tiered RIPs', feature: false, title: 'See the bracket math before you order',
    desc: '5 cases at $2 off. 10 cases at $5 off. We surface every bracket on every SKU, so you know exactly what stretching one more case is worth. Decide before you place the order, not after.' },
  { n: '03', badge: 'True cost', feature: false, title: 'Price from real landed cost',
    desc: 'Once the RIP, post-off, and depletion allowance are netted against the posted price, we recommend a shelf price that hits your target margin. No more stale shelf talkers eating the rebate.' },
  { n: '04', badge: 'Stack ×3', feature: false, title: 'Stack every available deal',
    desc: 'One SKU can carry a state post-off, a wholesaler RIP, and a manufacturer combo at the same time. We flag every stackable opportunity and rank your top profit SKUs for the month.' },
  { n: '05', badge: '5-day alert', feature: false, title: 'Never miss a deal expiration',
    desc: 'RIPs run monthly or quarterly and revert silently. We build a forward calendar of every deal you care about and ping you 5 days before it disappears.' },
  { n: '06', badge: 'MoM tracking', feature: false, title: 'Spot every price change instantly',
    desc: 'When the new CPL drops on the 15th, we diff it against last month and surface every increase, decrease, new RIP, and dropped deal. Know what changed before your competitors do.' },
  { n: '07', badge: 'eCPL ready', feature: false, title: 'All wholesaler CPLs, one view',
    desc: 'As of October 2025, NJ ABC mandates a uniform eCPL template. We ingest every filer, normalize by UPC, and put the entire state’s wholesale market in one searchable view.' },
  { n: '08', badge: 'Chain parity', feature: true, title: 'Compete on equal footing with the chains',
    desc: 'NJ regulation guarantees you the same RIPs the chains qualify for through small-quantity tiers. They have analyst teams. You now have the same firepower in your back office, without the headcount.' },
];

// Who it's for: the SAME public-filings engine, tuned to each side of NJ's
// three-tier market. Each role gets its own dedicated section on the page with
// its own heading, value props and a role-specific product mock. Buyers is the
// live product (sign up); distributors and producers get a talk-to-us CTA.
interface PanelRow { k: string; v: string; hi?: boolean }
interface DeepDive {
  label: string; heading: string; intro: string; points: string[];
  panel: { title: string; rows: PanelRow[] };
}
interface Role {
  key: string; anchor: string; Icon: LucideIcon; tab: string; primary?: boolean;
  kicker: string; title: string; blurb: string; points: string[];
  ctaLabel: string; cta: 'signup' | 'mail';
  visual: 'buyers' | 'distributors' | 'producers';
  outcome?: { stat: string; label: string };
  features?: { title: string; desc: string }[];
  deepDive?: DeepDive;
}

const ROLES: Role[] = [
  {
    key: 'buyers', anchor: 'for-buyers', Icon: Store, tab: 'Buyers',
    kicker: 'For Retailers & Licensees', primary: true,
    title: 'Buy smarter every edition',
    blurb: 'The live product today. CELR reads all 400-plus pages of every price book for you and instantly surfaces the hidden deals, stacked rebates and RIP brackets you would never find with a highlighter. Most stores uncover at least $5,000 a month in savings they were missing.',
    points: [
      'Most buyers uncover at least $5,000 a month in deals and savings they were missing, from day one.',
      'Hidden deals surfaced automatically: stacked post-offs, RIP brackets and combos you would never catch reading by hand.',
      'True landed cost on every SKU: list minus every discount minus your best RIP rebate, not the sticker.',
      'The whole RIP program decoded: tiered brackets, monthly-recycled codes, break-even and profit % per case.',
      'Compare Allied, Fedway, Opici and every filer on the same UPC, side by side.',
      'Smart search that knows brand aliases, misspellings and barcodes, plus an alert the day each new edition lands.',
      'Ask in plain English or by voice: the built-in assistant answers from your live data.',
    ],
    ctaLabel: 'Create your free account', cta: 'signup',
    visual: 'buyers',
    outcome: { stat: '$5,000+', label: 'saved a month by most buyers, from instant deal and savings spotting' },
    features: [
      { title: 'Smart catalog & landed cost', desc: 'Every SKU shows its true landed cost and full RIP ladder. Search by brand alias, misspelling or barcode and land on the right product.' },
      { title: 'Compare Prices & RIPs', desc: 'Allied, Fedway, Opici and every filer on the same UPC, side by side. See whose rebate actually wins at the volume you buy.' },
      { title: 'Edition tracking & alerts', desc: 'Month-over-month price drops, increases and new items, plus an alert the day a new edition lands and before a rebate expires.' },
    ],
  },
  {
    key: 'distributors', anchor: 'for-distributors', Icon: Truck, tab: 'Distributors',
    kicker: 'For Wholesalers & Distributors',
    title: 'Win more of the order',
    blurb: 'Buyers compare every filer before they order. CELR shows where your after-rebate price already wins and where you are leaving sales on the table, so your reps walk in and close more cases.',
    points: [
      'Win at the moment of decision: buyers see your real after-rebate value the instant they compare, so the order tips your way.',
      'Grow volume on the SKUs where your effective price already beats the field. Push them instead of discounting.',
      'Win back accounts you are quietly losing: every shared UPC where a competitor undercuts you, ready to fix.',
      'Arm your reps with the same numbers the buyer sees, so every visit is a closing conversation, not a price-book read.',
    ],
    ctaLabel: 'Talk to us', cta: 'mail',
    visual: 'distributors',
    outcome: { stat: 'Win the order', label: 'the moment buyers compare your after-rebate value' },
    features: [
      { title: 'Win at the point of comparison', desc: 'Buyers see your real after-rebate value next to every other filer. When you lead, the order comes to you instead of the competitor.' },
      { title: 'Grow your strong SKUs', desc: 'Find the SKUs where your effective price already beats the field and push volume there, instead of cutting price across the book.' },
      { title: 'Win back lost accounts', desc: 'See every shared UPC where a competitor is undercutting you and close the gap before the next filing locks the order in.' },
    ],
    deepDive: {
      label: 'Find the sales you are leaving on the table',
      heading: 'See where you win the order, and where you lose it',
      intro: 'Every buyer on CELR compares your posted price and RIP against every other filer on the same UPC. The SKUs you win are orders to lock in. The ones you trail are accounts to win back.',
      points: [
        'The SKUs where your effective price already wins: push these for more volume, no extra discount needed.',
        'The exact per-bottle gap to the leading filer on every SKU you trail, so you know what it takes to win the order.',
        'Whether your RIP brackets are actually reachable for the small stores, where most of the unclaimed volume sits.',
        'A month-over-month diff of your own book against the field, so a price move never quietly costs you sales.',
      ],
      panel: {
        title: 'This month · shared SKUs',
        rows: [
          { k: 'SKUs compared', v: '240' },
          { k: 'Orders you win on price', v: '168', hi: true },
          { k: 'Within 1% (winnable)', v: '41' },
          { k: 'Win-back targets', v: '31' },
        ],
      },
    },
  },
  {
    key: 'producers', anchor: 'for-producers', Icon: Factory, tab: 'Producers & Brands',
    kicker: 'For Producers & Brands',
    title: 'Sell more, edition after edition',
    blurb: 'Your sales depend on how every distributor prices and promotes you. CELR shows where your brand is winning the shelf and where weak pricing or low RIP participation is quietly costing you volume, statewide.',
    points: [
      'Grow sell-through by making sure each distributor’s RIP actually reaches retailer cost, not just the price book.',
      'Find the distributors and sizes under-pricing or under-promoting you, the gaps costing you real volume.',
      'Protect sales from data errors: catch pack, price and vintage mistakes under your UPCs before they suppress orders.',
      'Win category share with benchmarks by size, pack and vintage that show exactly where to push.',
    ],
    ctaLabel: 'Request a brand briefing', cta: 'mail',
    visual: 'producers',
    outcome: { stat: 'Grow depletions', label: 'by closing the pricing and promo gaps that cost you volume' },
    features: [
      { title: 'Drive pull-through', desc: 'Make sure each distributor’s RIP reaches retailer cost, so the rebate becomes real sell-through instead of margin that stops at the warehouse.' },
      { title: 'Find the volume gaps', desc: 'Spot the distributors and sizes that under-price or under-promote your brand and recover the sales they are costing you.' },
      { title: 'Protect & grow share', desc: 'Catch UPC data errors before they suppress orders, and benchmark by size, pack and vintage to win category share.' },
    ],
    deepDive: {
      label: 'Turn shelf visibility into sales',
      heading: 'Follow your brand from filing to shelf to sell-through',
      intro: 'You set the registration and the suggested price. CELR shows what each distributor actually does with it, and where that is winning you volume or quietly costing it, edition after edition.',
      points: [
        'Every distributor carrying each SKU, and whether their pricing helps it sell or leaves it on the shelf.',
        'RIP participation and rebate depth by size and pack, so you can push the programs that actually move cases.',
        'Edition-over-edition movement in your real cost to the retailer, the number that drives reorders.',
        'Pack, price and vintage errors filed under your UPCs, flagged before they suppress orders across the market.',
      ],
      panel: {
        title: 'June 2026 · your portfolio',
        rows: [
          { k: 'Distributors carrying', v: '4 of 5' },
          { k: 'SKUs tracked', v: '37' },
          { k: 'Avg RIP participation', v: '61%', hi: true },
          { k: 'Volume gaps to fix', v: '3' },
        ],
      },
    },
  },
];

const STEPS = [
  { n: '1', tag: '~90 sec', title: 'Create your free account',
    desc: 'Tell us your store and the categories you focus on. Spirits, wine, craft beer, whatever drives your floor. About 90 seconds.' },
  { n: '2', tag: 'Automatic', title: 'We ingest every CPL filed this month',
    desc: 'Allied. Fedway. Opici. R&R. The smaller filers too. All normalized by UPC and brand registration number, ready the first business day of the month.' },
  { n: '3', tag: 'Daily', title: 'You see one screen: every RIP, every bracket, every change',
    desc: 'Sortable by profit. Filterable by category, distributor, and expiration. Exportable as a printable buy list for your next rep visit.' },
];

// ---- Role-specific product mocks (pure CSS/markup, no images) ----------------
function RoleVisual({ kind }: { kind: 'buyers' | 'distributors' | 'producers' }) {
  if (kind === 'buyers') {
    return (
      <div className="lp-mock" aria-hidden>
        <div className="lp-mock-head">
          <span className="lp-mock-title">Tito's Handmade Vodka 1.75L</span>
          <span className="lp-mock-pill">UPC · 619947000020</span>
        </div>
        <div className="lp-mock-rows">
          <div className="lp-mock-row"><span>List price</span><span className="mono">$28.99</span></div>
          <div className="lp-mock-row"><span>Post-off + depletion</span><span className="mono">− $2.10</span></div>
          <div className="lp-mock-row"><span>Best RIP (10 cs @ $3.25)</span><span className="mono accent">− $3.25</span></div>
          <div className="lp-mock-row total"><span>True landed cost</span><span className="mono">$23.64</span></div>
        </div>
        <div className="lp-mock-ladder">
          <div className="lp-mock-ladder-lbl">RIP ladder</div>
          <div className="lp-mock-bars">
            <div className="lp-bar"><span className="fill" style={{ height: '38%' }} /><b>5 cs</b><i>$1.80</i></div>
            <div className="lp-bar win"><span className="fill" style={{ height: '70%' }} /><b>10 cs</b><i>$3.25</i></div>
            <div className="lp-bar"><span className="fill" style={{ height: '94%' }} /><b>15 cs</b><i>$4.40</i></div>
          </div>
        </div>
      </div>
    );
  }
  if (kind === 'distributors') {
    return (
      <div className="lp-mock" aria-hidden>
        <div className="lp-mock-head">
          <span className="lp-mock-title">Effective price · same UPC</span>
          <span className="lp-mock-pill">Glenlivet 12yr 750mL</span>
        </div>
        <div className="lp-cmp">
          <div className="lp-cmp-row win">
            <span className="who">You</span>
            <span className="track"><span className="fill" style={{ width: '62%' }} /></span>
            <span className="mono">$31.10</span>
            <span className="lp-cmp-badge">Best</span>
          </div>
          <div className="lp-cmp-row">
            <span className="who">Filer B</span>
            <span className="track"><span className="fill" style={{ width: '78%' }} /></span>
            <span className="mono">$33.40</span>
          </div>
          <div className="lp-cmp-row">
            <span className="who">Filer C</span>
            <span className="track"><span className="fill" style={{ width: '90%' }} /></span>
            <span className="mono">$35.05</span>
          </div>
        </div>
        <div className="lp-mock-foot">
          <span>After every discount and RIP, per bottle</span>
          <span className="accent">You win on 18 of 24 shared SKUs</span>
        </div>
      </div>
    );
  }
  return (
    <div className="lp-mock" aria-hidden>
      <div className="lp-mock-head">
        <span className="lp-mock-title">Your brand, statewide</span>
        <span className="lp-mock-pill">June 2026 edition</span>
      </div>
      <div className="lp-mock-rows">
        <div className="lp-mock-row"><span>Distributors carrying</span><span className="mono">4 of 5</span></div>
        <div className="lp-mock-row"><span>SKUs tracked</span><span className="mono">37</span></div>
        <div className="lp-mock-row"><span>RIP participation</span><span className="mono accent">61%</span></div>
        <div className="lp-mock-row"><span>Avg retailer landed Δ</span><span className="mono">− $2.84</span></div>
      </div>
      <div className="lp-mock-ladder">
        <div className="lp-mock-ladder-lbl">RIP participation by size</div>
        <div className="lp-mock-bars">
          <div className="lp-bar"><span className="fill" style={{ height: '52%' }} /><b>750</b><i>52%</i></div>
          <div className="lp-bar win"><span className="fill" style={{ height: '78%' }} /><b>1.0L</b><i>78%</i></div>
          <div className="lp-bar"><span className="fill" style={{ height: '40%' }} /><b>1.75</b><i>40%</i></div>
        </div>
      </div>
    </div>
  );
}

export default function Landing() {
  const navigate = useNavigate();
  const { theme, toggle } = useTheme();
  const [email, setEmail] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);

  // Lock body scroll while the mobile drawer is open.
  useEffect(() => {
    document.body.style.overflow = menuOpen ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [menuOpen]);

  const goSignup = (e?: string) =>
    navigate(`/login?signup=1${e ? `&email=${encodeURIComponent(e)}` : ''}`);

  const mailTo = (who: string) =>
    `mailto:hello@celr.ai?subject=${encodeURIComponent(`CELR for ${who}`)}`;

  const onSubscribe = (ev: FormEvent) => {
    ev.preventDefault();
    goSignup(email.trim() || undefined);
  };

  // Smooth-scroll to an in-page anchor and close the mobile drawer.
  const jumpTo = (id: string) => {
    setMenuOpen(false);
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // One dedicated role area: headline + value props + product mock + feature
  // trio, and (for distributors / brands) a second deep-dive band.
  const renderRole = (r: Role, opts: { reverse: boolean; alt: boolean }) => (
    <section key={r.key} id={r.anchor} className={`lp-section lp-role${opts.alt ? ' alt' : ''}`}>
      <div className={`lp-container lp-role-grid${opts.reverse ? ' reverse' : ''}`}>
        <div className="lp-role-copy">
          <div className="lp-role-kicker">
            <span className="lp-role-icon"><r.Icon size={18} /></span>
            <span className="section-label">{r.kicker}</span>
            {r.primary
              ? <span className="lp-role-badge live">Live now</span>
              : <span className="lp-role-badge">Early access</span>}
          </div>
          <h2 className="lp-role-title">{r.title}</h2>
          <p className="lp-role-blurb">{r.blurb}</p>
          <ul className="lp-role-list">
            {r.points.map((p, j) => (
              <li key={j}><span className="mk"><Check size={15} /></span><span>{p}</span></li>
            ))}
          </ul>
          {r.cta === 'signup' ? (
            <button className="btn lp-btn-lg lp-role-cta" onClick={() => goSignup()}>
              {r.ctaLabel} <ArrowRight size={16} />
            </button>
          ) : (
            <a className="btn btn-secondary lp-btn-lg lp-role-cta" href={mailTo(r.kicker)}>
              {r.ctaLabel} <ArrowRight size={16} />
            </a>
          )}
        </div>
        <div className="lp-role-visual">
          <RoleVisual kind={r.visual} />
          {r.outcome && (
            <div className="lp-role-outcome">
              <span className="lp-role-outcome-stat">{r.outcome.stat}</span>
              <span className="lp-role-outcome-label">{r.outcome.label}</span>
            </div>
          )}
        </div>
      </div>

      {r.features && (
        <div className="lp-container lp-role-features">
          {r.features.map((f, k) => (
            <div key={k} className="lp-role-feature">
              <span className="lp-rf-ico"><Check size={16} /></span>
              <h4>{f.title}</h4>
              <p>{f.desc}</p>
            </div>
          ))}
        </div>
      )}

      {r.deepDive && (
        <div className={`lp-container lp-dd-grid${opts.reverse ? '' : ' reverse'}`}>
          <div className="lp-dd-copy">
            <div className="section-label" style={{ color: 'var(--accent)' }}>{r.deepDive.label}</div>
            <h3 className="lp-dd-h">{r.deepDive.heading}</h3>
            <p className="lp-dd-intro">{r.deepDive.intro}</p>
            <ul className="lp-role-list">
              {r.deepDive.points.map((p, j) => (
                <li key={j}><span className="mk"><Check size={15} /></span><span>{p}</span></li>
              ))}
            </ul>
          </div>
          <div className="lp-role-visual">
            <div className="lp-mock">
              <div className="lp-mock-head">
                <span className="lp-mock-title">{r.deepDive.panel.title}</span>
              </div>
              <div className="lp-mock-rows">
                {r.deepDive.panel.rows.map((row, j) => (
                  <div key={j} className="lp-mock-row">
                    <span>{row.k}</span>
                    <span className={`mono${row.hi ? ' accent' : ''}`}>{row.v}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );

  return (
    <div className="lp">
      {/* ---- Nav ---- */}
      <nav className="lp-nav">
        <div className="lp-container lp-nav-inner">
          <div className="lp-brand" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })} style={{ cursor: 'pointer' }}>
            <span className="lp-logo">C</span>
            <span className="lp-wordmark">CELR<span className="dot">.</span>ai</span>
            <span className="lp-brand-tag lp-hide-sm">NJ · Liquor Intelligence</span>
          </div>

          {/* Role-led primary nav (Provi-style), centered between logo and actions */}
          <div className="lp-nav-center lp-hide-md">
            <a className="lp-navlink" onClick={() => jumpTo('for-buyers')}>Buyers</a>
            <a className="lp-navlink" onClick={() => jumpTo('for-distributors')}>Distributors</a>
            <a className="lp-navlink" onClick={() => jumpTo('for-producers')}>Producers &amp; Brands</a>
            <a className="lp-navlink" onClick={() => jumpTo('capabilities')}>Capabilities</a>
            <a className="lp-navlink" onClick={() => jumpTo('how')}>How it works</a>
          </div>

          <div className="lp-nav-actions">
            <WhatsAppShareButton className="sidebar-toggle lp-hide-sm" showLabel={false}
              title="Share via WhatsApp" source="landing-nav" />
            <button className="sidebar-toggle lp-theme-toggle" onClick={toggle} title="Toggle theme" aria-label="Toggle theme"
              style={{ display: 'inline-flex' }}>
              {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
            </button>
            <a className="lp-navlink lp-login lp-hide-sm" onClick={() => navigate('/login')} style={{ cursor: 'pointer' }}>Log in</a>
            <button className="btn lp-signup lp-hide-sm" onClick={() => goSignup()}>Sign up</button>

            {/* Hamburger, phones/tablets only */}
            <button className="sidebar-toggle lp-burger" onClick={() => setMenuOpen(o => !o)}
              aria-label="Menu" aria-expanded={menuOpen} style={{ display: 'none' }}>
              {menuOpen ? <X size={20} /> : <Menu size={20} />}
            </button>
          </div>
        </div>
      </nav>

      {/* ---- Mobile drawer ---- */}
      {menuOpen && (
        <div className="lp-drawer" role="dialog" aria-modal="true">
          <button className="lp-drawer-scrim" aria-label="Close menu" onClick={() => setMenuOpen(false)} />
          <div className="lp-drawer-panel">
            <a onClick={() => jumpTo('roles')}>Who it's for</a>
            <a onClick={() => jumpTo('for-buyers')} className="sub">For Buyers</a>
            <a onClick={() => jumpTo('for-distributors')} className="sub">For Distributors</a>
            <a onClick={() => jumpTo('for-producers')} className="sub">For Producers &amp; Brands</a>
            <a onClick={() => jumpTo('capabilities')}>Capabilities</a>
            <a onClick={() => jumpTo('how')}>How it works</a>
            <div className="lp-drawer-rule" />
            <a onClick={() => { setMenuOpen(false); navigate('/login'); }}>Log in</a>
            <button className="btn lp-drawer-cta" onClick={() => { setMenuOpen(false); goSignup(); }}>
              Create your free account <ArrowRight size={16} />
            </button>
            <a className="lp-drawer-share" onClick={() => { setMenuOpen(false); shareOnWhatsAppCached('landing-drawer'); }}>Share via WhatsApp</a>
          </div>
        </div>
      )}

      {/* ---- Hero ---- */}
      <section className="lp-hero">
        <div className="lp-container lp-hero-grid">
          <div>
            <div className="lp-hero-head">
              <span className="lp-chip accent"><span className="lp-chip-dot" />Built for New Jersey's liquor trade</span>
            </div>
            <h1 className="lp-h1">
              Every deal, spotted.<br />
              <span className="muted">Every margin, protected.</span><br />
              Every RIP, claimed.
            </h1>
            <p className="lp-lead">
              CELR.ai turns the monthly pile of wholesaler price books into a daily action list
              for New Jersey's liquor trade. Spot the right opportunities faster, protect
              your margins, and uncover rebates and profits you may be missing.
            </p>
            <div className="lp-cta-row">
              <button className="btn lp-btn-lg" onClick={() => goSignup()}>Create your free account</button>
              <a href="#roles" className="btn btn-secondary lp-btn-lg" onClick={(e) => { e.preventDefault(); jumpTo('roles'); }}>Find your role</a>
            </div>
            <div className="lp-trust">
              <span className="lp-trust-item hot"><Check size={15} /> Free during early access</span>
              <span className="lp-trust-item"><Check size={15} /> No credit card</span>
              <span className="lp-trust-item"><Check size={15} /> 90-second setup</span>
            </div>
          </div>

          <div className="lp-stats">
            <div className="lp-stat">
              <div className="lp-stat-num accent">15-25<span className="sm">%</span></div>
              <div className="lp-stat-label">Rebates typically missed</div>
            </div>
            <div className="lp-stat">
              <div className="lp-stat-num">~400</div>
              <div className="lp-stat-label">Pages per CPL, per month</div>
            </div>
            <div className="lp-stat">
              <div className="lp-stat-num">70<span className="sm">%</span></div>
              <div className="lp-stat-label">Wine via Allied + Fedway</div>
            </div>
            <div className="lp-stat">
              <div className="lp-stat-num accent">$100M<span className="sm">+</span></div>
              <div className="lp-stat-label">Annual NJ RIPs flowing</div>
            </div>
          </div>
        </div>

        <div className="lp-strip">
          <div className="lp-container lp-strip-inner">
            <span className="lp-strip-label">Ingesting CPLs for</span>
            <div className="lp-strip-names">
              <span>Allied Beverage</span><span className="lp-strip-sep">❖</span>
              <span>Fedway Associates</span><span className="lp-strip-sep">❖</span>
              <span>Opici Family</span><span className="lp-strip-sep">❖</span>
              <span className="muted">Every major NJ Filer</span>
            </div>
          </div>
        </div>
      </section>

      {/* ---- Who it's for: role selector ---- */}
      <section id="roles" className="lp-section alt lp-roles-intro">
        <div className="lp-container">
          <div className="section-label" style={{ color: 'var(--accent)' }}>Who it's for</div>
          <h2 className="lp-section-h2">
            One source of truth for <span className="muted">every side of the NJ market.</span>
          </h2>
          <p className="lp-roles-sub">
            CELR decodes New Jersey's monthly ABC price filings and the RIP rebate program down to
            the case. One engine, a dedicated view for each tier. Pick yours.
          </p>
          <div className="lp-role-tabs">
            {ROLES.map(r => (
              <a key={r.key} className={`lp-role-tab${r.primary ? ' primary' : ''}`}
                onClick={() => jumpTo(r.anchor)}>
                <span className="lp-role-tab-icon"><r.Icon size={18} /></span>
                <span className="lp-role-tab-text">
                  <b>{r.tab}</b>
                  <i>{r.primary ? 'Live now' : 'Talk to us'}</i>
                </span>
              </a>
            ))}
          </div>
        </div>
      </section>

      {/* ---- Buyers: the live product. All retail-store content lives under here. ---- */}
      {renderRole(ROLES[0], { reverse: false, alt: false })}

      {/* ---- The pain (retail / buyer) ---- */}
      <section className="lp-section alt">
        <div className="lp-container lp-pain-grid">
          <div>
            <div className="section-label" style={{ color: 'var(--accent)' }}>The old way</div>
            <h2 className="lp-section-h2">
              A highlighter, a calculator, and <span className="muted">three hours after closing.</span>
            </h2>
            <p>
              Every month, NJ wholesalers file a Current Price List with the state. Allied and
              Fedway alone run 300 to 400 pages each. Buried inside are the RIPs, post-offs, and
              small-quantity tiers that set your real cost on every bottle.
            </p>
            <p>
              Most independent owners read it the way they did in 1992. Page by page, with a
              yellow marker.
            </p>
          </div>
          <div className="lp-doc">
            <div className="lp-doc-head">
              <div>
                <div className="lp-doc-title">ALLIED BEVERAGE GROUP</div>
                <div className="lp-doc-sub">Current Price List · November 2025</div>
              </div>
              <div className="lp-doc-page">Page 247 of 392</div>
            </div>
            <div className="lp-doc-lines">
              <div className="lp-doc-row">
                <span className="name">Tito's Handmade Vodka 1.75L</span>
                <span className="val">$28.99 / btl</span>
              </div>
              <div className="lp-doc-row hit green">
                <span className="name">↪ RIP: 10 cases @ $3.25 rebate</span>
                <span className="val">save $195</span>
              </div>
              <div className="lp-doc-row">
                <span className="name">Tito's Handmade Vodka 750mL</span>
                <span className="val">$14.49 / btl</span>
              </div>
              <div className="lp-doc-row hit">
                <span className="name">↪ Small qty RIP: 3 cases @ $1.10 rebate</span>
                <span className="val">small store eligible</span>
              </div>
            </div>
            <div className="lp-doc-foot">
              <span>… and 4,200 more line items this month</span>
              <span>N.J.A.C. 13:2-24.1</span>
            </div>
          </div>
        </div>
      </section>

      {/* ---- Capabilities ---- */}
      <section id="capabilities" className="lp-section">
        <div className="lp-container">
          <div className="lp-caps-head">
            <div>
              <div className="section-label" style={{ color: 'var(--accent)' }}>The new way</div>
              <h2 className="lp-section-h2">
                Eight things your store <span className="muted">starts doing in week one.</span>
              </h2>
            </div>
            <p className="intro">
              Every capability is live the day you sign up. No setup calls, no spreadsheets,
              just answers.
            </p>
          </div>

          <div className="lp-caps-grid">
            {CAPABILITIES.map(c => (
              <div key={c.n} className={`lp-cap${c.feature ? ' feature' : ''}`}>
                <div className="lp-cap-top">
                  <span className="lp-cap-num">{c.n}</span>
                  <span className={`tag ${c.feature ? 'tag-blue' : 'tag-gray'}`}>{c.badge}</span>
                </div>
                <h3 className="lp-cap-title">{c.title}</h3>
                <div className="lp-cap-rule" />
                <p className="lp-cap-desc">{c.desc}</p>
              </div>
            ))}
          </div>

          <div className="lp-caps-foot">
            <span className="rule" />
            <span>Backed by NJ ABC public filings · N.J.A.C. 13:2-24.1 · AN-2025-03</span>
            <span className="rule" />
          </div>
        </div>
      </section>

      {/* ---- How it works ---- */}
      <section id="how" className="lp-section alt">
        <div className="lp-container lp-how-grid">
          <div>
            <div className="section-label" style={{ color: 'var(--accent)' }}>How it works</div>
            <h2 className="lp-section-h2">Three steps. <span className="muted">One coffee.</span></h2>
            <p className="lead">
              No POS integration. No installs. No data migration. CELR.ai is a pure analytics
              layer on top of public NJ ABC filings, ready the moment you sign up.
            </p>
          </div>
          <div className="lp-steps">
            {STEPS.map(s => (
              <div key={s.n} className="lp-step">
                <span className="lp-step-num">{s.n}</span>
                <div style={{ flex: 1 }}>
                  <div className="lp-step-title">{s.title}</div>
                  <div className="lp-step-desc">{s.desc}</div>
                </div>
                <span className="lp-step-tag">{s.tag}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ---- Testimonial ---- */}
      <section className="lp-section">
        <div className="lp-container lp-quote-wrap">
          <div className="lp-quote-mark">❖</div>
          <blockquote className="lp-quote">
            <span className="muted">"We were leaving roughly $42,000 a year on the table in unclaimed RIPs
            and quantity tiers we kept missing by one case.</span> First quarter on CELR.ai paid the
            subscription for the next decade."
          </blockquote>
          <div className="lp-quote-by">Pilot owner · Bergen County · 3-store group</div>
        </div>
      </section>

      {/* ---- Other roles: distributors and producers/brands, each with depth ---- */}
      {renderRole(ROLES[1], { reverse: true, alt: true })}
      {renderRole(ROLES[2], { reverse: false, alt: true })}

      {/* ---- Subscribe / CTA ---- */}
      <section id="subscribe" className="lp-section alt">
        <div className="lp-container lp-cta-grid">
          <div>
            <div className="section-label" style={{ color: 'var(--accent)' }}>Early access</div>
            <h2 className="lp-section-h2">
              The next CPL drops on the 15th. <span className="muted">Be ready for it.</span>
            </h2>
            <p>
              CELR.ai is free for New Jersey store owners during early access. We are building
              this with the operators who use it. No subscription, no card, no catch.
            </p>
            <p>
              In return, we ask for one thing: tell us what is working, what is broken, and what
              should come next.
            </p>
            <div className="lp-cta-bullets">
              <span><span className="mk">❖</span> 90-second setup</span>
              <span><span className="mk">❖</span> NJ owned and operated</span>
              <span><span className="mk">❖</span> Direct line to the founders</span>
            </div>
          </div>

          <div className="lp-form-card">
            <div className="lp-form-top">
              <span className="lp-form-eyebrow">CELR.ai Early Access</span>
              <span className="lp-form-eyebrow" style={{ color: 'var(--accent)' }}>Limited spots</span>
            </div>
            <div className="lp-form-price">
              <span className="big">Free</span>
              <span className="note">while in beta</span>
            </div>
            <div className="lp-form-sub">Full access · All 8 capabilities included</div>
            <form onSubmit={onSubscribe}>
              <label className="lp-field">
                <span>Store name</span>
                <input className="lp-input" type="text" placeholder="e.g. Hudson Wine & Spirits" />
              </label>
              <label className="lp-field">
                <span>Email</span>
                <input className="lp-input" type="email" placeholder="owner@yourstore.com"
                  value={email} onChange={e => setEmail(e.target.value)} />
              </label>
              <label className="lp-field">
                <span>License number (optional)</span>
                <input className="lp-input" type="text" placeholder="0000-44-001-000"
                  style={{ fontFamily: 'var(--font-mono)' }} />
              </label>
              <button type="submit" className="btn lp-form-btn">
                Create my free account <ArrowRight size={16} />
              </button>
            </form>
            <div className="lp-form-foot">
              Already a member?{' '}
              <a onClick={() => navigate('/login')} style={{ color: 'var(--accent)', cursor: 'pointer' }}>Log in</a>
            </div>
          </div>
        </div>
      </section>

      {/* ---- Footer ---- */}
      <footer className="lp-footer">
        <div className="lp-container lp-footer-inner">
          <div className="lp-footer-grid">
            <div>
              <div className="lp-brand">
                <span className="lp-logo">C</span>
                <span className="lp-wordmark">CELR<span className="dot">.</span>ai</span>
              </div>
              <p className="lp-footer-blurb">
                The pricing and rebate intelligence platform built for New Jersey's independent
                liquor retailers.
              </p>
            </div>
            <div className="lp-footer-col">
              <h4>Who it's for</h4>
              <ul>
                <li><a onClick={() => jumpTo('for-buyers')} style={{ cursor: 'pointer' }}>For Buyers</a></li>
                <li><a onClick={() => jumpTo('for-distributors')} style={{ cursor: 'pointer' }}>For Distributors</a></li>
                <li><a onClick={() => jumpTo('for-producers')} style={{ cursor: 'pointer' }}>For Producers &amp; Brands</a></li>
              </ul>
            </div>
            <div className="lp-footer-col">
              <h4>Product</h4>
              <ul>
                <li><a onClick={() => jumpTo('capabilities')} style={{ cursor: 'pointer' }}>Capabilities</a></li>
                <li><a onClick={() => jumpTo('how')} style={{ cursor: 'pointer' }}>How it works</a></li>
                <li><a onClick={() => goSignup()} style={{ cursor: 'pointer' }}>Create account</a></li>
                <li><a onClick={() => navigate('/login')} style={{ cursor: 'pointer' }}>Log in</a></li>
                <li><a onClick={() => shareOnWhatsAppCached('landing-footer')} style={{ cursor: 'pointer' }}>Share via WhatsApp</a></li>
              </ul>
            </div>
            <div className="lp-footer-col">
              <h4>Legal</h4>
              <ul>
                <li><a onClick={() => navigate('/terms')} style={{ cursor: 'pointer' }}>Terms of Service</a></li>
                <li><a onClick={() => navigate('/privacy')} style={{ cursor: 'pointer' }}>Privacy Policy</a></li>
                <li><a onClick={() => window.dispatchEvent(new Event('celr:cookie-preferences'))} style={{ cursor: 'pointer' }}>Cookie preferences</a></li>
              </ul>
            </div>
          </div>
          <div className="lp-footer-bottom">
            <span>© 2026 CELR.ai</span>
            <span className="lp-footer-legal">
              <a onClick={() => navigate('/terms')} style={{ cursor: 'pointer' }}>Terms</a>
              <a onClick={() => navigate('/privacy')} style={{ cursor: 'pointer' }}>Privacy</a>
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
}
