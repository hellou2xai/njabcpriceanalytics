import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  Percent, Trophy, AlertTriangle, Clock, Layers, Search,
  TrendingUp, TrendingDown, CalendarClock,
} from 'lucide-react';
import { compare } from '../lib/api';
import type { BestQdRow, BestQdDist, BestQdTier, BestQdTrend } from '../lib/api';
import { distributorName } from '../lib/distributors';
import ProductSearchBox from '../components/ProductSearchBox';
import ProductThumb from '../components/ProductThumb';
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

function Card({ row, slugs }: { row: BestQdRow; slugs: string[] }) {
  const present = slugs.filter(w => row.dists[w]);
  const vint = wineVintage(row.product_type, row.vintage);
  const size = [row.unit_qty, row.unit_volume].filter(Boolean).join(' × ');
  const primaryW = row.best_distributor || present[0];
  const productHref = primaryW ? detailUrl(primaryW, row.product_name, row.upc) : null;

  return (
    <div className="bq-card">
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

  const toggleDist = (w: string) => setDists(prev =>
    prev.includes(w)
      ? (prev.length > 1 ? prev.filter(x => x !== w) : prev)  // keep at least one
      : [...DIST_OPTS.filter(d => prev.includes(d) || d === w)]); // preserve canonical order

  const params = useMemo(() => ({
    q: query || undefined,
    sort,
    wholesalers: dists.join(','),
    months: months.length ? months.join(',') : undefined,  // empty -> latest two
    only_differences: onlyDiff,
    time_sensitive_only: tsOnly,
    hide_expired: hideExpired,
    min_discount: minDiscount || undefined,
    limit: 400,
  }), [query, sort, dists, months, onlyDiff, tsOnly, hideExpired, minDiscount]);

  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: ['best-qd', params],
    queryFn: () => compare.bestQd(params),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    placeholderData: (prev) => prev,
  });

  const selMonths = months.length ? months : (data?.months ?? []);
  const toggleMonth = (m: string) => {
    const base = months.length ? months : (data?.months ?? []);
    const next = base.includes(m) ? base.filter(x => x !== m) : [...base, m];
    setMonths(next.length ? next : base);   // keep at least one
  };

  return (
    <div className="bq-page">
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

      <div className="bq-toolbar">
        <div className="bq-search">
          <Search size={15} className="bq-search-ico" />
          <ProductSearchBox
            value={query}
            onChange={setQuery}
            onSelect={(p) => setQuery(p.product_name)}
            placeholder="Filter by product, brand or barcode…"
          />
        </div>
        <div className="bq-sorts">
          {SORTS.map(s => (
            <button key={s.key} title={s.hint}
              className={`bq-sort${sort === s.key ? ' bq-sort--on' : ''}`}
              onClick={() => setSort(s.key)}>{s.label}</button>
          ))}
        </div>
      </div>

      <div className="bq-filters">
        <span className="bq-distpick">
          <span className="bq-distpick-lbl">Distributors:</span>
          {DIST_OPTS.map(w => (
            <button key={w} type="button"
              className={`bq-distbtn${dists.includes(w) ? ' bq-distbtn--on' : ''}`}
              style={dists.includes(w) ? { borderColor: ACCENTS[w], color: ACCENTS[w] } : undefined}
              onClick={() => toggleDist(w)}>
              {distributorName(w)}
            </button>
          ))}
        </span>
        {data && data.available_months.length > 0 && (
          <span className="bq-distpick">
            <span className="bq-distpick-lbl">Months:</span>
            {data.available_months.map(m => (
              <button key={m} type="button"
                className={`bq-distbtn${selMonths.includes(m) ? ' bq-distbtn--on bq-monthbtn--on' : ''}`}
                onClick={() => toggleMonth(m)}>
                {monthLabel(m)}
              </button>
            ))}
          </span>
        )}
        <label className="bq-chk"><input type="checkbox" checked={onlyDiff} onChange={e => setOnlyDiff(e.target.checked)} /> Only where distributors differ</label>
        <label className="bq-chk"><input type="checkbox" checked={tsOnly} onChange={e => setTsOnly(e.target.checked)} /> Time-sensitive only</label>
        <label className="bq-chk"><input type="checkbox" checked={hideExpired} onChange={e => setHideExpired(e.target.checked)} /> Hide expired tiers</label>
        <label className="bq-range">
          Min discount: <b>{minDiscount}%</b>
          <input type="range" min={0} max={40} step={1} value={minDiscount} onChange={e => setMinDiscount(Number(e.target.value))} />
        </label>
      </div>

      {isLoading && <DataLoading />}
      {error && <ErrorState message="Could not load the Best QD board." />}
      {data && !isLoading && (
        <>
          <div className="bq-count">
            Showing {data.rows.length} of {data.total.toLocaleString()} products with a quantity discount
            {onlyDiff ? ' where the distributors differ' : ` across ${data.wholesalers.map(distributorName).join(', ')}`}
            {data.total > data.rows.length && ' — refine with search or sort to narrow'}
            {isFetching && <span className="bq-updating"> · updating…</span>}
          </div>
          {data.rows.length === 0 ? (
            <div className="bq-empty">No quantity discounts match these filters.</div>
          ) : (
            <div className="bq-grid">
              {data.rows.map((row: BestQdRow) => (
                <Card key={row.match_key} row={row} slugs={data.wholesalers} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
