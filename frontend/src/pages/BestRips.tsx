import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  BadgeDollarSign, Trophy, AlertTriangle, Clock, Layers,
  TrendingUp, TrendingDown, Tag, CalendarClock,
} from 'lucide-react';
import { compare } from '../lib/api';
import type { BestRipRow, BestRipDist, BestRipTier, BestRipTrend } from '../lib/api';
import { distributorName } from '../lib/distributors';
import ProductSearchBox from '../components/ProductSearchBox';
import ProductThumb from '../components/ProductThumb';
import RipMembersModal from '../components/RipMembersModal';
import FilterSidebar, { type FilterSection } from '../components/FilterSidebar';
import { ErrorState } from '../components/DataState';
import DataLoading from '../components/DataLoading';
import './BestRips.css';

const money = (v?: number | null) =>
  v == null ? '–' : `$${Number(v).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
const pct = (v?: number | null) => (v == null ? '–' : `${Number(v).toFixed(1)}%`);
const ACCENTS: Record<string, string> = { allied: '#2563eb', fedway: '#d97706', opici: '#7c3aed' };
const DIST_OPTS = ['allied', 'fedway', 'opici'];
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (ym?: string | null) => {
  if (!ym) return '';
  const [y, m] = ym.split('-').map(Number);
  return m ? `${MONTH_ABBR[m - 1]} ${y}` : ym;
};

/** Month-over-month "when is the RIP best" sticker. RIP codes change monthly, so
    this tracks the deepest rebate AMOUNT per case across last/this/next. */
function TrendSticker({ t }: { t: BestRipTrend }) {
  if (!t.best) return null;
  // Tooltip lists only the months that have data (loaded), with real labels.
  const parts = ([['last', t.last_ed, t.last], ['this', t.this_ed, t.this], ['next', t.next_ed, t.next]] as const)
    .filter(([, , v]) => v != null)
    .map(([, ed, v]) => `${monthLabel(ed)}: $${v}/cs`);
  const tip = `Deepest rebate per case — ${parts.join(' · ')}`;
  if (t.best === 'this')
    return <span className="br-trend br-trend--now" title={tip}><TrendingUp size={11} /> Best RIP this month</span>;
  if (t.best === 'next')
    return <span className="br-trend br-trend--next" title={tip}><TrendingUp size={11} /> Better next month</span>;
  return <span className="br-trend br-trend--last" title={tip}><TrendingDown size={11} /> Was better last month</span>;
}

type Sort = 'best_profit' | 'deepest' | 'gap' | 'expiring' | 'product';
const SORTS: { key: Sort; label: string; hint: string }[] = [
  { key: 'best_profit', label: 'Best RIP profit', hint: 'Highest rebate as a % of the cash you put down' },
  { key: 'deepest', label: 'Deepest rebate', hint: 'Biggest $/case rebate at any volume' },
  { key: 'gap', label: 'Biggest gap', hint: 'Where the three distributors differ the most on RIP profit' },
  { key: 'expiring', label: 'Expiring soon', hint: 'A live dated RIP that ends soonest' },
  { key: 'product', label: 'A–Z', hint: 'By product name' },
];

const wineVintage = (type?: string | null, vintage?: string | null): string | null => {
  if (!vintage) return null;
  const v = String(vintage).trim();
  if (!v || ['0', 'nan', 'none', 'null'].includes(v.toLowerCase())) return null;
  const isWine = /wine|sparkling|vermouth|champagne|port|sherry/i.test(type || '');
  if (!isWine && !/^(19|20)\d{2}$|^nv$/i.test(v)) return null;
  return v.toUpperCase() === 'NV' ? 'NV' : v;
};

const detailUrl = (w: string, name?: string | null, upc?: string | null) => {
  const q = new URLSearchParams({ w, n: name || '' });
  if (upc) q.set('u', String(upc));
  return `/product?${q.toString()}`;
};

/** A whole-month / dated / expired window badge for a distributor block. */
function WindowBadge({ d }: { d: BestRipDist }) {
  if (d.expires_in_days != null && d.expires_in_days >= 0) {
    return (
      <span className="br-win br-win--soon" title="A live RIP ends this month — buy before it expires">
        <Clock size={11} /> ends in {d.expires_in_days}d
      </span>
    );
  }
  if (d.has_time_sensitive) {
    return <span className="br-win br-win--dated" title="Dated/time-limited rebate window"><Clock size={11} /> dated</span>;
  }
  return <span className="br-win" title="Live all month">whole month</span>;
}

/** One distributor's RIP ladder, one line per tier. */
function DistBlock({ w, d, row, isWinner, onRipClick }: {
  w: string; d: BestRipDist; row: BestRipRow; isWinner: boolean;
  onRipClick: (wholesaler: string, code: string, edition: string) => void;
}) {
  const accent = ACCENTS[w] || '#64748b';
  const name = distributorName(w);

  if (!d.carried) {
    return (
      <div className="br-dist br-dist--norip">
        <div className="br-dist-head">
          <span className="br-dist-name" style={{ color: accent }}>{name}</span>
          <span className="br-norip br-norip--absent">Not carried</span>
        </div>
      </div>
    );
  }

  if (!d.has_rip) {
    return (
      <div className="br-dist br-dist--norip">
        <div className="br-dist-head">
          <Link className="br-dist-name br-dist-name--link" style={{ color: accent }}
            to={detailUrl(w, row.product_name, row.upc)}
            title={`View ${row.product_name} at ${name}`}>{name}</Link>
          <span className="br-norip"><AlertTriangle size={12} /> No RIP this edition</span>
        </div>
      </div>
    );
  }

  const bestTierPct = Math.max(...d.tiers.map(t => t.rip_profit_pct ?? 0));

  return (
    <div className={`br-dist${isWinner ? ' br-dist--winner' : ''}`}>
      <div className="br-dist-head">
        <Link className="br-dist-name br-dist-name--link" style={{ color: accent }}
          to={detailUrl(w, row.product_name, row.upc)}
          title={`View ${row.product_name} at ${name}`}>{name}</Link>
        {isWinner && (
          <span className="br-crown" title={`Best RIP profit${row.profit_delta ? ` (+${row.profit_delta}pp vs next)` : ''}`}>
            <Trophy size={12} /> best{row.profit_delta ? ` +${row.profit_delta}pp` : ''}
          </span>
        )}
        {d.rip_code && (
          <button className="br-code" onClick={() => onRipClick(w, String(d.rip_code), row.edition)}
            title={`See every product under RIP ${d.rip_code}${d.case_mix ? ` (mix across ${d.case_mix})` : ''}`}>
            <Tag size={11} /> RIP {d.rip_code}{d.case_mix && d.case_mix > 1 ? ` · mix ${d.case_mix}` : ''}
          </button>
        )}
        <WindowBadge d={d} />
      </div>

      <table className="br-tiers">
        <thead>
          <tr>
            <th>Tier</th>
            <th className="br-num" title="Cash you put down, net of the quantity discount (before the RIP comes back)">Needed for purchase</th>
            <th className="br-num" title="Rebate as a % of the cash you put down">RIP profit</th>
          </tr>
        </thead>
        <tbody>
          {d.tiers.map((t, i) => (
            <TierLine key={i} t={t} isBest={(t.rip_profit_pct ?? -1) === bestTierPct} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TierLine({ t, isBest }: { t: BestRipTier; isBest: boolean }) {
  const expired = t.window_status === 'expired';
  return (
    <tr className={`${isBest ? 'br-tier--best' : ''}${expired ? ' br-tier--expired' : ''}`}>
      <td>
        <span className="br-tier-buy">{t.buy_label || (t.cases != null ? `${t.cases} cs` : '–')}</span>
        <span className="br-tier-reb"> / {money(t.total_rebate)}</span>
        {t.is_time_sensitive && <Clock size={10} className="br-tier-ts" />}
      </td>
      <td className="br-num">{money(t.needed_for_purchase)}</td>
      <td className="br-num">
        <span className="br-profit">{pct(t.rip_profit_pct)}</span>
        {isBest && <span className="br-best-dot" title="Best tier on this ladder">◀</span>}
      </td>
    </tr>
  );
}

function Card({ row, slugs, onRipClick, isTop }: { row: BestRipRow; slugs: string[]; onRipClick: (w: string, c: string, edition: string) => void; isTop?: boolean }) {
  const present = slugs.filter(w => row.dists[w]);
  const vint = wineVintage(row.product_type, row.vintage);
  const size = [row.unit_qty, row.unit_volume].filter(Boolean).join(' × ');
  // Card-level product link uses the best (or first present) distributor.
  const primaryW = row.best_distributor || present[0];
  const productHref = primaryW ? detailUrl(primaryW, row.product_name, row.upc) : null;

  return (
    <div className={`br-card${isTop ? ' br-card--top' : ''}`}>
      {isTop && <div className="br-topband">★ Best RIP profit on the board</div>}
      <div className="br-card-head">
        <div className="br-card-lead">
          <ProductThumb src={row.image_url} alt={row.product_name} size={48} expandable />
          <div className="br-card-title">
            {productHref
              ? <Link className="br-name br-name--link" to={productHref}>{row.product_name}</Link>
              : <span className="br-name">{row.product_name}</span>}
            <span className="br-meta">
              <span className="br-edchip" title={`RIP from the ${monthLabel(row.edition)} edition`}><CalendarClock size={10} /> {monthLabel(row.edition)}</span>
              {size && <span>{size}</span>}
              {vint && <span className="br-vint">{vint}</span>}
              {row.upc && <span className="br-upc">UPC {row.upc}</span>}
            </span>
          </div>
        </div>
        <div className="br-card-flags">
          {row.best_profit_pct != null && (
            <span className="br-headline" title="Best RIP profit across the three distributors">
              <TrendingUp size={13} /> {pct(row.best_profit_pct)}
            </span>
          )}
          <TrendSticker t={row.rip_trend} />
          {row.differs && (
            <span className="br-differs" title="The three distributors differ on RIP terms (missing, timing, quantity or profit)">
              <AlertTriangle size={12} /> Differs
            </span>
          )}
          {row.timing_differs && <span className="br-tag" title="Distributors differ on rebate timing">timing</span>}
          {row.quantity_differs && <span className="br-tag" title="Distributors differ on cases needed to unlock">quantity</span>}
          {row.missing.length > 0 && (
            <span className="br-tag br-tag--miss" title={`${row.missing.map(distributorName).join(', ')} carry it but file no RIP`}>
              missing {row.missing.length}
            </span>
          )}
        </div>
      </div>
      <div className="br-dists">
        {present.map(w => (
          <DistBlock key={w} w={w} d={row.dists[w]} row={row}
            isWinner={row.best_distributor === w && present.filter(x => row.dists[x].has_rip).length > 1}
            onRipClick={onRipClick} />
        ))}
      </div>
    </div>
  );
}

export default function BestRips() {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>('best_profit');
  const [onlyDiff, setOnlyDiff] = useState(false);
  const [tsOnly, setTsOnly] = useState(false);
  const [hideExpired, setHideExpired] = useState(true);
  const [minProfit, setMinProfit] = useState(0);
  const [dists, setDists] = useState<string[]>(['allied', 'fedway', 'opici']);
  const [months, setMonths] = useState<string[]>([]);   // [] = server default (latest two)
  const [ptype, setPtype] = useState('');        // category (server: product_type)
  const [brand, setBrand] = useState('');        // brand (server: brand contains)
  const [sizes, setSizes] = useState<string[]>([]);  // size (client-side on returned rows)
  const [modal, setModal] = useState<{ w: string; code: string; edition: string } | null>(null);

  const params = useMemo(() => ({
    q: query || undefined,
    sort,
    wholesalers: dists.join(','),
    months: months.length ? months.join(',') : undefined,  // empty -> latest two
    only_differences: onlyDiff,
    time_sensitive_only: tsOnly,
    hide_expired: hideExpired,
    min_profit: minProfit || undefined,
    product_type: ptype || undefined,
    brand: brand || undefined,
    limit: 400,
  }), [query, sort, dists, months, onlyDiff, tsOnly, hideExpired, minProfit, ptype, brand]);

  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: ['best-rips', params],
    queryFn: () => compare.bestRips(params),
    // The board is a heavy aggregate; cache aggressively and keep the previous
    // page visible while refetching so filter toggles don't flash a spinner.
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    placeholderData: (prev) => prev,
  });

  // Selected months default to the server's choice (latest two) until the user picks.
  const selMonths = months.length ? months : (data?.months ?? []);

  // Facet options derived from the loaded board (data-scoped, like Price Movers).
  const catOpts = useMemo(
    () => Array.from(new Set((data?.rows ?? []).map(r => r.product_type).filter(Boolean) as string[])).sort(),
    [data]);
  const brandOpts = useMemo(
    () => Array.from(new Set((data?.rows ?? []).map(r => r.brand).filter(Boolean) as string[])).sort(),
    [data]);
  const sizeOpts = useMemo(
    () => Array.from(new Set((data?.rows ?? []).map(r => r.unit_volume).filter(Boolean) as string[])).sort(),
    [data]);
  // Size narrows the already-fetched rows client-side (the board API has no size param).
  const rows = useMemo(() => {
    const all = data?.rows ?? [];
    return sizes.length ? all.filter(r => sizes.includes(r.unit_volume ?? '')) : all;
  }, [data, sizes]);
  // The best RIP profit % on the board — its card(s) get the yellow "best" band.
  const topPct = useMemo(() => rows.reduce((m, r) => Math.max(m, r.best_profit_pct ?? 0), 0), [rows]);

  const resetFilters = () => {
    setQuery(''); setSort('best_profit'); setOnlyDiff(false); setTsOnly(false);
    setHideExpired(true); setMinProfit(0); setDists([...DIST_OPTS]); setMonths([]);
    setPtype(''); setBrand(''); setSizes([]);
  };

  const sections: FilterSection[] = [
    { type: 'custom', key: 'q', title: 'Product',
      render: () => (
        <ProductSearchBox value={query} onChange={setQuery}
          onSelect={(p) => setQuery(p.product_name)}
          placeholder="Product, brand or barcode…" />
      ) },
    { type: 'multi-pills', key: 'dist', title: 'Distributors',
      options: DIST_OPTS.map(w => ({ label: distributorName(w), value: w })),
      values: dists,
      onChange: (vals) => setDists(vals.length ? DIST_OPTS.filter(d => vals.includes(d)) : dists) },
    { type: 'select', key: 'cat', title: 'Category', placeholder: 'All categories',
      value: ptype, options: catOpts.map(c => ({ label: c, value: c })), onChange: setPtype },
    { type: 'select', key: 'brand', title: 'Brand', placeholder: 'All brands',
      value: brand, options: brandOpts.map(b => ({ label: b, value: b })), onChange: setBrand },
    ...(sizeOpts.length > 0
      ? [{
          type: 'multi-pills', key: 'size', title: 'Size',
          options: sizeOpts.map(s => ({ label: s, value: s })),
          values: sizes, onChange: (vals: string[]) => setSizes(vals),
        } as FilterSection]
      : []),
    ...(data && data.available_months.length > 0
      ? [{
          type: 'multi-pills', key: 'months', title: 'Months',
          options: data.available_months.map(m => ({ label: monthLabel(m), value: m })),
          values: selMonths,
          onChange: (vals: string[]) => setMonths(vals.length ? vals : selMonths),
        } as FilterSection]
      : []),
    { type: 'pills', key: 'sort', title: 'Sort by',
      options: SORTS.map(s => ({ label: s.label, value: s.key })),
      value: sort, onChange: (v) => setSort(v as Sort) },
    { type: 'toggle', key: 'diff', title: 'Differences', label: 'Only where distributors differ',
      value: onlyDiff, onChange: setOnlyDiff },
    { type: 'toggle', key: 'ts', title: 'Time-sensitive', label: 'Time-sensitive only',
      value: tsOnly, onChange: setTsOnly },
    { type: 'toggle', key: 'exp', title: 'Expired tiers', label: 'Hide expired tiers',
      value: hideExpired, onChange: setHideExpired },
    { type: 'custom', key: 'minp', title: 'Min RIP profit',
      render: () => (
        <label className="filter-rail-range">
          <b>{minProfit}%</b>
          <input type="range" min={0} max={40} step={1} value={minProfit}
            onChange={e => setMinProfit(Number(e.target.value))} />
        </label>
      ) },
  ];

  return (
    <div className="br-page">
      <FilterSidebar storageKey="best-rips" sections={sections} onReset={resetFilters}>
      <div className="br-hero">
        <div>
          <h1><BadgeDollarSign size={22} /> Best RIPs</h1>
          <p>The standout rebates across <b>Allied</b>, <b>Fedway</b> and <b>Opici</b> — one card per product,
            one line per RIP tier. <b>Needed for purchase</b> is net of the quantity discount;
            <b> RIP profit</b> is the rebate as a % of that cash down.</p>
        </div>
        {selMonths.length > 0 && (
          <span className="br-edition"><Layers size={13} /> {selMonths.map(monthLabel).join(' · ')}</span>
        )}
      </div>

      {isLoading && <DataLoading />}
      {error && <ErrorState message="Could not load the Best RIPs board." />}
      {data && !isLoading && (
        <>
          <div className="br-count">
            Showing {rows.length} of {data.total.toLocaleString()} RIPs
            {onlyDiff ? ' where the distributors differ' : ` across ${data.wholesalers.map(distributorName).join(', ')}`}
            {data.total > rows.length && ' — refine with search or sort to narrow'}
            {isFetching && <span className="br-updating"> · updating…</span>}
          </div>
          {rows.length === 0 ? (
            <div className="br-empty">No RIPs match these filters.</div>
          ) : (
            <div className="br-grid">
              {rows.map((row: BestRipRow) => (
                <Card key={row.match_key} row={row} slugs={data.wholesalers}
                  onRipClick={(w, code, edition) => setModal({ w, code, edition })}
                  isTop={(row.best_profit_pct ?? 0) > 0 && row.best_profit_pct === topPct} />
              ))}
            </div>
          )}
        </>
      )}
      </FilterSidebar>

      {modal && (
        <RipMembersModal wholesaler={modal.w} ripCode={modal.code} edition={modal.edition} onClose={() => setModal(null)} />
      )}
    </div>
  );
}
