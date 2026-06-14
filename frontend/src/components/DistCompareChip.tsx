/**
 * DistCompareChip — a compact "best vs N distributors" chip for a product,
 * shown near the product-page header ONLY when a cheaper distributor exists for
 * the product's main size (i.e. the best landed price AFTER all QD + RIP differs
 * between distributors). Hovering opens a side-by-side ladder: per distributor,
 * the list price, the price after the 1-case QD, every QD tier and every RIP
 * tier, for the CURRENT month, including time-sensitive (dated) windows that are
 * live now. All data comes from the size rows the page already fetched (with
 * tiers), so there is no extra request.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { distributorName } from '../lib/distributors';
import { sizeToMl, bottlesPerCase } from '../lib/productSizes';
import type { Product, CatalogTier } from '../lib/api';

const money = (n: number) => `$${n.toFixed(2)}`;
// A tier counts toward today's price only when its window is live NOW (or it has
// no dated window). Expired / upcoming are ignored; dated-live ("active") is
// kept — that's the time-sensitive case the buyer must see.
const LIVE = new Set(['whole_month', 'evergreen', 'active', null, undefined] as unknown[]);
const isLive = (t: CatalogTier) => LIVE.has(t.window_status ?? null);
const isTS = (t: CatalogTier) => t.window_status === 'active' || !!t.is_time_sensitive;

interface DistOffer {
  wholesaler: string;
  frontline: number | null;
  oneCsQD: number | null;       // case price after the 1-case QD
  best: number;                 // best landed $/case after ALL QD + RIP (live now)
  pack: number | null;          // bottles per case (for the $/btl savings)
  qd: CatalogTier[];
  rip: CatalogTier[];
}

// Reduce all rows of ONE distributor (same size) to its single best offer.
function buildOffer(w: string, rows: Product[]): DistOffer {
  let frontline: number | null = null;
  let best = Infinity;
  let oneCsQD: number | null = null;
  let qd: CatalogTier[] = [];
  let rip: CatalogTier[] = [];
  const pack = rows.length ? bottlesPerCase(rows[0].product_name, rows[0].unit_qty) : null;
  for (const r of rows) {
    const f = r.frontline_case_price ?? null;
    if (f != null && (frontline == null || f < frontline)) frontline = f;
    const live = (r.tiers ?? []).filter(isLive);
    // best after all QD + RIP = cheapest price_after over live tiers, else list
    let rowBest = f ?? Infinity;
    for (const t of live) if (t.price_after != null && t.price_after < rowBest) rowBest = t.price_after;
    if (rowBest < best) {
      best = rowBest;
      qd = live.filter(t => t.source === 'discount').sort((a, b) => a.qty - b.qty);
      rip = live.filter(t => t.source === 'rip')
        .sort((a, b) => (a.rip_only_save_per_case ?? a.save_per_case ?? 0) - (b.rip_only_save_per_case ?? b.save_per_case ?? 0));
      // price after the 1-case QD: the discount tier you reach buying one case
      const one = qd.filter(t => t.qty <= 1 && t.price_after != null);
      oneCsQD = one.length ? Math.min(...one.map(t => t.price_after as number)) : f;
    }
  }
  return { wholesaler: w, frontline, oneCsQD, best: best === Infinity ? (frontline ?? 0) : best, pack, qd, rip };
}

// Group the product's size rows by physical size; return the offers for the size
// that gives the most useful comparison (most distributors, then widest spread),
// but only sizes where the best landed price actually DIFFERS across distributors.
function pickComparison(sizes: Product[]): { sizeLabel: string; offers: DistOffer[] } | null {
  const groups = new Map<number, Product[]>();
  for (const s of sizes) {
    const ml = sizeToMl(s.unit_volume) || 0;
    const k = Math.round(ml / 5) * 5;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(s);
  }
  let pick: { sizeLabel: string; offers: DistOffer[]; spread: number } | null = null;
  for (const rows of groups.values()) {
    const byDist = new Map<string, Product[]>();
    for (const r of rows) (byDist.get(r.wholesaler) ?? byDist.set(r.wholesaler, []).get(r.wholesaler)!).push(r);
    if (byDist.size < 2) continue;
    const offers = [...byDist.entries()].map(([w, rs]) => buildOffer(w, rs))
      .filter(o => o.best > 0)             // drop rows with no usable price
      .sort((a, b) => a.best - b.best);
    if (offers.length < 2) continue;
    const spread = offers[offers.length - 1].best - offers[0].best;
    if (spread <= 0.01) continue;          // only when it's cheaper somewhere
    const sizeLabel = rows[0].unit_volume ?? '';
    const better = !pick || offers.length > pick.offers.length
      || (offers.length === pick.offers.length && spread > pick.spread);
    if (better) pick = { sizeLabel, offers, spread };
  }
  return pick ? { sizeLabel: pick.sizeLabel, offers: pick.offers } : null;
}

function OfferColumn({ o, best }: { o: DistOffer; best: boolean }) {
  return (
    <div className={`dcc-col${best ? ' is-best' : ''}`}>
      <div className="dcc-col-head">
        {distributorName(o.wholesaler)}
        {best && <span className="dcc-best-tag">cheapest</span>}
      </div>
      {o.frontline != null && <div className="dcc-line"><span>List</span><b>{money(o.frontline)}</b></div>}
      {o.oneCsQD != null && <div className="dcc-line"><span>After 1cs QD</span><b>{money(o.oneCsQD)}</b></div>}
      {o.qd.length > 0 && (
        <div className="dcc-block">
          <div className="dcc-block-h">Quantity discounts</div>
          {o.qd.map((t, i) => (
            <div key={`q${i}`} className="dcc-tier">
              {t.qty} cs → <b>{t.price_after != null ? money(t.price_after) : '—'}</b>
              {t.save_per_case > 0 && <span className="dcc-off"> (−{money(t.save_per_case)})</span>}
              {isTS(t) && <span className="dcc-ts" title="Time-limited window, live now">⏱</span>}
            </div>
          ))}
        </div>
      )}
      {o.rip.length > 0 && (
        <div className="dcc-block">
          <div className="dcc-block-h">RIP rebates</div>
          {o.rip.map((t, i) => {
            const reb = t.rip_only_save_per_case ?? t.save_per_case ?? 0;
            return (
              <div key={`r${i}`} className="dcc-tier">
                {t.qty} {/^\s*b/i.test(t.unit) ? 'btl' : 'cs'} → <b>{t.price_after != null ? money(t.price_after) : '—'}</b>
                {reb > 0 && <span className="dcc-off dcc-off-rip"> (RIP −{money(reb)})</span>}
                {isTS(t) && <span className="dcc-ts" title="Time-limited window, live now">⏱</span>}
              </div>
            );
          })}
        </div>
      )}
      <div className="dcc-line dcc-best-line"><span>Best / case</span><b>{money(o.best)}</b></div>
    </div>
  );
}

export default function DistCompareChip({ sizes, selfWholesaler }: { sizes: Product[]; selfWholesaler?: string }) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number; below: boolean } | null>(null);

  const cmp = pickComparison(sizes);

  useEffect(() => {
    if (!hover) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setHover(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hover]);

  useLayoutEffect(() => {
    if (!hover || !rect) { setPos(null); return; }
    const el = popRef.current;
    const W = el?.offsetWidth ?? 460, H = el?.offsetHeight ?? 260, M = 8;
    const below = rect.top - M - H < M;
    let left = rect.left + rect.width / 2 - W / 2;
    left = Math.max(M, Math.min(left, window.innerWidth - M - W));
    const top = below ? rect.bottom + M : rect.top - M - H;
    setPos({ left, top: Math.max(M, top), below });
  }, [hover, rect]);

  if (!cmp) return null;
  const { sizeLabel, offers } = cmp;
  const cheapest = offers[0];

  // When a self distributor is given (a single distributor's card), frame the
  // chip as a BEST-PRICE nudge: name the cheapest distributor and the savings
  // ($/cs and $/btl) vs THIS card. Otherwise (product page) show the absolute.
  const self = selfWholesaler ? offers.find(o => o.wholesaler === selfWholesaler) : null;
  const selfIsBest = self ? Math.abs(self.best - cheapest.best) < 0.01 : false;
  const saveCs = self && !selfIsBest ? self.best - cheapest.best : 0;
  const pack = cheapest.pack ?? self?.pack ?? null;
  const saveBtl = pack && saveCs > 0 ? saveCs / pack : null;

  return (
    <span
      className={`dcc${selfWholesaler ? ' dcc-self' : ''}${selfIsBest ? ' dcc-isbest' : ''}`}
      ref={ref}
      onMouseEnter={() => { if (ref.current) setRect(ref.current.getBoundingClientRect()); setHover(true); }}
      onMouseLeave={() => setHover(false)}
    >
      <span className="dcc-chip">
        {selfWholesaler
          ? (selfIsBest
              ? <>✓ Best price · <strong>{distributorName(cheapest.wholesaler)}</strong></>
              : <>Best price: <strong>{distributorName(cheapest.wholesaler)}</strong> · save {money(saveCs)}/cs{saveBtl != null ? ` (${money(saveBtl)}/btl)` : ''}</>)
          : <><strong>{distributorName(cheapest.wholesaler)}</strong> cheapest {money(cheapest.best)}/cs<span className="dcc-vs"> · vs {offers.length} distributors</span></>}
      </span>
      {hover && pos && (
        <div
          ref={popRef}
          className={`dcc-pop${pos.below ? ' dcc-pop-below' : ''}`}
          style={{ position: 'fixed', left: pos.left, top: pos.top }}
        >
          <div className="dcc-pop-title">
            Distributor comparison{sizeLabel ? ` · ${sizeLabel}` : ''} · this month
          </div>
          <div className="dcc-cols">
            {offers.map((o, i) => <OfferColumn key={o.wholesaler} o={o} best={i === 0} />)}
          </div>
          <div className="dcc-pop-foot">Best / case = landed price after all QD + RIP live this month (⏱ = time-limited).</div>
        </div>
      )}
    </span>
  );
}
