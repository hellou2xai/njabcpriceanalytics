import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  Percent, Trophy, AlertTriangle, Clock, Layers,
  TrendingUp, TrendingDown, CalendarClock,
} from 'lucide-react';
import { compare } from '../lib/api';
import type { BestQdRow, BestQdDist, BestQdTier, BestQdTrend } from '../lib/api';
import { distributorName } from '../lib/distributors';
import ProductSearchBox from '../components/ProductSearchBox';
import ProductThumb from '../components/ProductThumb';
import FilterSidebar, { type FilterSection } from '../components/FilterSidebar';
import { ErrorState } from '../components/DataState';
import DataLoading from '../components/DataLoading';
import './BestQd.css';

const money = (v?: number | null) =>
  v == null ? '–' : `$${Number(v).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
const money2 = (v?: number | null) =>
  v == null ? '–' : `$${Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (v?: number | null) => (v == null ? '–' : `${Number(v).toFixed(1)}%`);
const ACCENTS: Record<string, string> = { allied: '#2563eb', fedway: '#d97706', opici: '#7c3aed' };
const DIST_OPTS = ['allied', 'fedway', 'opici'];
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (ym?: string | null) => {
  if (!ym) return '';
  const [y, m] = ym.split('-').map(Number);
  return m ? `${MONTH_ABBR[m - 1]} ${y}` : ym;
};

/** Month-over-month "when is the QD best" sticker. Tracks the deepest QD $/case
    across last/this/next so a buyer can see whether the discount is improving. */
function TrendSticker({ t }: { t: BestQdTrend }) {
  if (!t.best) return null;
  const parts = ([['last', t.last_ed, t.last], ['this', t.this_ed, t.this], ['next', t.next_ed, t.next]] as const)
    .filter(([, , v]) => v != null)
    .map(([, ed, v]) => `${monthLabel(ed)}: $${v}/cs`);
  const tip = `Deepest discount per case — ${parts.join(' · ')}`;
  if (t.best === 'this')
    return <span className="bq-trend bq-trend--now" title={tip}><TrendingUp size={11} /> Best QD this month</span>;
  if (t.best === 'next')
    return <span className="bq-trend bq-trend--next" title={tip}><TrendingUp size={11} /> Better next month</span>;
  return <span className="bq-trend bq-trend--last" title={tip}><TrendingDown size={11} /> Was better last month</span>;
}

type Sort = 'best_discount' | 'deepest' | 'gap' | 'expiring' | 'product';
const SORTS: { key: Sort; label: string; hint: string }[] = [
  { key: 'best_discount', label: 'Biggest % off', hint: 'Deepest quantity discount as a % of the list case price' },
  { key: 'deepest', label: 'Deepest $/case', hint: 'Biggest $/case quantity discount at any volume' },
  { key: 'gap', label: 'Biggest gap', hint: 'Where the three distributors differ the most on discount %' },
  { key: 'expiring', label: 'Expiring soon', hint: 'A live dated quantity discount that ends soonest' },
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
function WindowBadge({ d }: { d: BestQdDist }) {
  if (d.expires_in_days != null && d.expires_in_days >= 0) {
    return (
      <span className="bq-win bq-win--soon" title="A live quantity discount ends this month — buy before it expires">
        <Clock size={11} /> ends in {d.expires_in_days}d
      </span>
    );
  }
  if (d.has_time_sensitive) {
    return <span className="bq-win bq-win--dated" title="Dated/time-limited discount window"><Clock size={11} /> dated</span>;
  }
  return <span className="bq-win" title="Live all month">whole month</span>;
}

/** One distributor's QD ladder, one line per tier. */
function DistBlock({ w, d, row, isWinner }: {
  w: string; d: BestQdDist; row: BestQdRow; isWinner: boolean;
}) {
  const accent = ACCENTS[w] || '#64748b';
  const name = distributorName(w);

  if (!d.carried) {
    return (
      <div className="bq-dist bq-dist--noqd">
        <div className="bq-dist-head">
          <span className="bq-dist-name" style={{ color: accent }}>{name}</span>
          <span className="bq-noqd bq-noqd--absent">Not carried</span>
        </div>
      </div>
    );
  }

  if (!d.has_qd) {
    return (
      <div className="bq-dist bq-dist--noqd">
        <div className="bq-dist-head">
          <Link className="bq-dist-name bq-dist-name--link" style={{ color: accent }}
            to={detailUrl(w, row.product_name, row.upc)}
            title={`View ${row.product_name} at ${name}`}>{name}</Link>
          <span className="bq-noqd"><AlertTriangle size={12} /> No quantity discount this edition</span>
        </div>
      </div>
    );
  }

  const bestTierPct = Math.max(...d.tiers.map(t => t.discount_pct ?? 0));

  return (
    <div className={`bq-dist${isWinner ? ' bq-dist--winner' : ''}`}>
      <div className="bq-dist-head">
        <Link className="bq-dist-name bq-dist-name--link" style={{ color: accent }}
          to={detailUrl(w, row.product_name, row.upc)}
          title={`View ${row.product_name} at ${name}`}>{name}</Link>
        {isWinner && (
          <span className="bq-crown" title={`Deepest discount %${row.discount_delta ? ` (+${row.discount_delta}pp vs next)` : ''}`}>
            <Trophy size={12} /> best{row.discount_delta ? ` +${row.discount_delta}pp` : ''}
          </span>
        )}
        {d.frontline != null && (
          <span className="bq-win" title="List case price before any discount">list {money(d.frontline)}</span>
        )}
        <WindowBadge d={d} />
      </div>

      <table className="bq-tiers">
        <thead>
          <tr>
            <th title="The qualifying buy and the discount it unlocks">Buy / discount</th>
            <th className="bq-num" title="List case price after this quantity discount (per case and per bottle)">Price after</th>
            <th className="bq-num" title="Discount as a % of the list case price">% off</th>
          </tr>
        </thead>
        <tbody>
          {d.tiers.map((t, i) => (
            <TierLine key={i} t={t} isBest={(t.discount_pct ?? -1) === bestTierPct} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TierLine({ t, isBest }: { t: BestQdTier; isBest: boolean }) {
  const expired = t.window_status === 'expired';
  return (
    <tr className={`${isBest ? 'bq-tier--best' : ''}${expired ? ' bq-tier--expired' : ''}`}>
      <td>
        <span className="bq-tier-buy">{t.buy_label || (t.cases != null ? `${t.cases} cs` : '–')}</span>
        <span className="bq-tier-save"> / {money2(t.discount_per_case)}/cs off</span>
        {t.is_time_sensitive && <Clock size={10} className="bq-tier-ts" />}
      </td>
      <td className="bq-num">
        <span className="bq-after">{money(t.price_after)}/cs</span>
        {t.price_after_btl != null && <> <span className="bq-after-btl">{money2(t.price_after_btl)}/btl</span></>}
      </td>
      <td className="bq-num">
        <span className="bq-pct">{pct(t.discount_pct)}</span>
        {isBest && <span className="bq-best-dot" title="Deepest tier on this ladder">◀</span>}
      </td>
    </tr>
  );
}

function Card({ row, slugs, isTop }: { row: BestQdRow; slugs: string[]; isTop?: boolean }) {
  const present = slugs.filter(w => row.dists[w]);
  const vint = wineVintage(row.product_type, row.vintage);
  const size = [row.unit_qty, row.unit_volume].filter(Boolean).join(' × ');
  const primaryW = row.best_distributor || present[0];
  const productHref = primaryW ? detailUrl(primaryW, row.product_name, row.upc) : null;

  return (
    <div className={`bq-card${isTop ? ' bq-card--top' : ''}`}>
      {isTop && <div className="bq-topband">★ Best quantity discount on the board</div>}
      <div className="bq-card-head">
        <div className="bq-card-lead">
          <ProductThumb src={row.image_url} alt={row.product_name} size={48} expandable />
          <div className="bq-card-title">
            {productHref
              ? <Link className="bq-name bq-name--link" to={productHref}>{row.product_name}</Link>
              : <span className="bq-name">{row.product_name}</span>}
            <span className="bq-meta">
              <span className="bq-edchip" title={`Quantity discount from the ${monthLabel(row.edition)} edition`}><CalendarClock size={10} /> {monthLabel(row.edition)}</span>
              {size && <span>{size}</span>}
              {vint && <span className="bq-vint">{vint}</span>}
              {row.upc && <span className="bq-upc">UPC {row.upc}</span>}
            </span>
          </div>
        </div>
        <div className="bq-card-flags">
          {row.best_discount_pct != null && (
            <span className="bq-headline" title="Deepest quantity discount % across the three distributors">
              <Percent size={13} /> {pct(row.best_discount_pct)} off
            </span>
          )}
          <TrendSticker t={row.qd_trend} />
          {row.differs && (
            <span className="bq-differs" title="The three distributors differ on quantity-discount terms (missing, timing, quantity or depth)">
              <AlertTriangle size={12} /> Differs
            </span>
          )}
          {row.timing_differs && <span className="bq-tag" title="Distributors differ on discount timing">timing</span>}
          {row.quantity_differs && <span className="bq-tag" title="Distributors differ on cases needed to unlock">quantity</span>}
          {row.missing.length > 0 && (
            <span className="bq-tag bq-tag--miss" title={`${row.missing.map(distributorName).join(', ')} carry it but file no quantity discount`}>
              missing {row.missing.length}
            </span>
          )}
        </div>
      </div>
      <div className="bq-dists">
        {present.map(w => (
          <DistBlock key={w} w={w} d={row.dists[w]} row={row}
            isWinner={row.best_distributor === w && present.filter(x => row.dists[x].has_qd).length > 1} />
        ))}
      </div>
    </div>
  );
}

export default function BestQd() {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>('best_discount');
  const [onlyDiff, setOnlyDiff] = useState(false);
  const [tsOnly, setTsOnly] = useState(false);
  const [hideExpired, setHideExpired] = useState(true);
  const [minDiscount, setMinDiscount] = useState(0);
  const [dists, setDists] = useState<string[]>(['allied', 'fedway', 'opici']);
  const [months, setMonths] = useState<string[]>([]);   // [] = server default (latest two)
  const [ptype, setPtype] = useState('');        // category (server: product_type)
  const [brand, setBrand] = useState('');        // brand (server: brand contains)
  const [sizes, setSizes] = useState<string[]>([]);  // size (client-side on returned rows)
  const [cases, setCases] = useState(0);         // best deal reachable at N cases (0 = any)

  const params = useMemo(() => ({
    q: query || undefined,
    sort,
    wholesalers: dists.join(','),
    months: months.length ? months.join(',') : undefined,  // empty -> latest two
    only_differences: onlyDiff,
    time_sensitive_only: tsOnly,
    hide_expired: hideExpired,
    min_discount: minDiscount || undefined,
    product_type: ptype || undefined,
    brand: brand || undefined,
    cases: cases || undefined,
    limit: 400,
  }), [query, sort, dists, months, onlyDiff, tsOnly, hideExpired, minDiscount, ptype, brand, cases]);

  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: ['best-qd', params],
    queryFn: () => compare.bestQd(params),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    placeholderData: (prev) => prev,
  });

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
  // The deepest discount % on the board — its card(s) get the yellow "best" band.
  const topPct = useMemo(() => rows.reduce((m, r) => Math.max(m, r.best_discount_pct ?? 0), 0), [rows]);

  const resetFilters = () => {
    setQuery(''); setSort('best_discount'); setOnlyDiff(false); setTsOnly(false);
    setHideExpired(true); setMinDiscount(0); setDists([...DIST_OPTS]); setMonths([]);
    setPtype(''); setBrand(''); setSizes([]); setCases(0);
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
    { type: 'custom', key: 'cases', title: 'Best deal at (cases)',
      render: () => (
        <div className="filter-rail-cases">
          <div className="filter-rail-cases-val">{cases > 0 ? `At ${cases} case${cases > 1 ? 's' : ''}` : 'Any volume (deepest)'}</div>
          <input type="range" min={0} max={25} step={1} value={Math.min(cases, 25)}
            onChange={e => setCases(Number(e.target.value))} />
          <div className="filter-rail-cases-manual">
            <input type="number" min={0} value={cases || ''} placeholder="0"
              onChange={e => setCases(Math.max(0, Math.floor(Number(e.target.value) || 0)))} />
            <span>cases · 0 = any</span>
          </div>
        </div>
      ) },
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
    { type: 'custom', key: 'mind', title: 'Min discount',
      render: () => (
        <label className="filter-rail-range">
          <b>{minDiscount}%</b>
          <input type="range" min={0} max={40} step={1} value={minDiscount}
            onChange={e => setMinDiscount(Number(e.target.value))} />
        </label>
      ) },
  ];

  return (
    <div className="bq-page">
      <FilterSidebar storageKey="best-qd" sections={sections} onReset={resetFilters}>
      <div className="bq-hero">
        <div>
          <h1><Percent size={22} /> Best Quantity Discounts</h1>
          <p>The deepest quantity discounts across <b>Allied</b>, <b>Fedway</b> and <b>Opici</b> — one card per product,
            one line per QD tier. A quantity discount is a straight price cut once you buy enough cases (no rebate comes
            back). <b>Price after</b> is the list case price net of the discount; <b>% off</b> is the discount as a share
            of that list price.</p>
        </div>
        {selMonths.length > 0 && (
          <span className="bq-edition"><Layers size={13} /> {selMonths.map(monthLabel).join(' · ')}</span>
        )}
      </div>

      {isLoading && <DataLoading />}
      {error && <ErrorState message="Could not load the Best QD board." />}
      {data && !isLoading && (
        <>
          <div className="bq-count">
            Showing {rows.length} of {data.total.toLocaleString()} products with a quantity discount
            {cases > 0 ? ` reachable at ${cases} cs` : ''}
            {onlyDiff ? ' where the distributors differ' : ` across ${data.wholesalers.map(distributorName).join(', ')}`}
            {data.total > rows.length && ' — refine with search or sort to narrow'}
            {isFetching && <span className="bq-updating"> · updating…</span>}
          </div>
          {rows.length === 0 ? (
            <div className="bq-empty">No quantity discounts match these filters.</div>
          ) : (
            <div className="bq-grid">
              {rows.map((row: BestQdRow) => (
                <Card key={row.match_key} row={row} slugs={data.wholesalers}
                  isTop={(row.best_discount_pct ?? 0) > 0 && row.best_discount_pct === topPct} />
              ))}
            </div>
          )}
        </>
      )}
      </FilterSidebar>
    </div>
  );
}
