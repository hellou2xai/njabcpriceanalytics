/**
 * Time-Sensitive Deals — dated (partial-month) RIP/QD promos, one card per line
 * with a month calendar showing exactly when each deal runs (ended = grey,
 * active = green, upcoming = amber) and a windows/tiers column with the deal
 * detail. Card design + filters mirror Discover Deals. The Month control (and
 * the calendar arrows) browse other editions, so expired deals stay reviewable.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Clock, Store, SlidersHorizontal, PanelLeftClose, ChevronDown, CalendarClock } from 'lucide-react';
import { catalog, deals, type TimeSensitiveDeal, type CatalogTier } from '../lib/api';
import ProductThumb from '../components/ProductThumb';
import FavoriteButton from '../components/FavoriteButton';
import AvailabilityButton from '../components/AvailabilityButton';
import DealCalendar, { type DealWindow } from '../components/DealCalendar';
import { distributorName, ALL_DISTRIBUTORS } from '../lib/distributors';
import { bottlesPerCase } from '../lib/productSizes';
import { ErrorState } from '../components/DataState';
import DataLoading from '../components/DataLoading';
import './Discover.css';
import './TimeSensitiveDeals.css';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DIST_PINNED = ['allied', 'fedway', 'opici'];
const DISTRIBUTOR_OPTS = [...ALL_DISTRIBUTORS.filter((d) => d.value)].sort((a, b) => {
  const ia = DIST_PINNED.indexOf(a.value), ib = DIST_PINNED.indexOf(b.value);
  return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
});

const money = (v?: number | null) => (v == null ? '–' : `$${Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 })}`);
const money0 = (v?: number | null) => (v == null ? null : `$${Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
const fmtMonthLabel = (ym: string) => { const m = /^(\d{4})-(\d{2})$/.exec(ym); return m ? `${MONTHS[+m[2] - 1]} ${m[1]}` : ym; };
const shortDate = (iso?: string | null) => { if (!iso) return ''; const [, mo, d] = iso.split('-').map(Number); return mo && d ? `${MONTHS[mo - 1]} ${d}` : ''; };
const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

const isBottle = (u?: string | null) => /^b/i.test(u || '');
const isOneCsQd = (t: CatalogTier) => t.source === 'discount' && t.qty === 1 && !isBottle(t.unit);
const tierQty = (t: CatalogTier) => `${t.qty}${isBottle(t.unit) ? 'bt' : 'cs'}`;

// Featured tier of a kind (largest case qty first, ties by depth) — mirrors Discover.
function topTier(tiers: CatalogTier[] | undefined, source: 'discount' | 'rip'): CatalogTier | null {
  const of = (tiers ?? []).filter((t) => t.source === source && !(source === 'discount' && isOneCsQd(t)));
  if (!of.length) return null;
  const depth = (t: CatalogTier) => (source === 'rip' ? (t.amount ?? 0) : (t.save_per_case ?? 0));
  return of.reduce((a, b) => ((b.qty ?? 0) !== (a.qty ?? 0) ? ((b.qty ?? 0) > (a.qty ?? 0) ? b : a) : (depth(b) > depth(a) ? b : a)));
}
function oneCsCasePrice(d: TimeSensitiveDeal): number | null {
  const entry = (d.tiers ?? []).find((t) => isOneCsQd(t) && !t.is_time_sensitive);
  return entry?.price_after ?? d.frontline_case_price ?? d.effective_case_price ?? null;
}

// ---- one product's grouped deal (one card per line) -----------------------
interface Card {
  rep: TimeSensitiveDeal;
  windows: { from: string; to: string; days: number | null; effective: number | null; savings: number | null; pct: number | null }[];
  soonest: number;   // min days-to-expire among not-yet-ended windows (Infinity if all ended)
}

const normUpc = (u?: string | null) => String(u ?? '').replace(/\D/g, '').replace(/^0+/, '');

function groupDeals(rows: TimeSensitiveDeal[]): Card[] {
  const g = new Map<string, Card>();
  for (const r of rows) {
    if (!r.from_date || !r.to_date) continue;
    const key = `${r.wholesaler}|${normUpc(r.upc)}|${r.unit_volume ?? ''}|${r.unit_qty ?? ''}|${r.vintage ?? ''}`;
    let c = g.get(key);
    if (!c) { c = { rep: r, windows: [], soonest: Infinity }; g.set(key, c); }
    if (!c.windows.some((w) => w.from === r.from_date && w.to === r.to_date)) {
      c.windows.push({ from: r.from_date, to: r.to_date, days: r.days_to_expire,
        effective: r.effective_case_price, savings: r.total_savings_per_case, pct: r.discount_pct });
    }
    if (r.days_to_expire != null && r.days_to_expire >= 0) c.soonest = Math.min(c.soonest, r.days_to_expire);
  }
  for (const c of g.values()) c.windows.sort((a, b) => a.from.localeCompare(b.from));
  return [...g.values()];
}

const SORT_OPTS: [string, string][] = [
  ['ending', 'Ending soonest'], ['starting', 'Soonest starting'],
  ['save', 'Biggest saving'], ['name', 'Product name'],
];
const DEAL_OPTS: [string, string][] = [['rip', 'Has RIP'], ['qd', 'Has QD']];
const SIZES = ['375ML', '750ML', '1L', '1.75L'];

function toggleIn(set: Set<string>, v: string) { const n = new Set(set); n.has(v) ? n.delete(v) : n.add(v); return n; }

function FilterSection({ title, count = 0, children }: { title: string; count?: number; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="disc-filter-sect">
      <button type="button" className="disc-filter-h disc-filter-h--btn" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span>{title}{count > 0 && <span className="disc-filter-count">{count}</span>}</span>
        <ChevronDown size={14} className={`disc-filter-chev${open ? ' is-open' : ''}`} />
      </button>
      {open && <div className="disc-filter-body">{children}</div>}
    </div>
  );
}

// ---- the card (Discover design) -------------------------------------------
function TsCard({ d }: { d: TimeSensitiveDeal }) {
  const price = money0(oneCsCasePrice(d));
  const rip = topTier(d.tiers, 'rip');
  const qd = topTier(d.tiers, 'discount');
  const pack = bottlesPerCase(d.product_name, d.unit_qty);
  const href = `/product?w=${d.wholesaler}&n=${encodeURIComponent(d.product_name)}${d.upc ? `&u=${d.upc}` : ''}${d.unit_volume ? `&s=${encodeURIComponent(d.unit_volume)}` : ''}${d.unit_qty ? `&pk=${d.unit_qty}` : ''}`;
  return (
    <Link to={href} className="disc-card tsd-card">
      <div className="disc-card-top">
        <span className="disc-card-dist" title={distributorName(d.wholesaler)}><Store size={11} /> {distributorName(d.wholesaler)}</span>
        <FavoriteButton productName={d.product_name} wholesaler={d.wholesaler} upc={d.upc ?? undefined} unitVolume={d.unit_volume ?? undefined} />
      </div>
      <AvailabilityButton wholesaler={d.wholesaler} name={d.product_name} itemNumber={d.abg_sku ?? undefined} className="disc-card-avail" />
      <div className="disc-card-media">
        <ProductThumb src={d.image_url ?? undefined} alt={d.product_name} size={104} />
      </div>
      <div className="disc-card-name">{d.abg_item_name?.trim() || d.product_name}</div>
      {d.unit_volume && <div className="disc-card-size">{d.unit_volume}{pack != null ? ` (${pack}/cs)` : ''}</div>}
      <div className="disc-card-foot">
        {price && <div className="disc-card-price">{price}<span className="disc-card-price-u">/cs</span></div>}
        {(rip || qd) && (
          <div className="disc-card-deals">
            {rip && <span className="disc-deal disc-deal--rip">Best RIP: {tierQty(rip)} - {money0(rip.amount)} ({money0(rip.save_per_case ?? 0)}/cs)</span>}
            {qd && <span className="disc-deal disc-deal--qd">Best QD: {tierQty(qd)} - {money0(qd.save_per_case)}/cs</span>}
          </div>
        )}
      </div>
    </Link>
  );
}

// ---- the windows + tiers detail column ------------------------------------
function windowState(w: { from: string; to: string }, today: string): 'ended' | 'live' | 'upcoming' {
  if (w.to < today) return 'ended';
  if (w.from > today) return 'upcoming';
  return 'live';
}
function WindowsDetail({ card, today }: { card: Card; today: string }) {
  const seen = new Set<string>();
  const tiers = (card.rep.tiers ?? [])
    .filter((t) => {
      if (isOneCsQd(t)) return false;
      const k = `${t.source}|${t.qty}|${t.unit}|${t.price_after}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => (a.source === b.source ? (a.qty ?? 0) - (b.qty ?? 0) : a.source === 'rip' ? -1 : 1));
  return (
    <div className="tsd-detail">
      <div className="tsd-detail-h">Deal windows</div>
      <div className="tsd-windows">
        {card.windows.map((w, i) => {
          const st = windowState(w, today);
          return (
            <div key={i} className={`tsd-win tsd-win-${st}`}>
              <span className={`tsd-win-badge tsd-badge-${st}`}>{st === 'live' ? 'Active' : st === 'upcoming' ? 'Upcoming' : 'Ended'}</span>
              <span className="tsd-win-dates">{shortDate(w.from)} – {shortDate(w.to)}</span>
              {st !== 'ended' && w.days != null && w.days >= 0 && (
                <span className="tsd-win-days">{st === 'upcoming' ? `starts in ${Math.max(0, (w.days ?? 0))}d` : `${w.days}d left`}</span>
              )}
              <span className="tsd-win-price">{money(w.effective)}/cs
                {w.savings != null && <em> −{money(w.savings)}{w.pct != null ? ` · ${w.pct}% off` : ''}</em>}
              </span>
            </div>
          );
        })}
      </div>
      {tiers.length > 0 && (
        <div className="tsd-tiers">
          <div className="tsd-detail-h">Tiers</div>
          {tiers.map((t, i) => (
            <div key={i} className="tsd-tier">
              <span className={`tsd-tier-kind tsd-tier-${t.source}`}>{t.source === 'rip' ? 'RIP' : 'QD'} {tierQty(t)}</span>
              <span className="tsd-tier-vals">
                {money(t.price_after)}/cs
                {t.source === 'rip' ? (t.amount != null && <em> {money(t.amount)} back</em>) : (t.save_per_case != null && <em> save {money(t.save_per_case)}/cs</em>)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function TimeSensitiveDeals() {
  const today = todayISO();
  const { data: eds } = useQuery({ queryKey: ['editions'], queryFn: catalog.editions, staleTime: 3_600_000 });
  const months = useMemo(() => [...new Set((eds ?? []).map((e) => e.edition))].sort().reverse(), [eds]);
  const [month, setMonth] = useState('');                 // '' until editions load -> newest
  const selMonth = month || months[0] || '';
  const monthIdx = months.indexOf(selMonth);

  const [distSet, setDistSet] = useState<Set<string>>(new Set());
  const [catSet, setCatSet] = useState<Set<string>>(new Set());
  const [dealSet, setDealSet] = useState<Set<string>>(new Set());
  const [sizeSet, setSizeSet] = useState<Set<string>>(new Set());
  const [sortBy, setSortBy] = useState('ending');
  const [shown, setShown] = useState(60);                 // client-side pager (deal lists can be large)
  const [filtersCollapsed, setFiltersCollapsed] = useState(() => localStorage.getItem('tsd_filters_collapsed') === '1');
  useEffect(() => { setShown(60); }, [selMonth, distSet, catSet, dealSet, sizeSet, sortBy]);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['ts-deals', selMonth],
    queryFn: () => deals.timeSensitive({ edition: selMonth || undefined, limit: 5000 }),
    enabled: !!selMonth,
    staleTime: 600_000,
  });

  const cards = useMemo(() => {
    let cs = groupDeals(data ?? []);
    const dists = [...distSet], cats = [...catSet], szs = [...sizeSet], dl = [...dealSet];
    if (dists.length) cs = cs.filter((c) => dists.includes(c.rep.wholesaler));
    if (cats.length) cs = cs.filter((c) => c.rep.product_type != null && cats.includes(c.rep.product_type));
    if (szs.length) cs = cs.filter((c) => c.rep.unit_volume != null && szs.includes(c.rep.unit_volume));
    if (dl.length) cs = cs.filter((c) => (dl.includes('rip') && !!topTier(c.rep.tiers, 'rip')) || (dl.includes('qd') && !!topTier(c.rep.tiers, 'discount')));
    const savingOf = (c: Card) => c.rep.total_savings_per_case ?? 0;
    const startOf = (c: Card) => c.windows.reduce((m, w) => Math.min(m, w.from.localeCompare(today) >= 0 ? +w.from.replace(/-/g, '') : Infinity), Infinity);
    cs.sort((a, b) => {
      if (sortBy === 'save') return savingOf(b) - savingOf(a);
      if (sortBy === 'name') return (a.rep.product_name || '').localeCompare(b.rep.product_name || '');
      if (sortBy === 'starting') return startOf(a) - startOf(b);
      return a.soonest - b.soonest;   // ending soonest (default)
    });
    return cs;
  }, [data, distSet, catSet, sizeSet, dealSet, sortBy, today]);

  const catOptions = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of groupDeals(data ?? [])) { const t = c.rep.product_type; if (t) m.set(t, (m.get(t) ?? 0) + 1); }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => v);
  }, [data]);

  const activeCount = distSet.size + catSet.size + dealSet.size + sizeSet.size;
  const stepMonth = (dir: -1 | 1) => { const i = monthIdx + dir; if (i >= 0 && i < months.length) setMonth(months[i]); };

  return (
    <div className="disc-page tsd-page">
      <header className="tsd-hero">
        <h1 className="disc-title"><CalendarClock size={22} style={{ verticalAlign: '-4px', marginRight: 8 }} />Time-Sensitive Deals</h1>
        <p className="disc-sub">Dated RIP & quantity-discount promos — see exactly when each runs, and look back at past months.</p>
        <div className="tsd-monthbar">
          <label>Month
            <select value={selMonth} onChange={(e) => setMonth(e.target.value)}>
              {months.map((m) => <option key={m} value={m}>{fmtMonthLabel(m)}</option>)}
            </select>
          </label>
          <span className="tsd-count">{cards.length.toLocaleString()} deal{cards.length === 1 ? '' : 's'}</span>
        </div>
      </header>

      <div className={`disc-body${filtersCollapsed ? ' disc-body--nofilters' : ''}`}>
        {filtersCollapsed ? (
          <button type="button" className="disc-filters-show" onClick={() => { setFiltersCollapsed(false); localStorage.setItem('tsd_filters_collapsed', '0'); }}>
            <SlidersHorizontal size={16} /> Filters{activeCount > 0 ? ` (${activeCount})` : ''}
          </button>
        ) : (
          <aside className="disc-filters">
            <div className="disc-filters-head">
              <span>Filters</span>
              <span className="disc-filters-head-actions">
                {activeCount > 0 && (
                  <button type="button" className="disc-filters-clear"
                    onClick={() => { setDistSet(new Set()); setCatSet(new Set()); setDealSet(new Set()); setSizeSet(new Set()); }}>Clear</button>
                )}
                <button type="button" className="disc-filters-collapse" title="Collapse filters" aria-label="Collapse filters"
                  onClick={() => { setFiltersCollapsed(true); localStorage.setItem('tsd_filters_collapsed', '1'); }}><PanelLeftClose size={16} /></button>
              </span>
            </div>
            <FilterSection title="Sort by">
              <select className="disc-filter-select" value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
                {SORT_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </FilterSection>
            <FilterSection title="Deal" count={dealSet.size}>
              {DEAL_OPTS.map(([v, l]) => (
                <label key={v} className="disc-filter-opt"><input type="checkbox" checked={dealSet.has(v)} onChange={() => setDealSet((s) => toggleIn(s, v))} /><span>{l}</span></label>
              ))}
            </FilterSection>
            <FilterSection title="Size" count={sizeSet.size}>
              {SIZES.map((s) => (
                <label key={s} className="disc-filter-opt"><input type="checkbox" checked={sizeSet.has(s)} onChange={() => setSizeSet((x) => toggleIn(x, s))} /><span>{s}</span></label>
              ))}
            </FilterSection>
            {catOptions.length > 0 && (
              <FilterSection title="Category" count={catSet.size}>
                <div className="disc-filter-list">
                  {catOptions.map((t) => (
                    <label key={t} className="disc-filter-opt"><input type="checkbox" checked={catSet.has(t)} onChange={() => setCatSet((s) => toggleIn(s, t))} /><span>{t}</span></label>
                  ))}
                </div>
              </FilterSection>
            )}
            <FilterSection title="Distributor" count={distSet.size}>
              <div className="disc-filter-list">
                {DISTRIBUTOR_OPTS.map((dopt) => (
                  <label key={dopt.value} className="disc-filter-opt"><input type="checkbox" checked={distSet.has(dopt.value)} onChange={() => setDistSet((s) => toggleIn(s, dopt.value))} /><span>{dopt.label}</span></label>
                ))}
              </div>
            </FilterSection>
          </aside>
        )}

        <div className="tsd-list">
          {isLoading && <DataLoading label="Loading time-sensitive deals…" />}
          {isError && <ErrorState retry={() => refetch()} />}
          {data && cards.length === 0 && (
            <div className="disc-rail-empty tsd-empty">
              <Clock size={16} /> No time-sensitive deals for {fmtMonthLabel(selMonth)} with these filters.
            </div>
          )}
          {cards.slice(0, shown).map((c) => (
            <div key={`${c.rep.wholesaler}-${c.rep.upc}-${c.rep.unit_volume}-${c.rep.unit_qty}-${c.rep.vintage}`} className="tsd-row">
              <TsCard d={c.rep} />
              <DealCalendar month={selMonth} today={today}
                windows={c.windows.map((w): DealWindow => ({ from: w.from, to: w.to }))}
                onPrev={() => stepMonth(1)} onNext={() => stepMonth(-1)}
                canPrev={monthIdx < months.length - 1} canNext={monthIdx > 0} />
              <WindowsDetail card={c} today={today} />
            </div>
          ))}
          {cards.length > shown && (
            <button type="button" className="btn tsd-more" onClick={() => setShown((s) => s + 60)}>
              Show 60 more ({(cards.length - shown).toLocaleString()} remaining)
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
