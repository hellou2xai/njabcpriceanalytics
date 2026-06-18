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
import { useEffect, useMemo, useRef, useState, useLayoutEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { catalog } from '../lib/api';
import { bottlesPerCase } from '../lib/productSizes';
import { windowBadge, fmtDateRange } from '../lib/dealDates';
import { buildMonths } from '../lib/promotionsSparkline';
import type { MonthBreakdown, RipTier } from './MonthEffectiveSparkline';
import type { PricePoint, Product } from '../lib/api';

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
const unitWord = (unit: string) => (/^\s*b/i.test(unit) ? 'btl' : 'cs');

// One tiny line: green if cheaper now than at the start, red if pricier, grey
// if flat. Transparent background, current value printed at the right.
// A null in the LAST slot means the series doesn't exist this month (e.g. no
// full-month RIP now): the line stops at its last real month and the label
// reads "—" instead of inventing a current value.
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
  const lastSlot = values[values.length - 1];
  const colour = lastSlot == null ? 'var(--text-muted)'
    : newest < oldest - 0.005 ? 'var(--green)' : newest > oldest + 0.005 ? 'var(--red)' : 'var(--text-muted)';
  const poly = real.map(p => `${xs(p.i).toFixed(1)},${ys(p.v).toFixed(1)}`).join(' ');
  return (
    <span className="psk-row">
      <span className="psk-tag">{label}</span>
      <svg className="psk-svg" width={W} height={H} aria-hidden>
        {real.length > 1 && <polyline points={poly} fill="none" stroke={colour} strokeWidth={1.4} />}
        {real.map(p => <circle key={p.i} cx={xs(p.i)} cy={ys(p.v)} r={1.6} fill={colour} />)}
      </svg>
      <span className="psk-val" style={{ color: colour }}
            title={lastSlot == null ? `No ${label} price this month (last: $${newest.toFixed(0)})` : undefined}>
        {lastSlot == null ? '—' : `$${newest.toFixed(0)}`}
      </span>
    </span>
  );
}

