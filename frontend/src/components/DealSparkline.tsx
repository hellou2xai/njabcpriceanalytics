import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { catalog } from '../lib/api';

/**
 * Tiny inline SVG sparkline of a product's case price across recent editions,
 * with the effective (after-deal) price overlaid as a green line. Fetches its
 * own price history, but only after it scrolls into view, so a Time-Sensitive
 * Deals page with dozens of cards doesn't fire dozens of requests at once.
 *
 * When `interactive` is set (Price Movers cards), the chip becomes clickable
 * and opens a popover with three labeled price chips (last / this / next month)
 * showing both the effective and the frontline price per month, plus the two
 * deltas between them. Month labels render as native title tooltips on each
 * SVG point so a hover read still works without opening the popover.
 */
interface Props {
  wholesaler: string;
  productName: string;
  width?: number;
  height?: number;
  interactive?: boolean;
  upc?: string;
  unitVolume?: string;
  unitQty?: string;
  vintage?: string;
  // Edition strings (YYYY-MM) the parent thinks of as "this month" / "next
  // month". Used by the popover to highlight the relevant three points; if
  // omitted, the popover falls back to the last three editions in history.
  curEdition?: string | null;
  nextEdition?: string | null;
}

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function fmtMonth(ed?: string | null): string {
  if (!ed) return '';
  const m = /^(\d{4})-(\d{1,2})/.exec(ed);
  if (!m) return ed;
  return `${MONTHS[parseInt(m[2], 10) - 1] ?? ''} ${m[1]}`.trim();
}
function prevYM(ed?: string | null): string | null {
  if (!ed) return null;
  const m = /^(\d{4})-(\d{1,2})/.exec(ed);
  if (!m) return null;
  const y = parseInt(m[1], 10); const mo = parseInt(m[2], 10);
  return `${mo === 1 ? y - 1 : y}-${String(mo === 1 ? 12 : mo - 1).padStart(2, '0')}`;
}
const money = (v?: number | null) => (v == null ? '—' : `$${v.toFixed(2)}`);
const pct = (v?: number | null) => (v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`);

export default function DealSparkline({
  wholesaler, productName, width = 140, height = 36,
  interactive = false, upc, unitVolume, unitQty, vintage,
  curEdition, nextEdition,
}: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);
  const [popOpen, setPopOpen] = useState(false);

  useEffect(() => {
    if (!ref.current || visible) return;
    const io = new IntersectionObserver(entries => {
      for (const e of entries) if (e.isIntersecting) { setVisible(true); io.disconnect(); break; }
    }, { rootMargin: '120px' });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [visible]);

  // Close popover on outside click / Escape.
  useEffect(() => {
    if (!popOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) setPopOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPopOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [popOpen]);

  // For an interactive popover the parent typically passes the SKU's UPC +
  // size so the history is scoped to one bottle size (a product_name can
  // cover several). Plain usage on Time-Sensitive cards stays scoped by
  // product_name only.
  const histOpts = {
    upc: upc || undefined,
    unit_volume: unitVolume || undefined,
    unit_qty: unitQty || undefined,
    vintage: vintage || undefined,
  };
  const { data } = useQuery({
    queryKey: ['price-history', wholesaler, productName, upc, unitVolume, unitQty, vintage],
    queryFn: () => catalog.priceHistory(wholesaler, productName, histOpts),
    enabled: visible,
    staleTime: 5 * 60_000,
  });

  const points = data?.history ?? [];
  const pad = 2;
  const path = (vals: number[]) => {
    if (vals.length < 2) return '';
    const min = Math.min(...vals), max = Math.max(...vals);
    const span = Math.max(0.0001, max - min);
    return vals.map((v, i) => {
      const x = pad + (i / (vals.length - 1)) * (width - pad * 2);
      const y = pad + (1 - (v - min) / span) * (height - pad * 2);
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
  };
  const list = points.map(p => p.frontline_case_price).filter(v => typeof v === 'number');
  const effList = points.map(p => p.effective_case_price).filter(v => typeof v === 'number');
  const first = list[0], last = list[list.length - 1];
  const direction = first != null && last != null ? (last > first ? 'up' : last < first ? 'down' : 'flat') : null;
  const stroke = direction === 'down' ? '#16a34a' : direction === 'up' ? '#dc2626' : 'var(--text-muted)';

  // Find the three points the popover needs. Prefer the explicit curEdition
  // hint from the parent; otherwise fall back to the last three points so the
  // popover always shows something useful.
  const findIdx = (ed?: string | null) => ed == null ? -1 : points.findIndex(p => p.edition === ed);
  let curIdx = findIdx(curEdition);
  if (curIdx < 0 && points.length > 0) curIdx = points.length - (nextEdition ? 2 : 1);
  const prevIdx = curIdx > 0 ? curIdx - 1 : -1;
  let nextIdx = findIdx(nextEdition);
  if (nextIdx < 0 && curIdx >= 0 && curIdx < points.length - 1) nextIdx = curIdx + 1;
  const pPrev = prevIdx >= 0 ? points[prevIdx] : null;
  const pCur  = curIdx  >= 0 ? points[curIdx]  : null;
  const pNext = nextIdx >= 0 ? points[nextIdx] : null;

  const dEff = (a?: number | null, b?: number | null) => {
    if (a == null || b == null || a === 0) return { d: null, p: null };
    return { d: b - a, p: ((b - a) / a) * 100 };
  };
  const curEff  = dEff(pPrev?.effective_case_price, pCur?.effective_case_price);
  const nextEff = dEff(pCur?.effective_case_price, pNext?.effective_case_price);
  const curList  = dEff(pPrev?.frontline_case_price, pCur?.frontline_case_price);
  const nextList = dEff(pCur?.frontline_case_price, pNext?.frontline_case_price);

  // Position the "highlight dots" for the prev/cur/next points on the SVG.
  const dotX = (i: number) => {
    if (points.length < 2) return pad + (width - pad * 2) / 2;
    return pad + (i / (points.length - 1)) * (width - pad * 2);
  };
  const yOf = (v: number, arr: number[]) => {
    const min = Math.min(...arr), max = Math.max(...arr);
    const span = Math.max(0.0001, max - min);
    return pad + (1 - (v - min) / span) * (height - pad * 2);
  };

  const onChipClick = (e: React.MouseEvent) => {
    if (!interactive) return;
    e.stopPropagation();
    setPopOpen(o => !o);
  };

  return (
    <div
      ref={ref}
      className={`deal-spark ${interactive ? 'deal-spark--interactive' : ''}`}
      title={interactive ? 'Click to compare last / this / next month' : 'Case price over recent editions'}
      style={{ width, height, position: 'relative' }}
      onClick={onChipClick}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      onKeyDown={(e) => {
        if (!interactive) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setPopOpen(o => !o); }
      }}
    >
      {visible && list.length >= 2 ? (
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
          {/* Frontline (list) — faint dashed line so the popover can talk
              about it as the "secondary" story. */}
          <path d={path(list)} fill="none" stroke={stroke} strokeWidth="1.4" strokeDasharray="2 2" strokeLinecap="round" strokeLinejoin="round" />
          {/* Effective — solid green, what the buyer actually pays. */}
          {effList.length >= 2 && (
            <path d={path(effList)} fill="none" stroke="#16a34a" strokeWidth="1.6" strokeLinecap="round" />
          )}
          {/* Highlight dots on the three popover-relevant points so the
              user can read the data by hovering even without clicking. */}
          {pCur && (
            <circle cx={dotX(curIdx)} cy={yOf(pCur.effective_case_price, effList)} r="3" fill="#16a34a">
              <title>{fmtMonth(pCur.edition)} · ${pCur.effective_case_price.toFixed(2)} (effective)</title>
            </circle>
          )}
          {pPrev && (
            <circle cx={dotX(prevIdx)} cy={yOf(pPrev.effective_case_price, effList)} r="2.4" fill="#94a3b8">
              <title>{fmtMonth(pPrev.edition)} · ${pPrev.effective_case_price.toFixed(2)} (effective)</title>
            </circle>
          )}
          {pNext && (
            <circle cx={dotX(nextIdx)} cy={yOf(pNext.effective_case_price, effList)} r="2.4" fill="#94a3b8">
              <title>{fmtMonth(pNext.edition)} · ${pNext.effective_case_price.toFixed(2)} (effective)</title>
            </circle>
          )}
          {/* Last-point glyph kept for consistency with the original look. */}
          {(() => {
            const xs = pad + (width - pad * 2);
            const ys = list.length ? pad + (1 - (last - Math.min(...list)) / Math.max(0.0001, Math.max(...list) - Math.min(...list))) * (height - pad * 2) : height / 2;
            return <circle cx={xs} cy={ys} r="2" fill={stroke} />;
          })()}
        </svg>
      ) : (
        <div className="deal-spark-placeholder" />
      )}

      {interactive && popOpen && (pPrev || pCur || pNext) && (
        <div className="deal-spark-popover" role="dialog" aria-label="Price comparison">
          <div className="dsp-row dsp-row-months">
            <div className="dsp-cell">{fmtMonth(pPrev?.edition ?? prevYM(pCur?.edition ?? null))}</div>
            <div className="dsp-arrow" />
            <div className="dsp-cell dsp-cell-cur">{fmtMonth(pCur?.edition)}</div>
            <div className="dsp-arrow" />
            <div className="dsp-cell">{fmtMonth(pNext?.edition)}</div>
          </div>
          <div className="dsp-row dsp-row-eff" title="After-RIP effective price">
            <div className="dsp-cell"><span className="dsp-label">Effective</span><strong>{money(pPrev?.effective_case_price)}</strong></div>
            <div className="dsp-delta">
              {curEff.p != null ? <span className={curEff.p > 0 ? 'dsp-up' : curEff.p < 0 ? 'dsp-down' : 'dsp-flat'}>{pct(curEff.p)}</span> : '—'}
            </div>
            <div className="dsp-cell dsp-cell-cur"><strong>{money(pCur?.effective_case_price)}</strong></div>
            <div className="dsp-delta">
              {nextEff.p != null ? <span className={nextEff.p > 0 ? 'dsp-up' : nextEff.p < 0 ? 'dsp-down' : 'dsp-flat'}>{pct(nextEff.p)}</span> : '—'}
            </div>
            <div className="dsp-cell"><strong>{money(pNext?.effective_case_price)}</strong></div>
          </div>
          <div className="dsp-row dsp-row-list" title="Frontline (list) price before RIP">
            <div className="dsp-cell"><span className="dsp-label">List</span>{money(pPrev?.frontline_case_price)}</div>
            <div className="dsp-delta">
              {curList.p != null ? pct(curList.p) : '—'}
            </div>
            <div className="dsp-cell dsp-cell-cur">{money(pCur?.frontline_case_price)}</div>
            <div className="dsp-delta">
              {nextList.p != null ? pct(nextList.p) : '—'}
            </div>
            <div className="dsp-cell">{money(pNext?.frontline_case_price)}</div>
          </div>
        </div>
      )}
    </div>
  );
}
