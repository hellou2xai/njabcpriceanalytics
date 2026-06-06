/**
 * "See price schedule" modal for the Products page.
 *
 * Mirrors the reference Provi-style layout: one stacked block per month —
 * CURRENT, NEXT, LAST — each showing the Frontline → Discount → RIP → Best
 * ladder as $/bottle – $/case with the quantity deals spelled out, all in the
 * same format. The historical months come from the same `price_3mo` payload the
 * Catalog sparkline uses (via buildMonths); the NEXT month is synthesised from
 * the row's `next_tiers` / `next_*_price` fields so the buyer sees this-month,
 * next-month and last-month side by side in one consistent shape.
 */
import { useEffect } from 'react';
import { buildMonths } from '../lib/promotionsSparkline';
import type { MonthBreakdown, RipTier } from './MonthEffectiveSparkline';
import { windowBadge } from '../lib/dealDates';
import type { Product, CatalogTier } from '../lib/api';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function fmtMonth(ed: string | null | undefined): string {
  if (!ed) return '';
  const m = /^(\d{4})-(\d{1,2})/.exec(ed);
  if (!m) return ed;
  return `${MONTHS[parseInt(m[2], 10) - 1] ?? ''} ${m[1]}`.trim();
}

// "2026-06" -> "2026-07" with year roll-over, so the NEXT block carries a label
// even though price_3mo only spans existing editions.
function nextYM(ym?: string | null): string | null {
  if (!ym) return null;
  const m = /^(\d{4})-(\d{1,2})$/.exec(ym);
  if (!m) return null;
  const y = parseInt(m[1], 10), mo = parseInt(m[2], 10);
  return `${mo === 12 ? y + 1 : y}-${String(mo === 12 ? 1 : mo + 1).padStart(2, '0')}`;
}

function tierToRip(t: CatalogTier): RipTier {
  return {
    qty: t.qty,
    unit: t.unit,
    eff: t.price_after ?? 0,
    ripOnlySave: t.rip_only_save_per_case ?? null,
    ts: !!t.is_time_sensitive,
    from_date: t.from_date,
    to_date: t.to_date,
    window_status: t.window_status,
    days_to_expire: t.days_to_expire,
  };
}

// Build the NEXT-month block from the row's next-edition fields. Returns null
// when there's no next-month pricing on file (the block then reads
// "No prices available", matching the reference).
function buildNextMonth(item: Product, currEdition: string | null): MonthBreakdown | null {
  const hasNext = item.next_case_price != null || (item.next_tiers ?? []).length > 0
    || item.next_effective_case_price != null;
  if (!hasNext) return null;
  const tiers = item.next_tiers ?? [];
  const disc = tiers.filter(t => t.source === 'discount').map(tierToRip).filter(t => t.eff > 0);
  const rip = tiers.filter(t => t.source === 'rip').map(tierToRip).filter(t => t.eff > 0);
  const bestDisc = disc.length ? Math.min(...disc.map(t => t.eff)) : null;
  const pack = item.unit_qty != null && Number(item.unit_qty) > 0 ? Number(item.unit_qty) : null;
  return {
    edition: nextYM(currEdition),
    frontline: item.next_case_price ?? null,
    afterDiscount: bestDisc,
    discountTiers: disc,
    ripTiers: rip,
    bestEff: item.next_effective_case_price ?? null,
    disc1: bestDisc,
    pack,
    size: item.unit_volume ?? null,
  };
}

function TierWin({ t }: { t: RipTier }) {
  const wb = windowBadge(t);
  if (wb) return <span className={`win-badge ${wb.cls}${wb.urgent ? ' urgent' : ''}`}>{wb.label}</span>;
  if (t.ts) return <span className="mes-ts-badge" title="Time-sensitive: window is not a full month. Not counted in the effective price.">TS</span>;
  return null;
}