// RIP row = the EFFECTIVE price (what you actually pay) across the window.
// Show the FULL trajectory — including a rise back to list when a rebate
// LAPSES (e.g. a brand RIP that ran last month but not this one, so the price
// you pay goes UP) — whenever the product had a rebate in ANY of these months.
// Hide the row entirely only when it never had one, so a no-RIP product
// doesn't grow a redundant line. (The old behaviour nulled every month with no
// rebate, which made a lapsing RIP's price HIKE vanish — the line just stopped
// and the label read "—" instead of showing the climb back to list.)
function ripTrajectory(
  effs: (number | null | undefined)[],
  bases: (number | null | undefined)[],
): (number | null)[] {
  const hadRebate = effs.some((e, i) => {
    const b = bases[i];
    return e != null && b != null && e < b - 0.005;
  });
  return hadRebate ? effs.map(e => (e != null ? e : null)) : effs.map(() => null);
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
  // Window-first ordering, same convention as DealLadder.
  const byWindow = (a: RipTier, c: RipTier) =>
    (a.from_date ?? '0000').localeCompare(c.from_date ?? '0000')
    || (a.to_date ?? '9999').localeCompare(c.to_date ?? '9999')
    || a.qty - c.qty;
  const disc = [...(b.discountTiers ?? [])].sort(byWindow);
  // RIP tiers ascending by rebate amount (consistent everywhere RIP shows)
  const rip = [...(b.ripTiers ?? [])].sort(
    (a, c) => (a.ripOnlySave ?? 0) - (c.ripOnlySave ?? 0) || a.qty - c.qty);
  const tierLine = (t: RipTier, kind: 'disc' | 'rip', i: number) => {
    // RIP rows show the rebate ALONE (the RIP-sheet number) — DealLadder rule.
    const off = kind === 'rip'
      ? (t.ripOnlySave ?? null)
      : (b.frontline != null && t.eff < b.frontline ? b.frontline - t.eff : null);
    return (
      <span className="psk-pop-deal" key={`${kind}${i}`}>
        <span className="psk-pop-buy">Buy {t.qty} {pack === 1 ? 'cs' : unitWord(t.unit)}
          <span className={`psk-pill psk-pill-${kind}`}>{kind === 'disc' ? 'Disc' : 'RIP'}</span>
          {(() => {
            const wb = windowBadge(t);
            if (!t.ts && !wb) return null;
            const range = fmtDateRange(t.from_date, t.to_date);
            const cls = t.ts ? (wb?.urgent ? 'win-partial urgent' : 'win-partial') : (wb?.cls ?? 'win-partial');
            return <span className={`win-badge ${cls}`}
              title={`Partial-month — only valid ${range || 'limited dates'}`}>
              {t.ts ? `⏱ Partial · ${range || 'limited'}` : wb?.label}</span>;
          })()}</span>
        <span className="psk-pop-amt">{priceCB(t.eff, pack, b.size)}
          {off != null && off > 0.005 && (
            <span className="psk-off">{kind === 'rip' ? ` (RIP −$${off.toFixed(2)}/cs)` : ` (−$${off.toFixed(2)})`}</span>
          )}</span>
      </span>
    );
  };
  return (
    <span className="psk-pop-block">
      <span className="psk-pop-month">{fmtMonth(b.edition)}{b.future ? ' · next' : current ? ' · current' : ''}</span>
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

  // FULL tier ladders in the tooltip, ALWAYS (hard rule - never trimmed).
  // Light-mode sparklines (related/collapsed cards) self-fetch only the cheap
  // history for the chart; the rich per-product tier data is fetched ON HOVER
  // so the tooltip still shows the complete QD/RIP schedule without making
  // page load fire dozens of expensive include_tiers searches.
  const [wantRich, setWantRich] = useState(false);
  const { data: richRes } = useQuery({
    enabled: !hasOwn && wantRich && !!wholesaler && !!productName,
    staleTime: 5 * 60_000,
    queryKey: ['psk-rich', wholesaler, productName, upc, unitVolume, vtg],
    queryFn: () => catalog.search({
      q: upc && upc !== '0' ? upc : productName,
      wholesaler, include_tiers: true, limit: 50,
    }),
  });
  const hoverMonths = useMemo(() => {
    const items = ((richRes as { items?: Product[] } | undefined)?.items) ?? [];
    if (!items.length) return null;
    const norm = (u?: string | null) => String(u ?? '').replace(/^0+/, '');
    const tgt = norm(upc);
    const match = items.find(i =>
      (!tgt || norm(i.upc) === tgt)
      && (!unitVolume || (i.unit_volume ?? '') === unitVolume)
      && (!vtg || String(i.vintage ?? '') === vtg))
      ?? items.find(i => !tgt || norm(i.upc) === tgt)
      ?? null;
    return match ? buildMonths(match) : null;
  }, [richRes, upc, unitVolume, vtg]);

  // Build the two series + tooltip blocks from whichever source we have.
  let discSeries: (number | null | undefined)[] = [];
  let ripSeries: (number | null | undefined)[] = [];
  let richBlocks: MonthBreakdown[] = [];
  let lightBlocks: PricePoint[] = [];
  if (hasOwn) {
    const blocks = months!.filter(m => m.bestEff != null || m.disc1 != null || m.frontline != null);
    discSeries = blocks.map(m => m.disc1 ?? m.frontline);
    ripSeries = ripTrajectory(blocks.map(m => m.bestEff), blocks.map(m => m.disc1 ?? m.frontline));
    richBlocks = [...blocks].reverse().slice(0, 3);
  } else if (hoverMonths && hoverMonths.length) {
    // Rich data arrived (hover): the tooltip upgrades to full ladders; the
    // chart keeps using the light history series it already drew.
    const h = hist?.history ?? [];
    const base = (p: PricePoint) => (p.best_case_price && p.best_case_price > 0 ? p.best_case_price : p.frontline_case_price);
    discSeries = h.map(base);
    ripSeries = ripTrajectory(h.map(p => p.effective_case_price), h.map(base));
    richBlocks = [...hoverMonths].reverse().slice(0, 3);
  } else {
    const h = hist?.history ?? [];
    const base = (p: PricePoint) => (p.best_case_price && p.best_case_price > 0 ? p.best_case_price : p.frontline_case_price);
    discSeries = h.map(base);
    ripSeries = ripTrajectory(h.map(p => p.effective_case_price), h.map(base));
    lightBlocks = [...h].reverse().slice(0, 3);
  }
  const hasData = discSeries.some(v => v != null) || ripSeries.some(v => v != null);
  // Whichever block source currently has content powers the popover (rich
  // replaces light once the on-hover tier fetch lands).
  const blockCount = richBlocks.length || lightBlocks.length;
  // The "· current" label marks the CURRENT CALENDAR month, not just the newest
  // block. A next-month edition loaded early (future-flagged) is the newest
  // point but is NOT current — it gets "· next" instead. Blocks are newest-first.
  const _cym = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; })();
  const richCurIdx = (() => { const i = richBlocks.findIndex(b => !b.future); return i === -1 ? 0 : i; })();
  const lightCurIdx = (() => { const i = lightBlocks.findIndex(p => (p.edition || '') <= _cym); return i === -1 ? 0 : i; })();

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

  const onEnter = () => {
    const el = ref.current;
    if (el) setRect(el.getBoundingClientRect());
    setHover(true);
    setWantRich(true);   // upgrade the tooltip to full tiers on first hover
  };
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
          {richBlocks.length > 0
            ? richBlocks.map((b, i) => <RichMonth key={i} b={b} current={i === richCurIdx} pack={bottlesPerCase(productName, b.pack ?? undefined)} />)
            : (
              <>
                {lightBlocks.map((p, i) => <LightMonth key={i} p={p} pack={pack} size={unitVolume} current={i === lightCurIdx} />)}
                <span className="psk-pop-loading">Loading the full QD / RIP tier schedule…</span>
              </>
            )}
        </span>
      )}
    </span>
  );
}
