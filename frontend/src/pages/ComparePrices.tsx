import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useQuery, keepPreviousData, useQueryClient } from '@tanstack/react-query';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { ChevronDown, ChevronUp, ChevronRight, Zap, Scale, Clock, Download, AlertTriangle, MessageSquare, BadgeCheck } from 'lucide-react';
import { compare, catalog } from '../lib/api';
import type { CatalogTier, CompareLadder, CompareRow } from '../lib/api';
import { distributorName, perUnitAbbr, abgSku, skuLabel } from '../lib/distributors';
import AvailabilityButton from '../components/AvailabilityButton';
import { useAuth } from '../contexts/AuthContext';
import RowActions from '../components/RowActions';
import ProductSearchBox from '../components/ProductSearchBox';
import TierBadge from '../components/TierBadge';
import FilterSidebar, { type FilterSection } from '../components/FilterSidebar';
import './ComparePrices.css';

const money = (v?: number | null) => (v == null ? '–' : `$${Number(v).toFixed(2)}`);

/** Distributor accent colors (cycled by pick order). */
const ACCENTS = ['#2563eb', '#d97706', '#7c3aed'];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtMonth = (ed: string) => {
  const m = /^(\d{4})-(\d{1,2})/.exec(ed);
  return m ? `${MONTHS[parseInt(m[2], 10) - 1]} ${m[1].slice(2)}` : ed;
};

