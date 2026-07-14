/**
 * Compare RIP + QD — combines Compare RIPs and Compare QD into one page: the
 * RIP tier ladder AND the QD tier ladder, side by side across 2-3
 * distributors, plus the combined "buy at the deepest tier of both" best
 * price. Built ENTIRELY from existing pieces, per project instruction:
 *   - filter rail + card shell = Compare Distributor Prices
 *     (Discover.css `.disc-filter-*` / `.disc-cmp-*`, CompareGrid.tsx pattern)
 *   - RIP tier chip styling = Compare RIPs (`.rip2-tier-chip`, `.is-diff`)
 *   - QD tier chip styling = Compare QD (`.qd2-tier-chip`, `.is-diff`)
 *   - "best" highlight = the canonical `.hl-best` token (DESIGN_SYSTEM.md §2)
 * No new UI components, chip markup, colors, or pricing formulas — the
 * numbers come straight from backend routers/compare.py:compare_rip_qd,
 * which itself only calls the same helpers /rips and /qds already use.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Store, SlidersHorizontal, PanelLeftClose, ChevronDown } from 'lucide-react';
import { compare, type RipQdRow, type RipQdDist, type RipQdTierRow } from '../lib/api';
import ProductThumb from '../components/ProductThumb';
import AvailabilityButton from '../components/AvailabilityButton';
import ProductSearchBox from '../components/ProductSearchBox';
import { distributorName, ALL_DISTRIBUTORS } from '../lib/distributors';
import './Discover.css';
import './CompareRips.css';
import './CompareQD.css';
import './CompareRipQd.css';

const SORT_OPTS: [string, string][] = [
  ['tier', 'Highest RIP/QD tier'], ['spread', 'Biggest price gap'], ['name', 'Product name'],
];
const DIST_PINNED = ['allied', 'fedway', 'opici'];
const DISTRIBUTOR_OPTS = [...ALL_DISTRIBUTORS.filter((d) => d.value)].sort((a, b) => {
  const ia = DIST_PINNED.indexOf(a.value); const ib = DIST_PINNED.indexOf(b.value);
  return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
});

function money(n?: number | null): string | null {
  return n == null ? null : `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}
function money2(n?: number | null): string | null {
  return n == null ? null : `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function pack(d: RipQdDist): number | null {
  return d.unit_qty ? parseInt(String(d.unit_qty), 10) : null;
}
function btl(d: RipQdDist, v: number | null): number | null {
  const p = pack(d);
  return p && v != null ? v / p : null;
}
function cardHref(w: string, d: RipQdDist): string {
  const q = new URLSearchParams({ w, n: d.product_name ?? '' });
  if (d.upc) q.set('u', String(d.upc));
  if (d.unit_volume) q.set('s', String(d.unit_volume));
  if (d.unit_qty) q.set('pk', String(d.unit_qty));
  if (d.vintage != null && String(d.vintage) !== '') q.set('v', String(d.vintage));
  return `/product?${q.toString()}`;
}

// Anything within $2 doesn't read as a real distributor difference — sheets
// carry penny/rounding-level noise (see the SVEDKA 1.75L case: $95.95 vs
// $95.94, both display as "$96/cs" but a naive >0 check still flagged it).
// Applies uniformly to the headline 1-case price gap AND to individual
// RIP/QD tier amounts.
const MIN_DIFF = 2;

// A tier's identity for MATCHING across distributors is buy-in + unit only
// (never the amount, never is_time_sensitive/date — two sheets can list the
// identical whole-month rebate with a one-day-different "to_date", e.g. July
// 30 vs 31, and get classified TS on one side only; that's not a real
// difference either). Genuine TS-only deals still get their own amber "TS"
// sticker on the chip (`.is-ts`).
function tierBuyKey(t: RipQdTierRow): string {
  return `${t.cases_to_unlock ?? ''}|${(t.unit ?? '').toLowerCase().startsWith('b') ? 'b' : 'c'}`;
}
// The 1-case QD tier is already subtracted into the headline 1-case price
// (one_cs_case_price, the "_one_cs rule") — showing it again as its own QD
// chip double-counts it. Strip it from both the visible ladder and the
// common/diff comparison; deeper QD tiers (2cs+) are unaffected.
function isBakedInOneCsQd(t: RipQdTierRow): boolean {
  return t.cases_to_unlock === 1 && !(t.unit ?? '').toLowerCase().startsWith('b');
}
// A buy-in tier is "common" (not highlighted, not a real difference) when
// EVERY distributor offers that same buy-in quantity AND all their amounts
// are within MIN_DIFF of each other. A buy-in only some distributors have at
// all is automatically NOT common (a real difference: one offers it, one
// doesn't).
function commonTierKeys(dists: Record<string, RipQdDist>, field: 'rip_tiers' | 'qd_tiers',
  amountField: 'total_rebate' | 'rebate_per_case', filterFn?: (t: RipQdTierRow) => boolean): Set<string> {
  const all = Object.values(dists);
  if (all.length < 2) return new Set();
  const byBuyKey = new Map<string, number[]>();
  for (const d of all) {
    for (const t of d[field]) {
      if (filterFn && !filterFn(t)) continue;
      const amt = t[amountField];
      if (amt == null) continue;
      const k = tierBuyKey(t);
      (byBuyKey.get(k) ?? byBuyKey.set(k, []).get(k)!).push(amt);
    }
  }
  const common = new Set<string>();
  for (const [k, amts] of byBuyKey) {
    if (amts.length >= all.length && Math.max(...amts) - Math.min(...amts) < MIN_DIFF) common.add(k);
  }
  return common;
}

// Compact inline tier ladder: "X Cs / $XXX" (RIP, total rebate) or
// "X Cs / $XXX/Cs" (QD, price after) — same fields DistPanel already reads,
// same .rip2-tier-chip / .qd2-tier-chip / .is-diff classes it already uses.
function TierChips({ tiers, common, displayField, displaySuffix, chipClass, wrapClass }: {
  tiers: RipQdTierRow[]; common: Set<string>;
  displayField: 'total_rebate' | 'rebate_per_case' | 'price_after';
  displaySuffix: string; chipClass: 'rip2-tier-chip' | 'qd2-tier-chip'; wrapClass: string;
}) {
  if (!tiers.length) return null;
  return (
    <div className={wrapClass}>
      {tiers.map((t, i) => {
        const diff = !common.has(tierBuyKey(t));
        const amt = t[displayField];
        const win = t.is_time_sensitive && t.from_date && t.to_date
          ? `${t.from_date.slice(5)}–${t.to_date.slice(5)}` : null;
        return (
          <span key={i} className={`${chipClass}${t.is_time_sensitive ? ' is-ts' : ''}${diff ? ' is-diff' : ''}`}
            title={`${t.buy_label ?? `${t.raw_qty} ${t.unit ?? ''}`} → ${money(amt)}${displaySuffix}` +
              `${win ? ` · valid ${win}` : ' · valid all month'}` +
              `${diff ? ' · differs from the other distributor' : ''}`}>
            {t.buy_label ?? `${t.raw_qty}${(t.unit ?? '').toLowerCase().startsWith('b') ? 'btl' : 'cs'}`}
            {' / '}<strong>{money(amt)}{displaySuffix}</strong>
          </span>
        );
      })}
    </div>
  );
}

// One distributor's offer inside a comparison group: the CmpCard shell from
// Compare Distributor Prices (1-case price + bottle price highlighted), with
// the RIP ladder, the QD ladder (kept as SEPARATE ladders — never blended,
// per project deal-display rule), and the combined best price at the bottom.
function RipQdCard({ w, d, cheapest, ripCommon, qdCommon }: {
  w: string; d: RipQdDist; cheapest: boolean; ripCommon: Set<string>; qdCommon: Set<string>;
}) {
  const oneCs = d.one_cs_case_price ?? d.frontline_case_price ?? null;
  const bp = pack(d);
  const bestBtl = bp && d.best_case_price != null ? d.best_case_price / bp : null;
  const qdTiers = d.qd_tiers.filter((t) => !isBakedInOneCsQd(t));
  return (
    <Link to={cardHref(w, d)} className={`disc-cmp-card${cheapest ? ' is-cheapest' : ''}`}>
      <div className="disc-cmp-card-top">
        <span className="disc-card-dist"><Store size={11} /> {distributorName(w)}</span>
        {cheapest && <span className="disc-cmp-win">Cheapest</span>}
      </div>
      {/* real 1-case price (list minus 1-case QD) — the same field/logic CmpCard uses */}
      <div className="disc-cmp-price-row">
        <div className="disc-cmp-price">{money(oneCs)}<span className="disc-cmp-price-u">/cs</span></div>
        <div className="disc-cmp-btl">{money2(btl(d, oneCs))}/btl</div>
      </div>

      {d.rip_tiers.length > 0 && (
        <div className="ripqd-section">
          <span className="ripqd-section-label ripqd-section-label--rip">RIP rebate</span>
          <TierChips tiers={d.rip_tiers} common={ripCommon} displayField="total_rebate"
            displaySuffix="" chipClass="rip2-tier-chip" wrapClass="rip2-dist-tiers" />
        </div>
      )}
      {qdTiers.length > 0 && (
        <div className="ripqd-section">
          <span className="ripqd-section-label ripqd-section-label--qd">Quantity discount</span>
          <TierChips tiers={qdTiers} common={qdCommon} displayField="price_after"
            displaySuffix="/Cs" chipClass="qd2-tier-chip" wrapClass="qd2-dist-tiers" />
        </div>
      )}

      {d.best_case_price != null && (
        <div className="disc-cmp-deals ripqd-best-row">
          <span className="hl-best"
            title={`What you pay per case buying at the deepest QD tier AND the deepest RIP tier together (${d.best_case_cases ?? 1} case${(d.best_case_cases ?? 1) === 1 ? '' : 's'}).`}>
            Best {money(d.best_case_price)}/cs{bestBtl != null ? ` · ${money2(bestBtl)}/btl` : ''}
          </span>
        </div>
      )}

      <AvailabilityButton wholesaler={w} name={d.product_name ?? undefined} itemNumber={d.item_no ?? undefined} className="disc-cmp-avail" />
    </Link>
  );
}

