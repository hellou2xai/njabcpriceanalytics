import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  BadgeDollarSign, Trophy, AlertTriangle, Clock, Layers, Search,
  TrendingUp, Tag, ChevronRight,
} from 'lucide-react';
import { compare } from '../lib/api';
import type { BestRipRow, BestRipDist, BestRipTier } from '../lib/api';
import { distributorName } from '../lib/distributors';
import ProductSearchBox from '../components/ProductSearchBox';
import RipMembersModal from '../components/RipMembersModal';
import { ErrorState } from '../components/DataState';
import DataLoading from '../components/DataLoading';
import './BestRips.css';

const money = (v?: number | null) =>
  v == null ? '–' : `$${Number(v).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
const pct = (v?: number | null) => (v == null ? '–' : `${Number(v).toFixed(1)}%`);
const ACCENTS: Record<string, string> = { allied: '#2563eb', fedway: '#d97706', opici: '#7c3aed' };

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
  onRipClick: (wholesaler: string, code: string) => void;
}) {
  const accent = ACCENTS[w] || '#64748b';
  const name = distributorName(w);

  if (!d.has_rip) {
    return (
      <div className="br-dist br-dist--norip">
        <div className="br-dist-head">
          <span className="br-dist-name" style={{ color: accent }}>{name}</span>
          <span className="br-norip"><AlertTriangle size={12} /> No RIP this edition</span>
        </div>
      </div>
    );
  }

  const bestTierPct = Math.max(...d.tiers.map(t => t.rip_profit_pct ?? 0));

  return (
    <div className={`br-dist${isWinner ? ' br-dist--winner' : ''}`}>
      <div className="br-dist-head">
        <span className="br-dist-name" style={{ color: accent }}>{name}</span>
        {isWinner && (
          <span className="br-crown" title={`Best RIP profit${row.profit_delta ? ` (+${row.profit_delta}pp vs next)` : ''}`}>
            <Trophy size={12} /> best{row.profit_delta ? ` +${row.profit_delta}pp` : ''}
          </span>
        )}
        {d.rip_code && (
          <button className="br-code" onClick={() => onRipClick(w, String(d.rip_code))}
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

      <Link className="br-drill" to={detailUrl(w, row.product_name, row.upc)}>
        View product <ChevronRight size={13} />
      </Link>
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

function Card({ row, onRipClick }: { row: BestRipRow; onRipClick: (w: string, c: string) => void }) {
  const slugs = ['allied', 'fedway', 'opici'];
  const present = slugs.filter(w => row.dists[w]);
  const vint = wineVintage(row.product_type, row.vintage);
  const size = [row.unit_qty, row.unit_volume].filter(Boolean).join(' × ');

  return (
    <div className="br-card">
      <div className="br-card-head">
        <div className="br-card-title">
          <span className="br-name">{row.product_name}</span>
          <span className="br-meta">
            {size && <span>{size}</span>}
            {vint && <span className="br-vint">{vint}</span>}
            {row.upc && <span className="br-upc">UPC {row.upc}</span>}
          </span>
        </div>
        <div className="br-card-flags">
          {row.best_profit_pct != null && (
            <span className="br-headline" title="Best RIP profit across the three distributors">
              <TrendingUp size={13} /> {pct(row.best_profit_pct)}
            </span>
          )}
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
  const [onlyDiff, setOnlyDiff] = useState(true);
  const [tsOnly, setTsOnly] = useState(false);
  const [hideExpired, setHideExpired] = useState(true);
  const [minProfit, setMinProfit] = useState(0);
  const [modal, setModal] = useState<{ w: string; code: string } | null>(null);

  const params = useMemo(() => ({
    q: query || undefined,
    sort,
    only_differences: onlyDiff,
    time_sensitive_only: tsOnly,
    hide_expired: hideExpired,
    min_profit: minProfit || undefined,
    limit: 400,
  }), [query, sort, onlyDiff, tsOnly, hideExpired, minProfit]);

  const { data, isLoading, error } = useQuery({
    queryKey: ['best-rips', params],
    queryFn: () => compare.bestRips(params),
  });

  const edition = data ? Object.values(data.editions)[0] : null;

  return (
    <div className="br-page">
      <div className="br-hero">
        <div>
          <h1><BadgeDollarSign size={22} /> Best RIPs</h1>
          <p>The standout rebates across <b>Allied</b>, <b>Fedway</b> and <b>Opici</b> — one card per product,
            one line per RIP tier. <b>Needed for purchase</b> is net of the quantity discount;
            <b> RIP profit</b> is the rebate as a % of that cash down.</p>
        </div>
        {edition && <span className="br-edition"><Layers size={13} /> {edition}</span>}
      </div>

      <div className="br-toolbar">
        <div className="br-search">
          <Search size={15} className="br-search-ico" />
          <ProductSearchBox
            value={query}
            onChange={setQuery}
            onSelect={(p) => setQuery(p.product_name)}
            placeholder="Filter by product, brand or barcode…"
          />
        </div>
        <div className="br-sorts">
          {SORTS.map(s => (
            <button key={s.key} title={s.hint}
              className={`br-sort${sort === s.key ? ' br-sort--on' : ''}`}
              onClick={() => setSort(s.key)}>{s.label}</button>
          ))}
        </div>
      </div>

      <div className="br-filters">
        <label className="br-chk"><input type="checkbox" checked={onlyDiff} onChange={e => setOnlyDiff(e.target.checked)} /> Only where the three differ</label>
        <label className="br-chk"><input type="checkbox" checked={tsOnly} onChange={e => setTsOnly(e.target.checked)} /> Time-sensitive only</label>
        <label className="br-chk"><input type="checkbox" checked={hideExpired} onChange={e => setHideExpired(e.target.checked)} /> Hide expired tiers</label>
        <label className="br-range">
          Min RIP profit: <b>{minProfit}%</b>
          <input type="range" min={0} max={40} step={1} value={minProfit} onChange={e => setMinProfit(Number(e.target.value))} />
        </label>
      </div>

      {isLoading && <DataLoading />}
      {error && <ErrorState message="Could not load the Best RIPs board." />}
      {data && !isLoading && (
        <>
          <div className="br-count">
            {data.rows.length} of {data.total} products
            {onlyDiff ? ' where the three distributors differ' : ' with a RIP at one of the three'}
          </div>
          {data.rows.length === 0 ? (
            <div className="br-empty">No products match these filters. Try turning off “Only where the three differ”.</div>
          ) : (
            <div className="br-grid">
              {data.rows.map((row: BestRipRow) => (
                <Card key={row.match_key} row={row} onRipClick={(w, code) => setModal({ w, code })} />
              ))}
            </div>
          )}
        </>
      )}

      {modal && (
        <RipMembersModal wholesaler={modal.w} ripCode={modal.code} onClose={() => setModal(null)} />
      )}
    </div>
  );
}
