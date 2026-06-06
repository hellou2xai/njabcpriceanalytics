/**
 * PriceSparklines — the shared, high-end price mini-chart shown EVERYWHERE we
 * show a product/SKU (Products list cards + size rows, the detail page size
 * sections, related/case-mix cards…). One component, one look.
 *
 * Per the rule: TWO small sparklines on a transparent background —
 *   • top  ("1cs") = case price after the 1-case discount (best_case_price),
 *                    or the full case price when there's no discount;
 *   • bottom ("RIP") = the best effective price (best RIP applied).
 * Hovering exposes a compact 3-month price schedule (List / 1-case / RIP, per
 * month, case + bottle) — the same info the old "See price schedule" link gave.
 *
 * It fetches its OWN price history lazily (only once scrolled into view, and
 * react-query dedupes by SKU), so it needs no price data on the parent row and
 * works at every layer without slowing list queries.
 */
import { useEffect, useRef, useState, useLayoutEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { catalog } from '../lib/api';

interface Props {
  wholesaler: string;
  productName: string;
  upc?: string | null;
  unitVolume?: string | null;
  unitQty?: string | number | null;
  vintage?: string | number | null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtMonth(ed?: string | null): string {
  if (!ed) return '';
  const m = /^(\d{4})-(\d{1,2})/.exec(ed);
  return m ? `${MONTHS[parseInt(m[2], 10) - 1] ?? ''} ${m[1]}`.trim() : ed;
}

// One tiny line: green if cheaper now than at the start, red if pricier, grey
// if flat. Transparent background, current value printed at the right.
function Spark({ values, label }: { values: (number | null | undefined)[]; label: string }) {
  const real = values.map((v, i) => ({ v, i })).filter((p): p is { v: number; i: number } => p.v != null);
  if (real.length === 0) return null;
  const W = 78, H = 17, PAD = 3, TOP = 3, BOT = 14;
  const n = Math.max(values.length, 1);
  const xs = (i: number) => (n <= 1 ? W / 2 : PAD + (i / (n - 1)) * (W - 2 * PAD));
  const vals = real.map(p => p.v);
  const min = Math.min(...vals), max = Math.max(...vals), range = Math.max(max - min, 0.01);
  const ys = (v: number) => BOT - ((v - min) / range) * (BOT - TOP);
  const newest = vals[vals.length - 1], oldest = vals[0];
  const colour = newest < oldest - 0.005 ? 'var(--green)' : newest > oldest + 0.005 ? 'var(--red)' : 'var(--text-muted)';
  const poly = real.map(p => `${xs(p.i).toFixed(1)},${ys(p.v).toFixed(1)}`).join(' ');
  return (
    <span className="psk-row">
      <span className="psk-tag">{label}</span>
      <svg className="psk-svg" width={W} height={H} aria-hidden>
        {real.length > 1 && <polyline points={poly} fill="none" stroke={colour} strokeWidth={1.4} />}
        {real.map(p => <circle key={p.i} cx={xs(p.i)} cy={ys(p.v)} r={1.6} fill={colour} />)}
      </svg>
      <span className="psk-val" style={{ color: colour }}>${newest.toFixed(0)}</span>
    </span>
  );
}

export default function PriceSparklines({ wholesaler, productName, upc, unitVolume, unitQty, vintage }: Props) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const popRef = useRef<HTMLSpanElement | null>(null);
  const [visible, setVisible] = useState(false);
  const [hover, setHover] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number; below: boolean } | null>(null);

  // Lazy: only fetch once scrolled into view (lists can have dozens of these).
  useEffect(() => {
    if (!ref.current || visible) return;
    const io = new IntersectionObserver(es => {
      for (const e of es) if (e.isIntersecting) { setVisible(true); io.disconnect(); break; }
    }, { rootMargin: '160px' });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [visible]);

  const { data } = useQuery({
    enabled: visible && !!wholesaler && !!productName,
    staleTime: 5 * 60_000,
    queryKey: ['price-history', wholesaler, productName, upc, unitVolume, unitQty, vintage],
    queryFn: () => catalog.priceHistory(wholesaler, productName, {
      upc: upc || undefined, unit_volume: unitVolume || undefined,
      unit_qty: unitQty != null ? String(unitQty) : undefined,
      vintage: vintage != null ? String(vintage) : undefined,
    }),
  });

  const history = data?.history ?? [];
  // 1cs = best (1-case discount) price, falling back to frontline when there's
  // no discount that edition; RIP = effective (best rebate) price.
  const discSeries = history.map(p => (p.best_case_price && p.best_case_price > 0 ? p.best_case_price : p.frontline_case_price));
  const ripSeries = history.map(p => p.effective_case_price);
  const pack = unitQty != null && Number(unitQty) > 0 ? Number(unitQty) : null;

  // Popover placement (fixed, escapes table overflow).
  useLayoutEffect(() => {
    if (!hover || !rect) { setPos(null); return; }
    const el = popRef.current;
    const W = el?.offsetWidth ?? 260, H = el?.offsetHeight ?? 160, M = 8;
    const below = rect.top - M - H < M;
    let left = rect.left + rect.width / 2 - W / 2;
    left = Math.max(M, Math.min(left, window.innerWidth - 28 - W));
    const top = below ? rect.bottom + M : rect.top - M - H;
    setPos({ left, top: Math.max(M, top), below });
  }, [hover, rect]);

  const onEnter = () => { const el = ref.current; if (el) setRect(el.getBoundingClientRect()); setHover(true); };
  const onLeave = () => setHover(false);

  if (visible && history.length === 0) return null;   // nothing to show

  const last3 = history.slice(-3).reverse();          // newest first
  const money = (v?: number | null) => (v == null ? '—' : `$${v.toFixed(2)}`);
  const cb = (caseVal?: number | null) => {
    if (caseVal == null) return '—';
    if (pack) return `${money(caseVal)}/cs · $${(caseVal / pack).toFixed(2)}${unitVolume ? ` (${unitVolume})` : '/btl'}`;
    return `${money(caseVal)}/cs`;
  };

  return (
    <span className="psk" ref={ref} onMouseEnter={onEnter} onMouseLeave={onLeave}
          onClick={e => e.stopPropagation()}>
      <span className="psk-charts">
        <Spark values={discSeries} label="1cs" />
        <Spark values={ripSeries} label="RIP" />
      </span>
      {hover && pos && history.length > 0 && (
        <span className={`psk-pop${pos.below ? ' psk-pop-below' : ''}`} ref={popRef}
              style={{ position: 'fixed', left: pos.left, top: pos.top }}>
          <span className="psk-pop-title">Price schedule</span>
          {last3.map((p, i) => {
            const disc = p.best_case_price && p.best_case_price > 0 ? p.best_case_price : null;
            const showDisc = disc != null && disc < p.frontline_case_price - 0.005;
            const showRip = p.effective_case_price < (disc ?? p.frontline_case_price) - 0.005;
            return (
              <span className="psk-pop-block" key={i}>
                <span className="psk-pop-month">{fmtMonth(p.edition)}{i === 0 ? ' · current' : ''}</span>
                <span className="psk-pop-line"><em>List</em>{cb(p.frontline_case_price)}</span>
                {showDisc && <span className="psk-pop-line"><em>1-case</em>{cb(disc)}</span>}
                {showRip && <span className="psk-pop-line psk-pop-rip"><em>Best RIP</em>{cb(p.effective_case_price)}</span>}
              </span>
            );
          })}
        </span>
      )}
    </span>
  );
}