// A product's side-by-side comparison — the SAME disc-cmp-group shell
// CompareGroup (Compare Distributor Prices) uses.
function RipQdGroup({ row, selected }: { row: RipQdRow; selected: string[] }) {
  const size = [row.unit_volume, row.unit_qty ? `${row.unit_qty}/cs` : null].filter(Boolean).join(', ');
  const oneCsVals = selected
    .map((w) => row.dists[w])
    .filter((d): d is RipQdDist => !!d)
    .map((d) => d.one_cs_case_price ?? d.frontline_case_price ?? null)
    .filter((v): v is number => v != null);
  const minOneCs = oneCsVals.length ? Math.min(...oneCsVals) : null;
  const ripCommon = commonTierKeys(row.dists, 'rip_tiers', 'total_rebate');
  const qdCommon = commonTierKeys(row.dists, 'qd_tiers', 'rebate_per_case', (t) => !isBakedInOneCsQd(t));
  return (
    <div className="disc-cmp-group">
      <div className="disc-cmp-head">
        <ProductThumb src={row.image_url ?? undefined} alt={row.product_name} size={40} />
        <div className="disc-cmp-meta">
          <div className="disc-cmp-name">{row.product_name}</div>
          {size && <div className="disc-cmp-size">{size}</div>}
        </div>
        <div className="disc-cmp-tags">
          {row.spread_one_cs >= MIN_DIFF
            ? <span className="disc-cmp-gap">{money(row.spread_one_cs)}/cs gap</span>
            : <span className="disc-cmp-gap disc-cmp-gap--same">Same 1-cs</span>}
        </div>
      </div>
      <div className="disc-cmp-cards">
        {selected.map((w) => {
          const d = row.dists[w];
          if (!d) return null;
          const oneCs = d.one_cs_case_price ?? d.frontline_case_price ?? null;
          return (
            <RipQdCard key={w} w={w} d={d} cheapest={oneCs != null && minOneCs != null && oneCs === minOneCs}
              ripCommon={ripCommon} qdCommon={qdCommon} />
          );
        })}
      </div>
    </div>
  );
}

