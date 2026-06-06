/**
 * PriceSparklines — the shared, high-end price mini-chart shown EVERYWHERE we
 * show a product/SKU (Products list cards + size rows, the detail page size
 * sections, related/case-mix cards…). One component, one look.
 *
 * TWO small sparklines on a transparent background —
 *   • top  ("1cs") = case price after the 1-case discount;
 *   • bottom ("RIP") = the best effective price (best RIP applied).
 * Hovering exposes the price schedule (per month: list / 1-case / best RIP, and
 * the quantity deals when we have the rich data).
 *
 * Data sources, by cost:
 *  - When the caller already has the row (size rows / detail sections), it
 *    passes `months` (from price_3mo) → no request, and the tooltip shows the
 *    full quantity-deal schedule.
 *  - Otherwise (collapsed cards, mini cards) it lazily self-fetches the LIGHT
 *    price-history endpoint (no tier ladder) — so a page with dozens of these
 *    doesn't fire dozens of expensive `include_tiers` searches and stall.
 */
import { useEffect, useRef, useState, useLayoutEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { catalog } from '../lib/api';
import { bottlesPerCase } from '../lib/productSizes';
import { windowBadge, fmtDateRange } from '../lib/dealDates';
import type { MonthBreakdown, RipTier } from './MonthEffectiveSparkline';
import type { PricePoint } from '../lib/api';

interface Props {
  wholesaler: string;
  productName: string;
  upc?: string | null;
  unitVolume?: string | null;
  unitQty?: string | number | null;
  vintage?: string | number | null;
  // When the caller already has the row (with price_3mo), pass the built months
  // for a no-request, rich (quantity-deal) tooltip. Omit to self-fetch light.
  months?: MonthBreakdown[];
  // When the caller is itself fetching the rich (price_3mo) data and will pass
  // `months` once it lands, set this so the sparkline does NOT also self-fetch
  // the light history — one fetch powers both the chart and the deal ladder.
  noSelfFetch?: boolean;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtMonth(ed?: string | null): string {
  if (!ed) return '';
  const m = /^(\d{4})-(\d{1,2})/.exec(ed);
  return m ? `${MONTHS[parseInt(m[2], 10) - 1] ?? ''} ${m[1]}`.trim() : ed;
}
const unitWord = (unit: string) => (/btl|bottle/i.test(unit) ? 'btl' : 'cs');

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

// A month line "List / 1-case / Best RIP" with case + bottle (shared by both
// the rich and the light tooltip).
function priceCB(caseVal: number | null | undefined, pack: number | null, size?: string | null) {
  if (caseVal == null) return '—';
  const btl = pack ? ` · $${(caseVal / pack).toFixed(2)}${size ? ` (${size})` : '/btl'}` : '';
  return `$${caseVal.toFixed(2)}/cs${btl}`;
}

// Rich month block (from price_3mo): list headline + quantity deals.
function RichMonth({ b, pack, current }: { b: MonthBreakdown; pack: number | null; current: boolean }) {
  const disc = [...(b.discountTiers ?? [])].sort((a, c) => a.qty - c.qty);
  const rip = [...(b.ripTiers ?? [])].sort((a, c) => a.qty - c.qty);
  const tierLine = (t: RipTier, kind: 'disc' | 'rip', i: number) => {
    const off = b.frontline != null && t.eff < b.frontline ? b.frontline - t.eff : null;
    return (
      <span className="psk-pop-deal" key={`${kind}${i}`}>
        <span className="psk-pop-buy">Buy {t.qty} {unitWord(t.unit)}
          <span className={`psk-pill psk-pill-${kind}`}>{kind === 'disc' ? 'Disc' : 'RIP'}</span>
          {(() => {
            const wb = windowBadge(t);
            if (!t.ts && !wb) return null;
            const range = fmtDateRange(t.from_date, t.to_date);
            return <span className={`win-badge ${wb?.cls ?? 'win-partial'}${wb?.urgent ? ' urgent' : ''}`}
              title={`Partial-month — only valid ${range || 'limited dates'}`}>
              {t.ts ? `Partial · ${range || 'limited'}` : wb?.label}</span>;
          })()}</span>
        <span className="psk-pop-amt">{priceCB(t.eff, pack, b.size)}
          {off != null && off > 0.005 && <span className="psk-off"> (−${off.toFixed(2)})</span>}</span>
      </span>
    );
  };
  return (
    <span className="psk-pop-block">
      <span className="psk-pop-month">{fmtMonth(b.edition)}{current ? ' · current' : ''}</span>
      <span className="psk-pop-line"><em>List</em>{priceCB(b.frontline, pack, b.size)}</span>
      {(disc.length > 0 || rip.length > 0) && (
        <span className="psk-pop-deals">
          <span className="psk-pop-deals-h">Quantity deals</span>
          {disc.map((t, i) => tierLine(t, 'disc', i))}
          {rip.map((t, i) => tierLine(t, 'rip', i))}
        </span>
      )}
    </span>
  );
}

// Light month block (from price-history): list / 1-case / best RIP.
function LightMonth({ p, pack, size, current }: { p: PricePoint; pack: number | null; size?: string | null; current: boolean }) {
  const disc = p.best_case_price && p.best_case_price > 0 && p.best_case_price < p.frontline_case_price - 0.005 ? p.best_case_price : null;
  const showRip = p.effective_case_price < (disc ?? p.frontline_case_price) - 0.005;
  return (
    <span className="psk-pop-block">
      <span className="psk-pop-month">{fmtMonth(p.edition)}{current ? ' · current' : ''}</span>
      <span className="psk-pop-line"><em>List</em>{priceCB(p.frontline_case_price, pack, size)}</span>
      {disc != null && <span className="psk-pop-line"><em>1-case</em>{priceCB(disc, pack, size)}</span>}
      {showRip && <span className="psk-pop-line psk-pop-rip"><em>Best RIP</em>{priceCB(p.effective_case_price, pack, size)}</span>}
    </span>
  );
}

export default function PriceSparklines({ wholesaler, productName, upc, unitVolume, unitQty, vintage, months, noSelfFetch }: Props) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const popRef = useRef<HTMLSpanElement | null>(null);
  const [visible, setVisible] = useState(false);
  const [hover, setHover] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number; below: boolean } | null>(null);

  const hasOwn = !!(months && months.length);
  const vtg = vintage != null && !['', '0', 'nv', 'none'].includes(String(vintage).toLowerCase()) ? String(vintage) : '';

  // Lazy: only fetch (when no months passed) once scrolled into view.
  useEffect(() => {
    if (hasOwn || !ref.current || visible) return;
    const io = new IntersectionObserver(es => {
      for (const e of es) if (e.isIntersecting) { setVisible(true); io.disconnect(); break; }
    }, { rootMargin: '120px' });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [visible, hasOwn]);

  // LIGHT price history (no tier ladder) for the self-fetch layers.
  const { data: hist } = useQuery({
    enabled: !hasOwn && !noSelfFetch && visible && !!wholesaler && !!productName,
    staleTime: 5 * 60_000,
    queryKey: ['price-history', wholesaler, productName, upc, unitVolume, unitQty, vtg],
    queryFn: () => catalog.priceHistory(wholesaler, productName, {
      upc: upc || undefined, unit_volume: unitVolume || undefined,
      unit_qty: unitQty != null ? String(unitQty) : undefined, vintage: vtg || undefined,
    }),
  });

  const pack = bottlesPerCase(productName, unitQty);

  // Build the two series + tooltip blocks from whichever source we have.
  let discSeries: (number | null | undefined)[] = [];
  let ripSeries: (number | null | undefined)[] = [];
  let richBlocks: MonthBreakdown[] = [];
  let lightBlocks: PricePoint[] = [];
  if (hasOwn) {
    const blocks = months!.filter(m => m.bestEff != null || m.disc1 != null || m.frontline != null);
    discSeries = blocks.map(m => m.disc1 ?? m.frontline);
    ripSeries = blocks.map(m => m.bestEff);
    richBlocks = [...blocks].reverse().slice(0, 3);
  } else {
    const h = hist?.history ?? [];
    discSeries = h.map(p => (p.best_case_price && p.best_case_price > 0 ? p.best_case_price : p.frontline_case_price));
    ripSeries = h.map(p => p.effective_case_price);
    lightBlocks = [...h].reverse().slice(0, 3);
  }
  const hasData = discSeries.some(v => v != null) || ripSeries.some(v => v != null);
  const blockCount = hasOwn ? richBlocks.length : lightBlocks.length;

  useLayoutEffect(() => {
    if (!hover || !rect) { setPos(null); return; }
    const el = popRef.current;
    const W = el?.offsetWidth ?? 280, H = el?.offsetHeight ?? 200, M = 8;
    const below = rect.top - M - H < M;
    let left = rect.left + rect.width / 2 - W / 2;
    left = Math.max(M, Math.min(left, window.innerWidth - 28 - W));
    const top = below ? rect.bottom + M : rect.top - M - H;
    setPos({ left, top: Math.max(M, top), below });
  }, [hover, rect]);

  const onEnter = () => { const el = ref.current; if (el) setRect(el.getBoundingClientRect()); setHover(true); };
  const onLeave = () => setHover(false);

  // Nothing to draw (no months, history loaded empty) → render nothing.
  if (!hasOwn && hist && !hasData) return null;
  if (hasOwn && !hasData) return null;

  return (
    <span className="psk" ref={ref} onMouseEnter={onEnter} onMouseLeave={onLeave} onClick={e => e.stopPropagation()}>
      <span className="psk-charts">
        <Spark values={discSeries} label="1cs" />
        <Spark values={ripSeries} label="RIP" />
      </span>
      {hover && pos && blockCount > 0 && (
        <span className={`psk-pop${pos.below ? ' psk-pop-below' : ''}`} ref={popRef}
              style={{ position: 'fixed', left: pos.left, top: pos.top }}>
          <span className="psk-pop-title">Price schedule{vtg ? ` · ${vtg} vintage` : ''}</span>
          {hasOwn
            ? richBlocks.map((b, i) => <RichMonth key={i} b={b} current={i === 0} pack={bottlesPerCase(productName, b.pack ?? undefined)} />)
            : lightBlocks.map((p, i) => <LightMonth key={i} p={p} pack={pack} size={unitVolume} current={i === 0} />)}
        </span>
      )}
    </span>
  );
}
