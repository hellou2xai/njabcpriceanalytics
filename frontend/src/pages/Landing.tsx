import { useState, useEffect, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Sun, Moon, ArrowRight } from 'lucide-react';
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

const STEPS = [
  { n: '1', tag: '~90 sec', title: 'Create your free account',
    desc: 'Tell us your store and the categories you focus on. Spirits, wine, craft beer, whatever drives your floor. About 90 seconds.' },
  { n: '2', tag: 'Automatic', title: 'We ingest every CPL filed this month',
    desc: 'Allied. Fedway. Opici. R&R. The smaller filers too. All normalized by UPC and brand registration number, ready the first business day of the month.' },
  { n: '3', tag: 'Daily', title: 'You see one screen: every RIP, every bracket, every change',
    desc: 'Sortable by profit. Filterable by category, distributor, and expiration. Exportable as a printable buy list for your next rep visit.' },
];

export default function Landing() {
  const navigate = useNavigate();
  const { theme, toggle } = useTheme();
  const [email, setEmail] = useState('');

  const goSignup = (e?: string) =>
    navigate(`/login?signup=1${e ? `&email=${encodeURIComponent(e)}` : ''}`);

  const onSubscribe = (ev: FormEvent) => {
    ev.preventDefault();
    goSignup(email.trim() || undefined);
  };

  return (
    <div className="lp">
      {/* ---- Nav ---- */}
      <nav className="lp-nav">
        <div className="lp-container lp-nav-inner">
          <div className="lp-brand">
            <span className="lp-logo">C</span>
            <span className="lp-wordmark">CELR<span className="dot">.</span>ai</span>
            <span className="lp-brand-tag lp-hide-sm">NJ · Liquor Intelligence</span>
          </div>
          <div className="lp-nav-links">
            <a href="#capabilities" className="lp-navlink lp-hide-sm">Capabilities</a>
            <a href="#how" className="lp-navlink lp-hide-sm">How it works</a>
            <span className="lp-nav-sep lp-hide-sm" />
            <button className="sidebar-toggle" onClick={toggle} title="Toggle theme" aria-label="Toggle theme"
              style={{ display: 'inline-flex' }}>
              {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
            </button>
            <a className="lp-navlink" onClick={() => navigate('/login')} style={{ cursor: 'pointer' }}>Log in</a>
            <button className="btn" onClick={() => goSignup()}>Create account</button>
          </div>
        </div>
      </nav>

      {/* ---- Hero ---- */}
      <section className="lp-hero">
        <div className="lp-container lp-hero-grid">
          <div>
            <div className="lp-hero-head">
              <span className="lp-chip accent"><span className="lp-chip-dot" />Oct 2025 · eCPL template live</span>
              <span className="lp-hero-note">Built for Type 44 owners</span>
            </div>
            <h1 className="lp-h1">
              Every RIP you earned.<br />
              <span className="muted">Every dollar you missed.</span><br />
              In one place.
            </h1>
            <p className="lp-lead">
              CELR.ai turns the monthly pile of wholesaler price books into a daily action
              list for New Jersey liquor store owners. Buy smarter, price sharper, and claim
              every rebate the chains already do.
            </p>
            <div className="lp-cta-row">
              <button className="btn lp-btn-lg" onClick={() => goSignup()}>Create your free account</button>
              <a href="#capabilities" className="btn btn-secondary lp-btn-lg">See the 8 capabilities</a>
              <span className="lp-cta-note">Free during early access · No credit card</span>
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
            <span className="lp-strip-label">Ingesting CPLs from</span>
            <div className="lp-strip-names">
              <span>Allied Beverage</span><span className="lp-strip-sep">❖</span>
              <span>Fedway Associates</span><span className="lp-strip-sep">❖</span>
              <span>Opici Family</span><span className="lp-strip-sep">❖</span>
              <span>R&R Marketing</span><span className="lp-strip-sep">❖</span>
              <span className="muted">and every NJ filer</span>
            </div>
          </div>
        </div>
      </section>

      {/* ---- The pain ---- */}
      <section className="lp-section">
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
      <section id="capabilities" className="lp-section alt">
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
      <section id="how" className="lp-section">
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
      <section className="lp-section alt">
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

      {/* ---- Subscribe / CTA ---- */}
      <section id="subscribe" className="lp-section">
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
                liquor retailers. A U2xAI product.
              </p>
            </div>
            <div className="lp-footer-col">
              <h4>Product</h4>
              <ul>
                <li><a href="#capabilities">Capabilities</a></li>
                <li><a href="#how">How it works</a></li>
                <li><a onClick={() => goSignup()} style={{ cursor: 'pointer' }}>Create account</a></li>
                <li><a onClick={() => navigate('/login')} style={{ cursor: 'pointer' }}>Log in</a></li>
              </ul>
            </div>
            <div className="lp-footer-col">
              <h4>Resources</h4>
              <ul>
                <li>RIP regulation guide</li>
                <li>eCPL explainer</li>
                <li>Margin calculator</li>
              </ul>
            </div>
            <div className="lp-footer-col">
              <h4>Contact</h4>
              <ul>
                <li>hello@celr.ai</li>
                <li>New Jersey, USA</li>
              </ul>
            </div>
          </div>
          <div className="lp-footer-bottom">
            <span>© 2026 CELR.ai · A U2xAI product</span>
            <span>Built for Type 44 owners, by NJ liquor operators</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
