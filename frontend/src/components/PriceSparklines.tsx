/**
 * PriceSparklines — the shared, high-end price mini-chart shown EVERYWHERE we
 * show a product/SKU (Products list cards + size rows, the detail page size
 * sections, related/case-mix cards…). One component, one look.
 *
 * Per the rule: TWO small sparklines on a transparent background —
 *   • top  ("1cs") = case price after the 1-case discount;
 *   • bottom ("RIP") = the best effective price (best RIP applied).
 * Hovering exposes the FULL price-schedule (the old "See price schedule" modal
 * content): per month, the list-price headline plus the Quantity Deals, each
 * with its case + bottle price.
 *
 * Data comes from the backend `price_3mo` blocks (via buildMonths). When a
 * parent already has the size row (size rows / detail sections) it passes
 * `months` so no extra request is made; otherwise (collapsed cards, mini cards)
 * the component lazily self-fetches the one SKU with tiers and builds them.
 */
import { useEffect, useRef, useState, useLayoutEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { catalog } from '../lib/api';
import { buildMonths } from '../lib/promotionsSparkline';
import { bottlesPerCase } from '../lib/productSizes';
import type { MonthBreakdown, RipTier } from './MonthEffectiveSparkline';
import type { Product } from '../lib/api';

interface Props {
  wholesaler: string;
  productName: string;
  upc?: string | null;
  unitVolume?: string | null;
  unitQty?: string | number | null;
  vintage?: string | number | null;
  // When the caller already has the row (with price_3mo), pass the built months
  // to avoid a second fetch. Omit to let the component self-fetch.
  months?: MonthBreakdown[];
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtMonth(ed?: string | null): string {
  if (!ed) return '';
  const m = /^(\d{4})-(\d{1,2})/.exec(ed);
  return m ? `${MONTHS[parseInt(m[2], 10) - 1] ?? ''} ${m[1]}`.trim() : ed;
}
const unitWord = (qty: number, unit: string) =>
  /btl|bottle/i.test(unit) ? (qty === 1 ? 'btl' : 'btl') : (qty === 1 ? 'cs' : 'cs');

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

// One month block of the schedule popover: list-price headline + the quantity
// deals (discount + RIP tiers), each as case + bottle.
function MonthSchedule({ b, pack, current }: { b: MonthBreakdown; pack: number | null; current: boolean }) {
  const cb = (caseVal?: number | null) => {
    if (caseVal == null) return '—';
    const btl = pack ? ` · $${(caseVal / pack).toFixed(2)}${b.size ? ` (${b.size})` : '/btl'}` : '';
    return `$${caseVal.toFixed(2)}/cs${btl}`;
  };
  const sortedDisc = [...(b.discountTiers ?? [])].sort((a, c) => a.qty - c.qty);
  const sortedRip = [...(b.ripTiers ?? [])].sort((a, c) => a.qty - c.qty);
  const tierLine = (t: RipTier, kind: 'disc' | 'rip', i: number) => {
    const off = b.frontline != null && t.eff < b.frontline ? b.frontline - t.eff : null;
    return (
      <span className="psk-pop-deal" key={`${kind}${i}`}>
        <span className="psk-pop-buy">
          Buy {t.qty} {unitWord(t.qty, t.unit)}
          <span className={`psk-pill psk-pill-${kind}`}>{kind === 'disc' ? 'Disc' : 'RIP'}</span>
        </span>
        <span className="psk-pop-amt">
          {cb(t.eff)}{off != null && off > 0.005 && <span className="psk-off"> (−${off.toFixed(2)})</span>}
        </span>
      </span>
    );
  };
  return (
    <span className="psk-pop-block">
      <span className="psk-pop-month">{fmtMonth(b.edition)}{current ? ' · current' : ''}</span>
      <span className="psk-pop-line"><em>List</em>{cb(b.frontline)}</span>
      {(sortedDisc.length > 0 || sortedRip.length > 0) && (
        <span className="psk-pop-deals">
          <span className="psk-pop-deals-h">Quantity deals</span>
          {sortedDisc.map((t, i) => tierLine(t, 'disc', i))}
          {sortedRip.map((t, i) => tierLine(t, 'rip', i))}
        </span>
      )}
    </span>
  );
}

export default function PriceSparklines({ wholesaler, productName, upc, unitVolume, vintage, months }: Props) {
  const vtg = vintage != null && !['', '0', 'nv', 'none'].includes(String(vintage).toLowerCase()) ? String(vintage) : '';
  const ref = useRef<HTMLSpanElement | null>(null);
  const popRef = useRef<HTMLSpanElement | null>(null);
  const [visible, setVisible] = useState(false);
  const [hover, setHover] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number; below: boolean } | null>(null);

  const hasOwn = !!(months && months.length);

  // Lazy: only fetch (when no months were passed) once scrolled into view.
  useEffect(() => {
    if (hasOwn || !ref.current || visible) return;
    const io = new IntersectionObserver(es => {
      for (const e of es) if (e.isIntersecting) { setVisible(true); io.disconnect(); break; }
    }, { rootMargin: '160px' });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [visible, hasOwn]);

  const { data } = useQuery({
    enabled: !hasOwn && visible && !!wholesaler && !!productName && !!upc,
    staleTime: 5 * 60_000,
    queryKey: ['psk-size', wholesaler, productName, upc, unitVolume, vtg],
    queryFn: () => catalog.search({
      wholesaler, upcs: String(upc), include_tiers: true, limit: 16, sort: 'product_name', order: 'asc',
    }),
  });
  const fetchedMonths = (() => {
    if (hasOwn) return months!;
    const rows = (data?.items ?? []) as Product[];
    // Match the exact size AND vintage (a wine barcode carries several
    // vintages); fall back gracefully.
    const sameSize = rows.filter(r => (r.unit_volume ?? '') === (unitVolume ?? ''));
    const row = (vtg ? sameSize.find(r => String(r.vintage ?? '') === vtg) : null)
      ?? sameSize[0] ?? rows[0];
    return row ? buildMonths(row) : [];
  })();

  const blocks = fetchedMonths.filter(m => m.bestEff != null || m.disc1 != null || m.frontline != null);
  const discSeries = blocks.map(m => m.disc1 ?? m.frontline);   // 1-case discount price
  const ripSeries = blocks.map(m => m.bestEff);                 // best RIP price
  const last3 = [...blocks].reverse().slice(0, 3);              // newest first

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

  if (blocks.length === 0 && (hasOwn || (visible && data))) return null;

  return (
    <span className="psk" ref={ref} onMouseEnter={onEnter} onMouseLeave={onLeave} onClick={e => e.stopPropagation()}>
      <span className="psk-charts">
        <Spark values={discSeries} label="1cs" />
        <Spark values={ripSeries} label="RIP" />
      </span>
      {hover && pos && last3.length > 0 && (
        <span className={`psk-pop${pos.below ? ' psk-pop-below' : ''}`} ref={popRef}
              style={{ position: 'fixed', left: pos.left, top: pos.top }}>
          <span className="psk-pop-title">Price schedule{vtg ? ` · ${vtg} vintage` : ''}</span>
          {last3.map((b, i) => (
            <MonthSchedule key={i} b={b} current={i === 0}
              pack={bottlesPerCase(productName, b.pack ?? undefined)} />
          ))}
        </span>
      )}
    </span>
  );
}