/** 'Jun 9' from an ISO 'YYYY-MM-DD'. */
const fmtDay = (iso?: string | null) => {
  if (!iso) return '?';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${MONTHS[parseInt(m[2], 10) - 1]} ${parseInt(m[3], 10)}` : iso;
};
const winText = (from?: string | null, to?: string | null) => `${fmtDay(from)}–${fmtDay(to)}`;

function WinnerCell({
  value, prev, isWinner, isTie, best, sub, prevSub, mark, sep, mode = 'cur', curMonth, prevMonth,
}: {
  value?: number | null; prev?: number | null;
  isWinner: boolean; isTie: boolean; best?: boolean;
  sub?: string | null; prevSub?: string | null; mark?: ReactNode; sep?: boolean;
  mode?: 'cur' | 'prev' | 'both'; curMonth?: string; prevMonth?: string;
}) {
  // `best` = the cheapest effective (Best Net) cell in the row — the headline
  // winning price, shown in a yellow highlight with red text.
  const cls = `cmp-price${isWinner ? ' cmp-win' : ''}${best ? ' cmp-best' : ''}${isTie ? ' cmp-tie' : ''}${sep ? ' cmp-sep' : ''}`;
  // Last-month only: show the prior value (no winner highlight — that's a
  // current-month verdict).
  if (mode === 'prev') {
    return (
      <td className={`${cls} cmp-prevonly`}>
        {money(prev)}
        {prevSub && <span className="cmp-sub">{prevSub}</span>}
      </td>
    );
  }
  // Both: most-recent month on top (with the winner highlight), prior beneath,
  // each labelled with its month.
  if (mode === 'both') {
    return (
      <td className={`${cls} cmp-two`}>
        <span className="cmp-mrow">
          {curMonth && <span className="cmp-mlabel">{curMonth}</span>}
          <span className="cmp-mval">{money(value)}{mark}</span>
        </span>
        {sub && <span className="cmp-sub">{sub}</span>}
        <span className="cmp-mrow cmp-mrow-prev">
          {prevMonth && <span className="cmp-mlabel">{prevMonth}</span>}
          <span className="cmp-mval">{money(prev)}</span>
        </span>
      </td>
    );
  }
  return (
    <td className={cls}>
      {money(value)}
      {mark}
      {sub && <span className="cmp-sub">{sub}</span>}
    </td>
  );
}

interface HistPoint {
  edition: string;
  frontline_case_price?: number | null;
  best_case_price?: number | null;
  effective_case_price?: number | null;
}

/** Per-distributor sparkline: up to 3 lines across editions — List,
 *  After QD (best_case_price) and After RIP (effective). Lines collapse
 *  onto each other when layers are equal; hover any point for the month's
 *  full three-price readout. */
function TriSparkline({ wholesaler, ladder }: { wholesaler: string; ladder: CompareLadder }) {
  const { data } = useQuery({
    queryKey: ['price-history', wholesaler, ladder.product_name, ladder.upc,
               ladder.unit_volume, ladder.unit_qty, ladder.vintage],
    queryFn: () => catalog.priceHistory(wholesaler, ladder.product_name!, {
      upc: ladder.upc ?? undefined,
      unit_volume: ladder.unit_volume ?? undefined,
      unit_qty: ladder.unit_qty ?? undefined,
      vintage: ladder.vintage ?? undefined,
    }),
    enabled: !!ladder.product_name,
    staleTime: 5 * 60_000,
  });

  const points: HistPoint[] = (data?.history ?? []) as HistPoint[];
  if (points.length === 1) {
    // first month on record (e.g. newly onboarded distributor) — no trend yet
    return <span className="cmp-tri-flat">{fmtMonth(points[0].edition)} only — no history yet</span>;
  }
  if (points.length < 2) return null;

  const LAYERS: { key: keyof HistPoint; label: string; color: string; dash?: string }[] = [
    { key: 'frontline_case_price', label: 'List', color: 'var(--text-muted)', dash: '4 3' },
    { key: 'best_case_price', label: 'After QD', color: '#2563eb' },
    { key: 'effective_case_price', label: 'After RIP', color: '#16a34a' },
  ];
  const vals = points.flatMap(p => LAYERS.map(l => p[l.key]))
    .filter((v): v is number => typeof v === 'number');
  if (!vals.length) return null;

  const W = 230, H = 56, padX = 6, padY = 6;
  const min = Math.min(...vals), max = Math.max(...vals);
  const span = Math.max(0.0001, max - min);
  const x = (i: number) => padX + (i / (points.length - 1)) * (W - padX * 2);
  const y = (v: number) => padY + (1 - (v - min) / span) * (H - padY * 2);
  const money = (v?: number | null) => (typeof v === 'number' ? `$${v.toFixed(2)}` : '–');
  const tip = (p: HistPoint) =>
    `${fmtMonth(p.edition)} · List ${money(p.frontline_case_price)}`
    + ` · After QD ${money(p.best_case_price)} · After RIP ${money(p.effective_case_price)}`;

  // which layers actually exist (a no-RIP product collapses to 2 lines)
  const present = LAYERS.filter(l =>
    points.some(p => typeof p[l.key] === 'number'));

  return (
    <span className="cmp-tri">
      <svg width={W} height={H}>
        {present.map(l => {
          const pts = points
            .map((p, i) => ({ i, v: p[l.key] }))
            .filter((q): q is { i: number; v: number } => typeof q.v === 'number');
          if (pts.length < 2) return null;
          const d = pts.map((q, j) =>
            `${j === 0 ? 'M' : 'L'}${x(q.i).toFixed(1)},${y(q.v).toFixed(1)}`).join(' ');
          return <path key={l.label} d={d} fill="none" stroke={l.color}
                       strokeWidth={1.6} strokeDasharray={l.dash} />;
        })}
        {points.map((p, i) => {
          const v = p.effective_case_price ?? p.best_case_price ?? p.frontline_case_price;
          if (typeof v !== 'number') return null;
          return (
            <circle key={p.edition} cx={x(i)} cy={y(v)} r={5}
                    fill="transparent" stroke="none" pointerEvents="all">
              <title>{tip(p)}</title>
            </circle>
          );
        })}
      </svg>
      <span className="cmp-tri-leg">
        <span style={{ color: 'var(--text-muted)' }}>┄ List</span>
        <span style={{ color: '#2563eb' }}>— QD</span>
        <span style={{ color: '#16a34a' }}>— RIP</span>
      </span>
    </span>
  );
}

/** Plain-language walk-through of one distributor's List → Best QD → Best Net
 *  ladder, naming the limited-time deals that make Best Net exceed Best QD. */
function ladderLines(lad: CompareLadder): { text: string; warn?: boolean }[] {
  const f = lad.frontline, qd = lad.after_qd, net = lad.effective;
  const isLive = (s?: string | null) => s === 'active' || s === 'whole_month' || s === 'evergreen';
  const lines: { text: string; warn?: boolean }[] = [];
  if (f != null) lines.push({ text: `List ${money(f)}/cs.` });
  // the live discount tier that produced today's Best QD
  const liveDisc = (lad.tiers ?? []).filter(t => t.source === 'discount' && t.price_after != null && isLive(t.window_status));
  const qdTier = qd != null
    ? (liveDisc.find(t => Math.abs((t.price_after as number) - qd) < 0.005)
       ?? (liveDisc.length ? liveDisc.reduce((a, b) => ((a.price_after ?? Infinity) <= (b.price_after ?? Infinity) ? a : b)) : null))
    : null;
  if (qd != null && f != null && qd < f - 0.005) {
    const buy = qdTier ? `, buy ${qdTier.qty} ${qdTier.unit}` : '';
    const ends = qdTier?.window_status === 'active'
      ? ` (this deal runs ${fmtDay(qdTier.from_date)} to ${fmtDay(qdTier.to_date)})` : '';
    lines.push({ text: `Best QD ${money(qd)}/cs${buy}${ends}.`, warn: qdTier?.window_status === 'active' });
  } else if (qd != null && f != null) {
    lines.push({ text: `No quantity discount active (${money(qd)}/cs).` });
  }
  if (net != null && qd != null && net < qd - 0.005) {
    lines.push({ text: `Best Net ${money(net)}/cs. A RIP rebate takes off ${money(qd - net)}/cs more.` });
  }
  // a deeper discount that only starts later this month (not counted today)
  const upcoming = (lad.tiers ?? [])
    .filter(t => t.source === 'discount' && t.window_status === 'upcoming' && t.price_after != null
                 && net != null && (t.price_after as number) < net - 0.005)
    .sort((a, b) => (a.price_after as number) - (b.price_after as number))[0];
  if (upcoming) {
    lines.push({ text: `A deeper ${money(upcoming.price_after)}/cs deal starts ${fmtDay(upcoming.from_date)} (buy ${upcoming.qty} ${upcoming.unit}).` });
  }
  return lines;
}

function LadderPanel({ slugs, params, onOpen }: {
  slugs: string[]; params: Record<string, unknown>;
  onOpen: (name: string, wholesaler: string) => void;
}) {
  // Lazy: with details expanded by default, dozens of rows mount at once — only
  // fetch a row's ladders once it scrolls into view, so we don't fire one
  // /compare/tiers request per row up front.
  const ref = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (visible || !ref.current) return;
    const io = new IntersectionObserver(es => {
      for (const e of es) if (e.isIntersecting) { setVisible(true); io.disconnect(); break; }
    }, { rootMargin: '200px' });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [visible]);
  const { data, isLoading } = useQuery({
    queryKey: ['compare-tiers', params],
    queryFn: () => compare.tiers(params),
    enabled: visible,
  });
  if (!visible || isLoading) return <div ref={ref} className="cmp-ladder-loading">Loading deal ladders…</div>;
  if (!data) return null;
  return (
    <div className="cmp-ladders" style={{ gridTemplateColumns: `repeat(${slugs.length}, 1fr)` }}>
      {slugs.map(w => {
        const lad = data.ladders[w];
        return (
          <div key={w} className="cmp-ladder">
            <div className="cmp-ladder-head">
              <span>{distributorName(w)}</span>
              {lad && <TriSparkline wholesaler={w} ladder={lad} />}
            </div>
            {/* this distributor's OWN product, openable — a shared UPC can name
                two different products, so each side links to its own listing */}
            {lad?.product_name && (
              <button
                type="button"
                className="cmp-ladder-prodlink"
                title={`Open ${distributorName(w)}'s listing: ${lad.product_name}`}
                onClick={() => onOpen(lad.product_name!, w)}
              >
                {lad.product_name}
                {lad.unit_volume ? <span className="cmp-ladder-size"> · {lad.unit_qty} × {lad.unit_volume}</span> : null}
              </button>
            )}
            {/* Identifying info so near-identical SKUs are distinguishable:
                vintage (wine), proof/ABV, this distributor's item number, UPC. */}
            {lad && (() => {
              const vint = lad.vintage && !/^(0|0\.0+|na|n\/a|nv|none)$/i.test(String(lad.vintage)) ? String(lad.vintage) : null;
              const proof = lad.abv_proof && !/^(0|0\.0+|na|n\/a|none|nan)$/i.test(String(lad.abv_proof)) ? String(lad.abv_proof) : null;
              const sku = abgSku(w, lad.abg_sku);
              if (!vint && !proof && !sku && !lad.upc) return null;
              return (
                <div className="cmp-ladder-ids">
                  {vint && <span className="cmp-ladder-vintage">Vintage {vint}</span>}
                  {proof && <span>{proof} proof/ABV</span>}
                  {sku && <span>{skuLabel(w)} {lad.abg_sku}</span>}
                  {lad.upc && <span>UPC {lad.upc}</span>}
                </div>
              );
            })()}
            {lad && (
              <div className="cmp-ladder-avail">
                <AvailabilityButton wholesaler={w} name={lad.product_name} itemNumber={lad.abg_sku} />
              </div>
            )}
            {!lad ? <div className="cmp-ladder-none">Not found</div> : (
              <>
                <div className="cmp-ladder-line cmp-ladder-front">
                  Frontline → <strong>{money(lad.frontline)}</strong>/cs
                </div>
                {(lad.tiers ?? []).length === 0 && (
                  <div className="cmp-ladder-none">No QD or RIP tiers</div>
                )}
                {/* today's view: hide expired deals (they only confuse), mark a
                    deal that ENDS this month, and label one that hasn't started */}
                {(lad.tiers ?? []).filter(t => t.window_status !== 'expired').map((t: CatalogTier, i: number) => (
                  <div key={i} className={`cmp-ladder-line${t.window_status === 'upcoming' ? ' cmp-ladder-soon' : ''}`}>
                    <TierBadge kind={t.source === 'rip' ? 'rip' : 'qd'} />
                    {' '}Buy {t.qty} {t.unit} → <strong>{money(t.price_after)}</strong>/cs
                    {t.save_per_case != null && (
                      <span className="cmp-ladder-off"
                        title="Total discount off the list price at this tier, per case.">
                        {' '}(−{money(t.save_per_case)}/cs)
                      </span>
                    )}
                    {t.window_status === 'active' && (
                      <span className="cmp-ladder-window"
                            title={`Live now, valid ${fmtDay(t.from_date)} to ${fmtDay(t.to_date)}.`}>
                        <Clock size={9} /> {fmtDay(t.from_date)} to {fmtDay(t.to_date)}
                      </span>
                    )}
                    {t.window_status === 'upcoming' && (
                      <span className="cmp-ladder-window cmp-ladder-upcoming"
                            title={`Not live yet; starts ${fmtDay(t.from_date)}.`}>
                        starts {fmtDay(t.from_date)}
                      </span>
                    )}
                  </div>
                ))}
                {/* plain-language readout of today's price and any deal timing */}
                <div className="cmp-ladder-explain">
                  {ladderLines(lad).map((ln, i) => (
                    <div key={i} className={`cmp-ladder-exp${ln.warn ? ' cmp-ladder-exp-warn' : ''}`}>
                      {ln.warn && <Clock size={11} />} {ln.text}
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function ComparePrices() {
  const [params, setSearchParams] = useSearchParams();
  const [selected, setSelected] = useState<string[]>(
    params.get('d')?.split(',').filter(Boolean) ?? []);
  const [q, setQ] = useState(params.get('q') ?? '');
  // debounced copy of q that drives the (heavy) grid query, so the comparison
  // doesn't refetch on every keystroke. Matches the Products page feel.
  const [qDebounced, setQDebounced] = useState(q);
  const [ptype, setPtype] = useState(params.get('type') ?? '');
  // default ON: open straight to the rows where distributors actually differ
  const [onlyDiff, setOnlyDiff] = useState(params.get('diff') !== '0');
  // Default to a $1/case minimum spread so the grid leads with real price gaps
  // (tiny rounding-level differences are filtered out unless the user clears it).
  const [minSpread, setMinSpread] = useState(params.get('min') ?? '1');
  // 0 = each distributor's best deal (deepest tier); >0 = landed price at that volume
  const [cases, setCases] = useState(params.get('cs') ?? '0');
  // Confidence filter. high (default) = hide rows an admin has commented/flagged;
  // commented = only those (admin review); all = everything. Public is always
  // forced to 'high' server-side. Admins can write a comment to flag a row.
  const { user } = useAuth();
  const isAdmin = !!user?.is_admin;
  const queryClient = useQueryClient();
  const [confidence, setConfidence] = useState(params.get('conf') ?? 'high');
  // Admin-only "verified" review filter for THIS pair: all | yes | no.
  const [verifiedFilter, setVerifiedFilter] = useState(params.get('vf') ?? 'all');
  // Physical-size filter (standardized buckets: 750ML, 1.75L, ...), client-side
  // over the loaded common set. Empty = all sizes.
  const [sizes, setSizes] = useState<string[]>(params.get('sz')?.split(',').filter(Boolean) ?? []);
  // Default sort = biggest % spread first: the percentage gap is the fairer
  // "is it worth switching distributor" signal (a $1,950 gap on a $30k bottle is
  // only 7%, while $90 on a $224 item is 40%+). (Column headers still re-sort;
  // the rail "Sort by" mirrors this; the $ gap is shown under each %.)
  const [sortKey, setSortKey] = useState(params.get('s') ?? 'spread_pct');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>(params.get('dir') === 'asc' ? 'asc' : 'desc');
  // Price Comparison view: 'cur' = this month, 'next' = next month (when that
  // edition is loaded), 'prev' = last month, 'both' = both stacked. 'prev'/'both'
  // fetch the prior-edition layers (months=2); 'next' compares at the next edition.
  const [priceMonths, setPriceMonths] = useState<'cur' | 'next' | 'prev' | 'both'>('cur');
  // Default to NEXT month once, when that edition is loaded (buyer planning the
  // upcoming month). Only auto-flips while still on the initial 'cur'.
  const autoNextDone = useRef(false);
  // Row detail expansion. Details are COLLAPSED BY DEFAULT (allExpanded=false)
  // for a clean professional table; `toggled` holds the rows the user flipped
  // against the default, so a row is open when allExpanded XOR toggled.has(key).
  // The "Expand all / Collapse all" control on top sets allExpanded and clears
  // the exceptions.
  const [allExpanded, setAllExpanded] = useState(false);
  const [toggled, setToggled] = useState<Set<string>>(new Set());
  const isExpanded = (key: string) => allExpanded !== toggled.has(key);
  const toggleRow = (key: string) => setToggled(prev => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const setAll = (open: boolean) => { setAllExpanded(open); setToggled(new Set()); };
  const PAGE_SIZES = [50, 100, 250, 500, 1000];
  const [pageSize, setPageSize] = useState(() => {
    const v = parseInt(params.get('pp') ?? '100', 10);
    return PAGE_SIZES.includes(v) ? v : 100;
  });
  const [shown, setShown] = useState(pageSize);
  const navigate = useNavigate();
  const goToProduct = (name: string, wholesaler?: string) =>
    navigate(`/products?q=${encodeURIComponent(name)}${wholesaler ? `&wholesaler=${wholesaler}` : ''}`);

  // URL sync (shareable / survives Back)
  useEffect(() => {
    const next = new URLSearchParams();
    if (selected.length) next.set('d', selected.join(','));
    if (q) next.set('q', q);
    if (ptype) next.set('type', ptype);
    if (!onlyDiff) next.set('diff', '0');
    if (minSpread) next.set('min', minSpread);
    if (cases && cases !== '0') next.set('cs', cases);
    if (sizes.length) next.set('sz', sizes.join(','));
    if (confidence !== 'high') next.set('conf', confidence);
    if (verifiedFilter !== 'all') next.set('vf', verifiedFilter);
    if (sortKey !== 'spread_pct') next.set('s', sortKey);
    if (sortDir !== 'desc') next.set('dir', sortDir);
    if (pageSize !== 100) next.set('pp', String(pageSize));
    if (next.toString() !== params.toString()) setSearchParams(next, { replace: true });
  }, [selected, q, ptype, onlyDiff, minSpread, cases, sizes, confidence, verifiedFilter, sortKey, sortDir, pageSize]);

  // page-size change resets the visible window
  useEffect(() => { setShown(pageSize); }, [pageSize]);

  const { data: options } = useQuery({
    queryKey: ['compare-options'],
    queryFn: compare.options,
  });

  const ready = selected.length >= 2 && selected.length <= 3;
  // debounce the typed query into qDebounced (backend matches name/brand AND barcode)
  useEffect(() => {
    const t = setTimeout(() => setQDebounced(q), 250);
    return () => clearTimeout(t);
  }, [q]);
  const { data, isLoading, error } = useQuery({
    queryKey: ['compare-products', selected, qDebounced, ptype, onlyDiff, minSpread, cases, priceMonths, confidence, verifiedFilter],
    queryFn: () => compare.products({
      wholesalers: selected.join(','),
      q: qDebounced || undefined,
      product_type: ptype || undefined,
      only_differences: onlyDiff || undefined,
      min_spread: minSpread ? parseFloat(minSpread) : undefined,
      cases: cases && cases !== '0' ? parseFloat(cases) : undefined,
      // 'prev'/'both' need the prior-edition layers; 'next' compares AT the next
      // edition (single month), 'cur' is the current month.
      months: (priceMonths === 'prev' || priceMonths === 'both') ? 2 : undefined,
      month_mode: priceMonths === 'next' ? 'next' : 'cur',
      confidence,   // high (default, hides admin-commented rows) | commented | all
      verified: isAdmin && verifiedFilter !== 'all' ? verifiedFilter : undefined,
    }),
    enabled: ready,
    // Keep the current grid + toolbar on screen while a new view loads (or if it
    // errors), so toggling the Price Comparison radio never blanks the controls.
    placeholderData: keepPreviousData,
  });

  // Default to next month once it's loaded (buyer plans the upcoming month),
  // unless the user has already picked a month view.
  useEffect(() => {
    if (!autoNextDone.current && data?.next_available && priceMonths === 'cur') {
      autoNextDone.current = true;
      setPriceMonths('next');
    }
  }, [data?.next_available, priceMonths]);

  const toggle = (w: string) => {
    setAll(false);
    setShown(pageSize);
    setSelected(s => s.includes(w) ? s.filter(x => x !== w)
      : s.length >= 3 ? s : [...s, w]);
  };

  // Admin: add/edit/clear a row comment. A commented row is "low confidence" and
  // is hidden from the public by the default High-confidence filter.
  const editComment = async (r: CompareRow) => {
    const next = window.prompt(
      `Admin comment for "${r.product_name}" (${r.edition || ''}).\n` +
      `A commented row is hidden from public view (default High-confidence filter). ` +
      `Leave blank to clear.`,
      r.comment ?? '');
    if (next === null) return;   // cancelled
    try {
      await compare.setRowComment({
        edition: r.edition || '', match_key: r.match_key,
        comment: next.trim(), product_name: r.product_name,
      });
      queryClient.invalidateQueries({ queryKey: ['compare-products'] });
    } catch {
      alert('Could not save the comment.');
    }
  };

  // Admin: toggle the "verified" mark for THIS comparison pair (header-level).
  // Confirms the two matched items look correct for this exact (edition, pair);
  // it does not hide the row, and the public never sees it.
  const toggleVerified = async (r: CompareRow) => {
    const pair = data?.pair;
    if (!pair) return;
    try {
      await compare.setRowVerified({
        edition: r.edition || '', pair, match_key: r.match_key,
        verified: !r.verified, product_name: r.product_name,
      });
      queryClient.invalidateQueries({ queryKey: ['compare-products'] });
    } catch {
      alert('Could not update the verified mark.');
    }
  };

  const accent = useMemo(() => {
    const m: Record<string, string> = {};
    selected.forEach((w, i) => { m[w] = ACCENTS[i % ACCENTS.length]; });
    return m;
  }, [selected]);

  // download the current summary grid as .xlsx (same filters as the table)
  const [exporting, setExporting] = useState(false);
  const exportExcel = async () => {
    if (!ready) return;
    setExporting(true);
    try {
      const blob = await compare.exportXlsx({
        wholesalers: selected.join(','),
        q: qDebounced || undefined,
        product_type: ptype || undefined,
        only_differences: onlyDiff || undefined,
        min_spread: minSpread ? parseFloat(minSpread) : undefined,
        cases: cases && cases !== '0' ? parseFloat(cases) : undefined,
        month_mode: priceMonths === 'next' ? 'next' : 'cur',
        confidence,
        sizes: sizes.length ? sizes.join(',') : undefined,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `compare_${selected.join('_')}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert(`Export failed: ${(e as Error).message}`);
    } finally {
      setExporting(false);
    }
  };

  const types = useMemo(() => {
    const set = new Set<string>();
    (data?.rows ?? []).forEach(r => { if (r.product_type) set.add(r.product_type); });
    return [...set].sort();
  }, [data]);

  const winnerName = (w: string | null) =>
    w == null ? '–' : w === 'tie' ? 'Tie' : distributorName(w);

  const atVol = !!(cases && cases !== '0');

  // ---- client-side sorting: every column is sortable ----
  const clickSort = (key: string, numericDefault: 'asc' | 'desc' = 'asc') => {
    setShown(pageSize);
    if (sortKey === key) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'product' || key === 'winner' ? 'asc' : numericDefault);
    }
  };

  const arrow = (key: string) =>
    sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';

  // Size options for the rail, derived from the FULL loaded set (so they don't
  // vanish as you filter), most-common sizes first.
  const sizeOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of data?.rows ?? []) {
      const s = (r.unit_volume_std || r.unit_volume || '').trim();
      if (s) counts.set(s, (counts.get(s) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => v);
  }, [data]);

  const rows = useMemo(() => {
    const sizeSet = new Set(sizes);
    const base = (data?.rows ?? []).filter(r =>
      sizeSet.size === 0 || sizeSet.has((r.unit_volume_std || r.unit_volume || '').trim()));
    const dir = sortDir === 'asc' ? 1 : -1;
    const missing = sortDir === 'asc' ? Infinity : -Infinity;
    const val = (r: (typeof base)[number]): string | number => {
      if (sortKey === 'product') return (r.product_name || '').toLowerCase();
      if (sortKey === 'winner') return r.winner_effective === 'tie' ? 'zzz-tie'
        : (r.winner_effective ? distributorName(r.winner_effective).toLowerCase() : 'zzzz');
      if (sortKey === 'spread') return r.spread ?? missing;
      if (sortKey === 'spread_pct') return r.spread_pct ?? missing;
      const [w, field] = sortKey.split('::');
      const p = r.prices[w] as Record<string, unknown> | undefined;
      const v = p?.[field];
      return typeof v === 'number' ? v : missing;
    };
    base.sort((a, b) => {
      const va = val(a), vb = val(b);
      if (typeof va === 'string' || typeof vb === 'string') {
        return String(va) < String(vb) ? -dir : String(va) > String(vb) ? dir : 0;
      }
      return (va as number) < (vb as number) ? -dir : (va as number) > (vb as number) ? dir : 0;
    });
    return base;
  }, [data, sortKey, sortDir, sizes]);

  const sum = data?.summary;
  const nCols = selected.length * 3 + 4;

  const resetFilters = () => {
    setQ(''); setPtype(''); setOnlyDiff(true); setMinSpread('1');
    setCases('0'); setPriceMonths('cur'); setSizes([]); setShown(pageSize);
  };

  const sections: FilterSection[] = [
    // Sort pinned to the TOP of the rail (matches Edition Comparison). The
    // value encodes key:dir; the clickable column headers update the same state,
    // so this dropdown always reflects the current sort.
    { type: 'select', key: 'sort', title: 'Sort by', highlight: true,
      value: `${sortKey}:${sortDir}`,
      options: [
        { value: 'spread:desc', label: 'Biggest spread ($)' },
        { value: 'spread_pct:desc', label: 'Biggest spread (%)' },
        { value: 'product:asc', label: 'Product name (A-Z)' },
        { value: 'winner:asc', label: 'Winner' },
      ],
      onChange: (v) => { const [k, d] = v.split(':'); setSortKey(k); setSortDir(d as 'asc' | 'desc'); } },
    { type: 'custom', key: 'q', title: 'Product',
      render: () => (
        <ProductSearchBox value={q}
          onChange={v => { setQ(v); setShown(pageSize); }}
          onSelect={p => { setQ(p.product_name); setShown(pageSize); }}
          placeholder="Product, brand or UPC…" />
      ) },
    { type: 'select', key: 'cat', title: 'Category', placeholder: 'All categories',
      value: ptype, options: types.map(t => ({ label: t, value: t })),
      onChange: setPtype },
    ...(sizeOptions.length > 1 ? [{ type: 'multi-pills' as const, key: 'sizes', title: 'Size',
      options: sizeOptions.map(s => ({ value: s, label: s })),
      values: sizes,
      onChange: (v: string[]) => { setSizes(v); setShown(pageSize); } }] : []),
    { type: 'toggle', key: 'diff', title: 'Differences', label: 'Only differences',
      value: onlyDiff, onChange: setOnlyDiff },
    { type: 'custom', key: 'min', title: 'Min $ spread',
      render: () => (
        <input className="filter-text" type="number" min={0} placeholder="Min $ spread"
          value={minSpread} onChange={e => setMinSpread(e.target.value)} />
      ) },
    { type: 'select', key: 'vol', title: 'Volume',
      value: cases,
      options: [['0', 'Best deal'], ['1', '1 cs'], ['2', '2 cs'], ['3', '3 cs'],
                ['5', '5 cs'], ['10', '10 cs'], ['25', '25 cs'], ['50', '50 cs']]
        .map(([v, l]) => ({ value: v, label: l })),
      onChange: (v) => { setCases(v); setShown(pageSize); } },
    { type: 'pills', key: 'months', title: 'Price Comparison',
      value: priceMonths,
      // "Next month" appears only when that edition is already loaded.
      options: [
        { value: 'cur', label: 'This month' },
        ...(data?.next_available ? [{ value: 'next', label: 'Next month' }] : []),
        { value: 'prev', label: 'Last month' },
        { value: 'both', label: 'Both' },
      ],
      onChange: (v) => { autoNextDone.current = true; setPriceMonths(v as 'cur' | 'next' | 'prev' | 'both'); setShown(pageSize); } },
    // Admin-only: a commented row is hidden from everyone by the default 'High'
    // filter; flip to Flagged to review/edit them. Public never sees this.
    ...(isAdmin ? [{ type: 'pills' as const, key: 'conf', title: 'Confidence (admin)',
      value: confidence,
      options: [
        { value: 'high', label: 'High (no flags)' },
        { value: 'commented', label: 'Flagged' },
        { value: 'all', label: 'All' },
      ],
      onChange: (v: string) => { setConfidence(v); setShown(pageSize); } }] : []),
    // Admin-only: filter by the per-pair "verified" mark so you can work through
    // the matches you haven't checked yet for this exact distributor comparison.
    ...(isAdmin ? [{ type: 'pills' as const, key: 'vf', title: 'Verified (admin)',
      value: verifiedFilter,
      options: [
        { value: 'all', label: 'All' },
        { value: 'yes', label: 'Verified' },
        { value: 'no', label: 'Unverified' },
      ],
      onChange: (v: string) => { setVerifiedFilter(v); setShown(pageSize); } }] : []),
  ];

  return (
    <div className="page">
      {/* wrapper keeps this h2 out of the global `.page > h2` sticky rule,
          whose negative margins clipped the picker row below it */}
      <div className="cmp-head">
        <h2><Scale size={20} style={{ verticalAlign: '-3px', marginRight: 8 }} />Compare Distributor Price</h2>
      </div>

      {/* ---- distributor picker ---- */}
      <div className="cmp-picker">
        <span className="cmp-picker-label">Pick 2–3 distributors:</span>
        {(options ?? []).map(o => (
          <button
            key={o.wholesaler}
            className={`cmp-chip${selected.includes(o.wholesaler) ? ' on' : ''}`}
            style={selected.includes(o.wholesaler)
              ? { borderColor: accent[o.wholesaler], color: accent[o.wholesaler] } : undefined}
            onClick={() => toggle(o.wholesaler)}
            disabled={!selected.includes(o.wholesaler) && selected.length >= 3}
            title={!selected.includes(o.wholesaler) && selected.length >= 3
              ? 'Maximum 3 — deselect one first'
              : `${o.products.toLocaleString()} products · edition ${o.edition ?? '–'}`}
          >
            {distributorName(o.wholesaler)}
            <span className="cmp-chip-n">{o.products.toLocaleString()}</span>
          </button>
        ))}
        {selected.length > 0 && (
          <button className="cmp-clear" onClick={() => { setSelected([]); setAll(false); }}>
            Clear
          </button>
        )}
      </div>

      {!ready && (
        <div className="cmp-empty">
          Select two or three distributors above to compare every product they have
          in common — list price, price after quantity discounts (QD), and the
          effective price after RIP rebates. Only common products are shown, so
          every row is a real head-to-head.
        </div>
      )}

      {ready && isLoading && <p>Comparing catalogues…</p>}
      {ready && !!error && <p className="text-red">Failed to compare: {String((error as Error).message)}</p>}

      {ready && data && (
        <>
          {/* ---- summary scoreboard ---- */}
          <div className="cmp-cards">
            <div className="cmp-card">
              <div className="cmp-card-n">{data.total_common.toLocaleString()}</div>
              <div className="cmp-card-l">products in common</div>
            </div>
            {selected.map(w => (
              <div className="cmp-card" key={w} style={{ borderTop: `3px solid ${accent[w]}` }}>
                <div className="cmp-card-n">{sum?.wins_effective[w] ?? 0}</div>
                <div className="cmp-card-l">{distributorName(w)} cheapest</div>
              </div>
            ))}
            <div className="cmp-card">
              <div className="cmp-card-n">{sum?.ties ?? 0}</div>
              <div className="cmp-card-l">ties</div>
            </div>
            <div className="cmp-card">
              <div className="cmp-card-n"><Zap size={16} style={{ verticalAlign: '-2px' }} /> {sum?.deal_flips ?? 0}</div>
              <div className="cmp-card-l">winner flips after deals</div>
            </div>
            <div className="cmp-card cmp-card-save"
              title="Total you'd save by buying each shared product from its cheapest distributor (one case of each) instead of always from the most expensive.">
              <div className="cmp-card-n">{money(sum?.total_spread)}</div>
              <div className="cmp-card-l">savings buying each at its cheapest</div>
            </div>
          </div>

          <FilterSidebar storageKey="compare-prices" sections={sections} onReset={resetFilters}>
          {/* ---- results header (display controls; filters live in the rail) ---- */}
          <div className="cmp-filters">
            <button type="button" className="cmp-expandall"
              onClick={() => setAll(!allExpanded)}
              title={allExpanded ? 'Collapse every row’s deal detail' : 'Expand every row’s deal detail'}>
              {allExpanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
              {allExpanded ? 'Collapse all' : 'Expand all'}
            </button>
            <span className="cmp-hint">Click any column header to sort</span>
            <label className="cmp-pp">
              Rows/page
              <select value={pageSize} onChange={e => setPageSize(parseInt(e.target.value, 10))}>
                {PAGE_SIZES.map(n => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            <span className="cmp-count">{rows.length.toLocaleString()} rows</span>
            <button
              className="cmp-export"
              onClick={exportExcel}
              disabled={exporting || rows.length === 0}
              title="Download the summary grid (current filters) as an Excel file"
            >
              <Download size={14} /> {exporting ? 'Preparing…' : 'Excel'}
            </button>
          </div>

          <div className={`cmp-basis${atVol ? ' cmp-basis-vol' : ''}`}>
            {atVol
              ? <>Deal columns show the <strong>landed price at {cases} case(s)</strong> — the discount/RIP you'd actually qualify for at that volume. The cheaper distributor can change as you change volume.</>
              : <>Deal columns show each distributor's <strong>best deal</strong> (deepest QD + RIP tier), which can need a high volume to reach. Set <strong>Volume</strong> above to see the price at the quantity you plan to buy.</>}
          </div>

          {/* ---- comparison grid ---- */}
          <div className="table-container">
            <table className="dense-table cmp-table">
              <thead>
                <tr>
                  <th rowSpan={2} className="cmp-sortable" onClick={() => clickSort('product')}>
                    Product{arrow('product')}
                  </th>
                  {selected.map(w => (
                    <th key={w} colSpan={3} className="cmp-group-head cmp-sep"
                        style={{ borderBottom: `2px solid ${accent[w]}` }}>
                      {distributorName(w)}
                      <span className="cmp-ed">
                        {priceMonths === 'prev' && data.prev_editions?.[w]
                          ? fmtMonth(data.prev_editions[w])
                          : priceMonths === 'both' && data.prev_editions?.[w]
                            ? `${fmtMonth(data.editions[w])} vs ${fmtMonth(data.prev_editions[w])}`
                            : fmtMonth(data.editions[w])}
                      </span>
                    </th>
                  ))}
                  <th rowSpan={2} className="cmp-sortable cmp-sep" onClick={() => clickSort('spread_pct', 'desc')}
                      title="Price gap between the cheapest and dearest distributor, as a percentage of the cheapest. The dollar gap is shown underneath.">
                    Spread %{arrow('spread_pct')}
                  </th>
                  <th rowSpan={2} className="cmp-sortable" onClick={() => clickSort('winner')}>
                    Winner{arrow('winner')}
                  </th>
                  <th rowSpan={2}></th>
                </tr>
                <tr>
                  {selected.map(w => (
                    <Fragment key={w}>
                      <th className="cmp-layer cmp-sortable cmp-sep" onClick={() => clickSort(`${w}::frontline`)}>
                        List{arrow(`${w}::frontline`)}
                      </th>
                      <th className="cmp-layer cmp-sortable" onClick={() => clickSort(`${w}::after_qd`)}
                          title={atVol ? `Price after the quantity discount you'd qualify for at ${cases} case(s)` : "Best (deepest) quantity-discount price — may need a high volume to reach"}>
                        {atVol ? `QD @${cases}cs` : 'Best QD'}{arrow(`${w}::after_qd`)}
                      </th>
                      <th className="cmp-layer cmp-sortable" onClick={() => clickSort(`${w}::effective`)}
                          title={atVol ? `Landed price at ${cases} case(s): after QD + the best RIP rebate you can actually reach at that volume` : "Best effective price: after quantity discounts + best full-month RIP rebate (deepest tier)"}>
                        {atVol ? `Net +RIP @${cases}cs` : 'Best net +RIP'}{arrow(`${w}::effective`)}
                      </th>
                    </Fragment>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, shown).map((r, idx) => {
                  const isOpen = isExpanded(r.match_key);
                  const winner = r.winner_effective;
                  return (
                    <Fragment key={r.match_key}>
                      <tr className={`clickable${idx % 2 ? ' cmp-row-alt' : ''}`} onClick={() => toggleRow(r.match_key)}>
                        <td className="cmp-prod">
                          {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                          {/* Plain text (no hyperlink): clicking the row expands
                              it; users open individual items from the expanded
                              detail. */}
                          <span className="cmp-prod-name">
                            {r.product_name}
                          </span>
                          <span className="cmp-size">
                            {r.unit_qty} × {r.unit_volume}{r.vintage ? ` · ${r.vintage}` : ''}
                          </span>
                          {/* The identity this match is keyed on, shown so the
                              buyer can verify it: shared UPC + each distributor's
                              own part number, under the case-pack + volume. */}
                          <span className="cmp-ident">
                            {r.upc ? <span className="cmp-ident-upc">UPC {r.upc}</span> : null}
                            {selected.map(w => {
                              const it = r.prices[w]?.item_no;
                              return abgSku(w, it)
                                ? <span key={w} className="cmp-ident-sku">{distributorName(w)} {skuLabel(w)} {it}</span>
                                : null;
                            })}
                          </span>
                          {r.deal_flip && (
                            <span
                              className="cmp-flip"
                              title={`${winnerName(r.winner_frontline)} is cheaper at list, but ${winnerName(r.winner_effective)} wins after QD/RIP deals`}
                            >
                              <Zap size={11} /> flips
                            </span>
                          )}
                          {r.has_expiring && (
                            <span
                              className="cmp-ltd"
                              title="Today's price for at least one distributor uses a dated deal that ends this month. Open the row to see the date and any deal that starts later."
                            >
                              <Clock size={11} /> ends soon
                            </span>
                          )}
                          {isAdmin && (
                            <button
                              className={`cmp-verify-btn${r.verified ? ' on' : ''}`}
                              title={r.verified
                                ? `Verified for ${winnerName(selected[0])} vs ${selected.slice(1).map(winnerName).join(' / ')} — click to unverify`
                                : 'Mark this match verified (both items look correct) for this comparison'}
                              onClick={(e) => { e.stopPropagation(); toggleVerified(r); }}
                            >
                              <BadgeCheck size={13} />
                            </button>
                          )}
                          {isAdmin && (
                            <button
                              className={`cmp-comment-btn${r.has_comment ? ' flagged' : ''}`}
                              title={r.has_comment
                                ? `Flagged (hidden from public): ${r.comment ?? ''} — click to edit`
                                : 'Add admin comment (flags + hides this row from public)'}
                              onClick={(e) => { e.stopPropagation(); editComment(r); }}
                            >
                              <MessageSquare size={12} />
                            </button>
                          )}
                          {isAdmin && r.has_comment && r.comment && (
                            <span className="cmp-comment-text" title={r.comment}>{r.comment}</span>
                          )}
                        </td>
                        {selected.map(w => {
                          const p = r.prices[w];
                          const curMo = fmtMonth(data.editions[w] || '');
                          const prevMo = data.prev_editions?.[w] ? fmtMonth(data.prev_editions[w]) : undefined;
                          const mUnit = perUnitAbbr(r.unit_volume, r.unit_type);
                          return (
                            <Fragment key={w}>
                              <WinnerCell value={p?.frontline} prev={p?.prev?.frontline} sep
                                mode={priceMonths} curMonth={curMo} prevMonth={prevMo}
                                isWinner={r.winner_frontline === w} isTie={r.winner_frontline === 'tie'}
                                sub={abgSku(w, p?.item_no) ? `${skuLabel(w)} ${p?.item_no}` : null} />
                              <WinnerCell value={p?.after_qd} prev={p?.prev?.after_qd}
                                mode={priceMonths} curMonth={curMo} prevMonth={prevMo}
                                isWinner={r.winner_after_qd === w} isTie={r.winner_after_qd === 'tie'}
                                mark={p?.qd_time_sensitive ? (
                                  <span className="cmp-ts" title={`Today's price uses a dated deal that ends ${p.deal_window ? fmtDay(p.deal_window.to) : 'this month'}.`}>
                                    <Clock size={10} />
                                  </span>
                                ) : null} />
                              <WinnerCell value={p?.effective} prev={p?.prev?.effective}
                                mode={priceMonths} curMonth={curMo} prevMonth={prevMo}
                                isWinner={winner === w} isTie={winner === 'tie'} best={winner === w}
                                sub={p?.btl_effective != null ? `${money(p.btl_effective)}/${mUnit}` : null}
                                prevSub={p?.prev?.btl_effective != null ? `${money(p.prev.btl_effective)}/${mUnit}` : null} />
                            </Fragment>
                          );
                        })}
                        <td className="cmp-spread cmp-sep">
                          {r.spread_pct != null ? `${r.spread_pct}%` : money(r.spread)}
                          {r.spread_pct != null && <span className="cmp-sub">{money(r.spread)}</span>}
                          {r.spread_pct != null && r.spread_pct > 100 && (
                            <span className="cmp-suspicious"
                              title="This price gap is over 100% — almost always a distributor filing/data error (e.g. a pack-size mismatch under one shared barcode), not a real deal. Verify with your sales rep before trusting it.">
                              <AlertTriangle size={11} /> check
                            </span>
                          )}
                        </td>
                        <td>
                          {winner && winner !== 'tie' ? (
                            <span className="cmp-winner" style={{ color: accent[winner] }}>
                              {distributorName(winner)}
                            </span>
                          ) : <span className="cmp-tie-label">Tie</span>}
                        </td>
                        <td className="cmp-actions">
                          <RowActions
                            productName={r.prices[winner && winner !== 'tie' ? winner : selected[0]]?.product_name ?? r.product_name}
                            wholesaler={winner && winner !== 'tie' ? winner : selected[0]}
                            upc={r.upc ?? undefined}
                            unitVolume={r.unit_volume ?? undefined}
                            unitQty={r.unit_qty ?? undefined}
                          />
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="cmp-expand-row">
                          <td colSpan={nCols}>
                            <LadderPanel
                              slugs={selected}
                              onOpen={goToProduct}
                              params={{
                                wholesalers: selected.join(','),
                                upc_norm: r.upc_norm,
                                // pin the ladder to the row's FULL identity
                                // (upc|size|pack|vintage) so a shared barcode can't
                                // pull a different pack/vintage into the detail.
                                match_key: r.match_key,
                                size_key: r.size_key || undefined,
                                // ladder MUST resolve the same month as the grid
                                month_mode: priceMonths === 'next' ? 'next' : 'cur',
                              }}
                            />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
                {rows.length === 0 && (
                  <tr><td colSpan={nCols} className="cmp-none">
                    {data.total_common === 0 ? (
                      <>
                        These {selected.length} distributors have <strong>no products in common</strong> —
                        they likely serve different categories (beer houses overlap with beer houses,
                        wine/spirits houses with each other). Deselect one and try again.
                      </>
                    ) : onlyDiff ? (
                      <>All {data.total_common.toLocaleString()} common products matching the filters
                        are priced identically — untick “Only differences” to see them.</>
                    ) : (
                      <>No common products match the filters.</>
                    )}
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
          {/* Clear end-of-section footer so the bottom of the table is never
              ambiguous (and the last rows clear the floating assistant button /
              horizontal scrollbar). Shows a Show-more action while rows remain,
              else an explicit end marker. */}
          {rows.length > 0 && (
            <div className="cmp-foot">
              {rows.length > shown ? (
                <>
                  <button className="btn cmp-more" onClick={() => setShown(s => s + pageSize)}>
                    Show {Math.min(pageSize, rows.length - shown).toLocaleString()} more
                    ({(rows.length - shown).toLocaleString()} remaining)
                  </button>
                  <div className="cmp-foot-note">
                    Showing {Math.min(shown, rows.length).toLocaleString()} of {rows.length.toLocaleString()} products
                  </div>
                </>
              ) : (
                <div className="cmp-foot-end">
                  End of comparison · {rows.length.toLocaleString()} product{rows.length === 1 ? '' : 's'}
                </div>
              )}
            </div>
          )}
          </FilterSidebar>
        </>
      )}
    </div>
  );
}