// A single month's price ladder. Same Frontline → Discount → RIP → Best shape as
// the catalog sparkline popover, so the buyer reads one consistent format
// everywhere. `caption` is CURRENT / NEXT / LAST.
function ScheduleBlock({ b, caption, empty }:
  { b: MonthBreakdown | null; caption: string; empty?: boolean }) {
  const label = `${fmtMonth(b?.edition) || caption} `;
  if (empty || !b) {
    return (
      <div className="ps-block">
        <div className="ps-block-head">
          <span className="ps-block-month">{fmtMonth(b?.edition) || '—'}</span>
          <span className="ps-block-tag">{caption}</span>
        </div>
        <div className="ps-block-empty">No prices available</div>
      </div>
    );
  }
  const pack = b.pack && b.pack > 0 ? b.pack : null;
  const priceCB = (caseVal: number | null | undefined) => {
    if (caseVal == null) return <>&mdash;</>;
    const btl = pack ? `$${(caseVal / pack).toFixed(2)}/bottle` : null;
    return (
      <span>
        {btl && <strong>{btl}</strong>}
        {btl && <span className="ps-sep"> – </span>}
        <strong>${caseVal.toFixed(2)}/case</strong>
      </span>
    );
  };
  const sortedDisc = [...(b.discountTiers ?? [])].sort((a, c) => a.qty - c.qty);
  const sortedRip = [...(b.ripTiers ?? [])].sort((a, c) => a.qty - c.qty);
  const hasDeals = sortedDisc.length > 0 || sortedRip.length > 0;
  const unitWord = (t: RipTier) => (/btl|bottle/i.test(t.unit) ? (t.qty === 1 ? 'bottle' : 'bottles') : (t.qty === 1 ? 'case' : 'cases'));

  return (
    <div className="ps-block">
      <div className="ps-block-head">
        <span className="ps-block-month">{label.trim()}</span>
        <span className="ps-block-tag">{caption}</span>
      </div>
      <div className="ps-block-headline">{priceCB(b.bestEff ?? b.afterDiscount ?? b.frontline)}</div>
      {hasDeals && (
        <div className="ps-deals">
          <div className="ps-deals-title">Quantity Deals</div>
          {sortedDisc.map((t, i) => {
            const save = b.frontline != null ? b.frontline - t.eff : null;
            return (
              <div key={`d${i}`} className="ps-deal-row">
                <span className="ps-deal-buy">
                  Buy {t.qty} {unitWord(t)} <span className="ps-pill ps-pill-disc">Discount</span> <TierWin t={t} />
                </span>
                <span className="ps-deal-price">
                  ${t.eff.toFixed(2)}/case
                  {save != null && save > 0.005 && <span className="ps-deal-save"> (${save.toFixed(2)} off)</span>}
                  {pack && <span className="ps-deal-btl"> – ${(t.eff / pack).toFixed(2)}/bottle</span>}
                </span>
              </div>
            );
          })}
          {sortedRip.map((t, i) => {
            const save = (t.ripOnlySave != null && Number.isFinite(t.ripOnlySave))
              ? Number(t.ripOnlySave)
              : (b.frontline != null ? b.frontline - t.eff : null);
            return (
              <div key={`r${i}`} className="ps-deal-row">
                <span className="ps-deal-buy">
                  Buy {t.qty} {unitWord(t)} <span className="ps-pill ps-pill-rip">RIP</span> <TierWin t={t} />
                </span>
                <span className="ps-deal-price">
                  ${t.eff.toFixed(2)}/case
                  {save != null && save > 0.005 && <span className="ps-deal-save"> (${Math.max(0, save).toFixed(2)} off)</span>}
                  {pack && <span className="ps-deal-btl"> – ${(t.eff / pack).toFixed(2)}/bottle</span>}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function PriceScheduleModal({ item, onClose }: { item: Product; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const months = buildMonths(item);                       // oldest -> newest, existing editions
  const desc = [...months].reverse();                     // newest -> oldest
  const current = desc[0] ?? null;
  const currEdition = current?.edition ?? item.edition ?? null;
  const next = buildNextMonth(item, currEdition);

  // Always aim to show THREE months of real data. When a next month exists we
  // show Current / Next / Last (like the reference); when it doesn't (the
  // current edition is the latest on file), we show the three most recent
  // existing months instead of wasting a panel on an empty "NEXT".
  const panels: { b: MonthBreakdown | null; caption: string }[] = [
    { b: current, caption: 'CURRENT' },
  ];
  if (next) {
    panels.push({ b: next, caption: 'NEXT' });
    panels.push({ b: desc[1] ?? null, caption: 'LAST' });
  } else {
    panels.push({ b: desc[1] ?? null, caption: 'LAST' });
    panels.push({ b: desc[2] ?? null, caption: 'EARLIER' });
  }

  const pack = item.unit_qty && Number(item.unit_qty) > 0 ? Number(item.unit_qty) : null;

  return (
    <div className="ps-overlay" onClick={onClose}>
      <div className="ps-modal" role="dialog" aria-modal="true" aria-label="Price schedule"
           onClick={e => e.stopPropagation()}>
        <div className="ps-modal-head">
          <h3>Price schedule</h3>
          <button className="ps-close" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="ps-identity">
          <div className="ps-identity-name">{item.product_name}</div>
          <div className="ps-identity-sub">
            {[item.unit_volume, pack ? `${pack} bottles/case` : null].filter(Boolean).join(' · ')}
          </div>
        </div>
        <div className="ps-blocks">
          {panels.map((p, i) => (
            <ScheduleBlock key={i} b={p.b} caption={p.caption} empty={!p.b} />
          ))}
        </div>
      </div>
    </div>
  );
}