// A collapsible filter section — copied from CompareGrid.tsx (Compare
// Distributor Prices) verbatim, same skin the rest of the rail uses.
function FilterSection({ title, count = 0, defaultOpen = true, children }:
  { title: string; count?: number; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="disc-filter-sect">
      <button type="button" className="disc-filter-h disc-filter-h--btn"
        aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span>{title}{count > 0 && <span className="disc-filter-count">{count}</span>}</span>
        <ChevronDown size={14} className={`disc-filter-chev${open ? ' is-open' : ''}`} />
      </button>
      {open && <div className="disc-filter-body">{children}</div>}
    </div>
  );
}

// This is a COMPARE page — a row where every distributor charges the same
// 1-case price AND has the identical RIP ladder AND the identical QD ladder
// (ignoring the baked-in 1cs QD) has nothing to compare and is just noise,
// especially once sorted to the top by tier depth. Reuses the exact same
// common/diff logic the card highlighting uses, so "shown" and "highlighted
// as different" never disagree.
function rowDiffers(row: RipQdRow): boolean {
  if ((row.spread_one_cs ?? 0) >= MIN_DIFF) return true;
  const ripCommon = commonTierKeys(row.dists, 'rip_tiers', 'total_rebate');
  const qdCommon = commonTierKeys(row.dists, 'qd_tiers', 'rebate_per_case', (t) => !isBakedInOneCsQd(t));
  return Object.values(row.dists).some((d) =>
    d.rip_tiers.some((t) => !ripCommon.has(tierBuyKey(t))) ||
    d.qd_tiers.filter((t) => !isBakedInOneCsQd(t)).some((t) => !qdCommon.has(tierBuyKey(t))));
}

