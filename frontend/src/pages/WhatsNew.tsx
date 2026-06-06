/**
 * What's New for You — the personalized monthly digest.
 *
 * Exploits the monthly edition cadence: the moment a new edition lands, this
 * page shows ONLY what changed for the products this buyer tracks (Favorites +
 * Cart + Lists) — expiring RIPs, new/deeper/lost rebates, target-price hits,
 * buy-before-a-rise — plus a savings tally. All intelligence comes from the
 * backend /whats-new engine (deal_compare + the cart savings analyzer). Themed
 * to match the Products page.
 */
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Sparkles, Clock, CalendarClock, BadgeDollarSign, TrendingUp, TrendingDown,
  Target, ArrowDownRight, Store, PiggyBank, Star, ShoppingCart, ClipboardList, Info,
} from 'lucide-react';
import { digest, type DigestCard, type WhatsNew as WhatsNewData } from '../lib/api';
import ProductThumb from '../components/ProductThumb';
import PriceSparklines from '../components/PriceSparklines';
import PartialSticker from '../components/PartialSticker';
import SavingsAnalysis from '../components/SavingsAnalysis';
import { buildMonths } from '../lib/promotionsSparkline';
import { distributorName, abgSku, skuLabel } from '../lib/distributors';

const money = (n?: number | null) =>
  n == null ? '—' : `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const money0 = (n?: number | null) =>
  n == null ? '—' : `$${Math.round(n).toLocaleString()}`;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function editionLabel(ed?: string | null): string {
  if (!ed) return '';
  const m = /^(\d{4})-(\d{1,2})/.exec(ed);
  return m ? `${MONTHS[+m[2] - 1] ?? ''} ${m[1]}` : ed;
}

function detailUrl(c: DigestCard): string {
  const q = new URLSearchParams({ w: c.wholesaler, n: c.product_name });
  if (c.upc) q.set('u', String(c.upc));
  return `/product?${q.toString()}`;
}

const SOURCE_ICON: Record<string, typeof Star> = { favorite: Star, cart: ShoppingCart, list: ClipboardList };

interface SectionMeta { key: string; title: string; subtitle: string; icon: typeof Clock; tone: 'risk' | 'good' | 'bad' | 'info'; }
const SECTIONS: SectionMeta[] = [
  { key: 'expiring', title: 'Expiring soon', subtitle: 'RIPs on your items ending in days — act now', icon: Clock, tone: 'risk' },
  { key: 'partial', title: 'Limited-time deals', subtitle: 'Partial-month QD/RIP — only valid on certain dates', icon: CalendarClock, tone: 'risk' },
  { key: 'buy_before', title: 'Buy before prices rise', subtitle: 'Locks in this edition’s price', icon: CalendarClock, tone: 'risk' },
  { key: 'new_rips', title: 'New RIPs on your items', subtitle: 'Rebates that just appeared this edition', icon: BadgeDollarSign, tone: 'good' },
  { key: 'deeper_rips', title: 'RIPs got deeper', subtitle: 'Bigger rebate than last month', icon: TrendingUp, tone: 'good' },
  { key: 'target_hits', title: 'Hit your target price', subtitle: 'Your watchlist targets were reached', icon: Target, tone: 'good' },
  { key: 'lost_rips', title: 'RIPs ended', subtitle: 'Rebates you had last month are gone', icon: TrendingDown, tone: 'bad' },
  { key: 'price_relief', title: 'Prices dropping next month', subtitle: 'You can wait on these', icon: ArrowDownRight, tone: 'info' },
];

function Card({ c }: { c: DigestCard }) {
  const months = useMemo(() => buildMonths(c), [c]);
  const eff = c.effective_case_price ?? c.frontline_case_price ?? null;
  const vendorSku = abgSku(c.wholesaler, c.abg_sku) ? `${skuLabel(c.wholesaler)} ${c.abg_sku}` : null;
  return (
    <Link to={detailUrl(c)} className={`wn-card wn-${c.intent}`}>
      <div className="wn-card-top">
        <ProductThumb src={c.image_url} alt={c.product_name} size={52} />
        <div className="wn-card-id">
          <div className="wn-card-name">{c.product_name}</div>
          <div className="wn-card-sub">
            <Store size={11} /> {distributorName(c.wholesaler)}{c.unit_volume ? ` · ${c.unit_volume}` : ''}
          </div>
          {/* UPC always; vendor item code (ABG/Fedway) next to it when present. */}
          <div className="wn-card-ids">
            {c.upc && <span>UPC: {c.upc}</span>}
            {vendorSku && <span>{vendorSku}</span>}
          </div>
          <div className="wn-card-src">
            {c.sources.map(s => { const I = SOURCE_ICON[s]; return I ? <I key={s} size={11} aria-label={s} /> : null; })}
          </div>
        </div>
      </div>
      <div className="wn-card-stickers"><PartialSticker months={months} /></div>
      <div className={`wn-card-change wn-${c.intent}`}>{c.change_detail}</div>
      <div className="wn-card-foot">
        <span className="wn-card-price">{money(eff)}<span className="wn-card-unit">/cs</span></span>
        <PriceSparklines wholesaler={c.wholesaler} productName={c.product_name} upc={c.upc}
          unitVolume={c.unit_volume} unitQty={c.unit_qty} vintage={c.vintage}
          months={months.length ? months : undefined} noSelfFetch={!!c.upc} />
      </div>
    </Link>
  );
}

export default function WhatsNew() {
  const { data, isLoading } = useQuery<WhatsNewData>({ queryKey: ['whats-new'], queryFn: digest.whatsNew });

  const sectionsPresent = SECTIONS.filter(s => (data?.sections?.[s.key]?.length ?? 0) > 0);
  const totalChanges = sectionsPresent.reduce((n, s) => n + (data!.sections[s.key]?.length ?? 0), 0);
  const sav = data?.savings;

  return (
    <div className="page wn-page">
      {/* Hero */}
      <div className="wn-hero">
        <div className="wn-hero-head">
          <h1><Sparkles size={22} /> What’s New for You</h1>
          <p className="wn-hero-sub">
            {data?.edition ? `${editionLabel(data.edition)} edition` : 'This edition'}
            {data?.tracked_count ? ` · ${data.tracked_count} item${data.tracked_count === 1 ? '' : 's'} you track` : ''}
            {totalChanges > 0 ? ` · ${totalChanges} change${totalChanges === 1 ? '' : 's'} for you` : ''}
          </p>
        </div>
        <div className="wn-stats">
          <div className="wn-stat is-opp">
            <span className="wn-stat-ico"><Sparkles size={18} /></span>
            <div><div className="wn-stat-val">{money0(sav?.opportunity_total)}</div>
              <div className="wn-stat-lbl">savings available on your items</div></div>
          </div>
          {(sav?.protection_total ?? 0) > 0 && (
            <div className="wn-stat is-prot">
              <span className="wn-stat-ico"><CalendarClock size={18} /></span>
              <div><div className="wn-stat-val">{money0(sav?.protection_total)}</div>
                <div className="wn-stat-lbl">lock in before prices rise</div></div>
            </div>
          )}
          <div className="wn-stat">
            <span className="wn-stat-ico"><PiggyBank size={18} /></span>
            <div><div className="wn-stat-val">{data?.tracked_count ?? 0}</div>
              <div className="wn-stat-lbl">products tracked</div></div>
          </div>
        </div>
      </div>

      {/* What's on this page — sets expectations up top. */}
      <div className="wn-note">
        <Info size={16} />
        <span>
          This page shows only the products <strong>you track</strong> — your{' '}
          <Link to="/watchlist">Favorites</Link>, <Link to="/cart">Cart</Link> and{' '}
          <Link to="/lists">Lists</Link> — that <strong>changed this edition</strong> (new or expiring rebates,
          price moves, target hits). Click any product to open its full details.
        </span>
      </div>

      {isLoading && <p className="wn-muted">Loading your digest…</p>}

      {!isLoading && (data?.tracked_count ?? 0) === 0 && (
        <div className="wn-empty">
          <Star size={28} />
          <h3>Start tracking products</h3>
          <p>Add items to <Link to="/watchlist">Favorites</Link>, your <Link to="/cart">Cart</Link>, or a{' '}
            <Link to="/lists">List</Link> and this page will show exactly what changed for them every edition —
            new rebates, expiring deals, price rises, and your savings.</p>
        </div>
      )}

      {!isLoading && (data?.tracked_count ?? 0) > 0 && totalChanges === 0 && (
        <div className="wn-allclear">
          <Sparkles size={22} /> You’re all caught up — no changes on your tracked items this edition.
        </div>
      )}

      {/* Change sections */}
      {sectionsPresent.map(s => {
        const items = data!.sections[s.key];
        const Icon = s.icon;
        return (
          <section key={s.key} className={`wn-section wn-tone-${s.tone}`}>
            <div className="wn-section-head">
              <span className="wn-section-ico"><Icon size={18} /></span>
              <div>
                <h2>{s.title} <span className="wn-section-count">{items.length}</span></h2>
                <p>{s.subtitle}</p>
              </div>
            </div>
            <div className="wn-grid">
              {items.map((c, i) => <Card key={`${c.upc}|${c.wholesaler}|${i}`} c={c} />)}
            </div>
          </section>
        );
      })}

      {/* Savings detail (reuses the cart/list analyzer panel) */}
      {(sav?.recommendations?.length ?? 0) > 0 && (
        <section className="wn-section">
          <div className="wn-section-head">
            <span className="wn-section-ico"><PiggyBank size={18} /></span>
            <div><h2>Your biggest savings moves</h2><p>How to capture the {money0(sav?.opportunity_total)} above</p></div>
          </div>
          <SavingsAnalysis data={sav} context="list" />
        </section>
      )}
    </div>
  );
}