// The deepest case-quantity tier this product unlocks at ANY selected
// distributor, across BOTH the RIP and QD ladders — e.g. a 40-case QD tier
// outranks a 3-case RIP tier. Bottle-quantity tiers (unit starts with 'b')
// don't count as a "case size" for this ranking.
function maxTierCases(row: RipQdRow): number {
  let max = 0;
  for (const d of Object.values(row.dists)) {
    for (const t of [...d.rip_tiers, ...d.qd_tiers]) {
      if ((t.unit ?? '').toLowerCase().startsWith('b')) continue;
      if (t.cases_to_unlock != null && t.cases_to_unlock > max) max = t.cases_to_unlock;
    }
  }
  return max;
}

export default function CompareRipQd() {
  const [distSet, setDistSet] = useState<Set<string>>(new Set(['allied', 'fedway']));
  const [catSet, setCatSet] = useState<Set<string>>(new Set());
  const [sizeSet, setSizeSet] = useState<Set<string>>(new Set());
  const [monthMode, setMonthMode] = useState<'cur' | 'next'>('cur');
  const [sortBy, setSortBy] = useState('tier');
  const [q, setQ] = useState('');
  const [collapsed, setCollapsed] = useState(false);

  const dists = [...distSet];
  const ready = dists.length >= 2 && dists.length <= 3;

  const { data, isLoading } = useQuery({
    queryKey: ['compare-rip-qd', dists, q, monthMode],
    enabled: ready,
    queryFn: () => compare.ripQd({ wholesalers: dists.join(','), q: q || undefined, month_mode: monthMode, limit: 200 }),
  });

  const rows = data?.rows ?? [];
  const types = useMemo(() => {
    const s = new Set<string>();
    rows.forEach((r) => { if (r.product_type) s.add(r.product_type); });
    return [...s].sort();
  }, [rows]);
  const sizes = useMemo(() => {
    const s = new Set<string>();
    rows.forEach((r) => { if (r.unit_volume) s.add(r.unit_volume); });
    return [...s].sort();
  }, [rows]);
  const filtered = rows
    .filter((r) =>
      (catSet.size === 0 || catSet.has(r.product_type ?? '')) &&
      (sizeSet.size === 0 || sizeSet.has(r.unit_volume ?? '')) &&
      rowDiffers(r))
    .sort((a, b) => sortBy === 'name'
      ? (a.product_name ?? '').localeCompare(b.product_name ?? '')
      : sortBy === 'spread'
        ? (b.spread_one_cs ?? 0) - (a.spread_one_cs ?? 0)
        : maxTierCases(b) - maxTierCases(a));

  const activeCount = catSet.size + sizeSet.size + (monthMode === 'next' ? 1 : 0);

  return (
    <div className="disc-page">
      <header className="disc-hero">
        <h1 className="disc-title">Compare RIP + QD</h1>
        <p className="disc-sub">Every RIP and quantity-discount tier, side by side across distributors, plus the best combined price</p>
      </header>

      <div className={`disc-body${collapsed ? ' disc-body--nofilters' : ''}`}>
        {collapsed ? (
          <button type="button" className="disc-filters-show" onClick={() => setCollapsed(false)}>
            <SlidersHorizontal size={16} /> Filters{activeCount > 0 ? ` (${activeCount})` : ''}
          </button>
        ) : (
          <aside className="disc-filters">
            <div className="disc-filters-head">
              <span>Filters</span>
              <span className="disc-filters-head-actions">
                {activeCount > 0 && (
                  <button type="button" className="disc-filters-clear"
                    onClick={() => { setCatSet(new Set()); setSizeSet(new Set()); setMonthMode('cur'); }}>Clear</button>
                )}
                <button type="button" className="disc-filters-collapse" title="Collapse filters" onClick={() => setCollapsed(true)}>
                  <PanelLeftClose size={16} />
                </button>
              </span>
            </div>

            <FilterSection title="Month">
              <select className="disc-filter-select" value={monthMode}
                onChange={(e) => setMonthMode(e.target.value === 'next' ? 'next' : 'cur')}>
                <option value="cur">This month</option>
                <option value="next">Next month</option>
              </select>
            </FilterSection>

            <FilterSection title="Sort by">
              <select className="disc-filter-select" value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
                {SORT_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </FilterSection>

            <FilterSection title="Distributor" count={distSet.size}>
              <div className="disc-filter-hint">Pick 2-3 to compare side by side</div>
              <div className="disc-filter-list">
                {DISTRIBUTOR_OPTS.map((d) => (
                  <label key={d.value} className="disc-filter-opt">
                    <input type="checkbox" checked={distSet.has(d.value)}
                      onChange={() => setDistSet((s) => {
                        const n = new Set(s);
                        if (n.has(d.value)) n.delete(d.value);
                        else if (n.size < 3) n.add(d.value);
                        return n;
                      })} />
                    <span>{d.label}</span>
                  </label>
                ))}
              </div>
            </FilterSection>

            <FilterSection title="Search">
              <ProductSearchBox value={q} placeholder="Product or brand…"
                onChange={setQ} onSelect={(p) => setQ(p.product_name)} />
            </FilterSection>

            <FilterSection title="Category" count={catSet.size}>
              <div className="disc-filter-list">
                {types.length === 0 && <div className="disc-filter-hint">All categories</div>}
                {types.map((t) => (
                  <label key={t} className="disc-filter-opt">
                    <input type="checkbox" checked={catSet.has(t)}
                      onChange={() => setCatSet((s) => { const n = new Set(s); n.has(t) ? n.delete(t) : n.add(t); return n; })} />
                    <span>{t}</span>
                  </label>
                ))}
              </div>
            </FilterSection>

            <FilterSection title="Size" count={sizeSet.size}>
              <div className="disc-filter-list">
                {sizes.length === 0 && <div className="disc-filter-hint">All sizes</div>}
                {sizes.map((s) => (
                  <label key={s} className="disc-filter-opt">
                    <input type="checkbox" checked={sizeSet.has(s)}
                      onChange={() => setSizeSet((x) => { const n = new Set(x); n.has(s) ? n.delete(s) : n.add(s); return n; })} />
                    <span>{s}</span>
                  </label>
                ))}
              </div>
            </FilterSection>
          </aside>
        )}

        <div className="disc-rails">
          <section className="disc-rail">
            <div className="disc-rail-head">
              <h2 className="disc-rail-title">RIP + QD comparison</h2>
              <span className="disc-rail-count">{filtered.length}</span>
            </div>
            {!ready ? (
              <div className="disc-rail-empty">Pick 2-3 distributors in the filters to compare their RIP and QD tiers.</div>
            ) : isLoading ? (
              <div className="disc-rail-loading">Loading…</div>
            ) : filtered.length === 0 ? (
              <div className="disc-rail-empty">No shared RIP/QD products for the selected distributors.</div>
            ) : (
              <div className="disc-cmp-grid">
                {filtered.map((r) => <RipQdGroup key={r.match_key} row={r} selected={dists} />)}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
