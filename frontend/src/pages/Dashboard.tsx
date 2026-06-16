import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { analytics, deals, catalog, watchlist, orders, notes } from '../lib/api';
import type { WatchlistItem, Order, AllNote, TimeSensitiveDeal, NewItemsResponse } from '../lib/api';
import KPICard from '../components/KPICard';
import SortableTable from '../components/SortableTable';
import WholesalerFilter from '../components/WholesalerFilter';
import RowLimitSelect from '../components/RowLimitSelect';
import { useProductQuickView } from '../components/ProductQuickView';
import { useAuth } from '../contexts/AuthContext';
import { DashboardTile, TileFilterBar } from '../components/DashboardTile';
import SmartHeaderStrip from '../components/SmartHeaderStrip';
import ProInsightsTiles from '../components/ProInsightsTiles';
import { useTableFilters } from '../hooks/useTableFilters';
import { distributorName } from '../lib/distributors';
import { Package, BadgePercent, TrendingDown, ArrowDownRight, ArrowUpRight, Zap, ArrowRight } from 'lucide-react';

function monthLabel(ym: string): string {
  if (!ym) return '';
  const [y, m] = ym.split('-');
  const names = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const idx = parseInt(m, 10) - 1;
  return idx >= 0 && idx < 12 ? `${names[idx]} ${y}` : ym;
}

function fmt$(v: number | null | undefined): string {
  return v == null ? '-' : `$${Number(v).toFixed(2)}`;
}

function fmtDate(d?: string | null): string {
  if (!d) return '—';
  const [y, m, day] = d.split(/[ T]/)[0].split('-').map(Number);
  if (!y || !m || !day) return d;
  return new Date(y, m - 1, day).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// Faceted filtering for the tile popups now lives in the shared
// useTableFilters hook (search + category + price range + deal flags).

export default function Dashboard() {
  const [wholesaler, setWholesaler] = useState('');
  const { open } = useProductQuickView();
  const { user } = useAuth();
  const isAdmin = !!user?.is_admin;

  const { data: kpis } = useQuery({
    queryKey: ['dashboard', wholesaler],
    queryFn: () => analytics.dashboard({ wholesaler: wholesaler || undefined }),
  });

  const { data: drops } = useQuery({
    queryKey: ['movers-down', wholesaler],
    enabled: isAdmin,   // Biggest Price Drops tile is admin-only
    queryFn: () => analytics.priceMovers({ wholesaler: wholesaler || undefined, direction: 'down', limit: 200 }),
  });

  const { data: topDeals } = useQuery({
    queryKey: ['top-deals', wholesaler],
    queryFn: () => deals.discounts({ wholesaler: wholesaler || undefined, per_category: true, limit: 200 }),
  });

  const { data: priceCmp } = useQuery({
    queryKey: ['price-comparison', wholesaler],
    queryFn: () => catalog.priceComparison({
      wholesaler: wholesaler || undefined,
      direction: 'any',
      min_abs_delta_pct: 0.01,
      sort: 'abs_delta_pct',
      order: 'desc',
      limit: 50000,
    }),
  });

  const { data: crossDist } = useQuery({
    queryKey: ['cross-distributor', 'a'],
    queryFn: () => catalog.crossDistributor({
      distributor_a: 'allied',
      distributor_b: 'fedway',
      cheaper: 'a',
      min_abs_savings_pct: 0.01,
      sort: 'abs_savings_pct',
      order: 'desc',
      limit: 50000,
    }),
  });
  const { data: crossDistB } = useQuery({
    queryKey: ['cross-distributor', 'b'],
    queryFn: () => catalog.crossDistributor({
      distributor_a: 'allied',
      distributor_b: 'fedway',
      cheaper: 'b',
      min_abs_savings_pct: 0.01,
      sort: 'abs_savings_pct',
      order: 'desc',
      limit: 50000,
    }),
  });
  // Items where OPICI beats the cheaper of Allied + Fedway combined.
  const { data: crossOpiciCombined } = useQuery({
    queryKey: ['cross-distributor-combined', 'opici'],
    queryFn: () => catalog.crossDistributorCombined({
      distributor: 'opici',
      competitors: 'allied,fedway',
      min_abs_savings_pct: 0.01,
      sort: 'abs_savings_pct',
      order: 'desc',
      limit: 50000,
    }),
  });

  const { data: qaReport } = useQuery({
    queryKey: ['qa-anomalies'],
    queryFn: () => catalog.qaAnomalies({ limit_per_check: 50 }),
    enabled: isAdmin,   // data-quality diagnostics are admin-only
  });

  const { data: timeSensitive } = useQuery({
    queryKey: ['time-sensitive', wholesaler],
    queryFn: () => deals.timeSensitive({ wholesaler: wholesaler || undefined, include_past: true }),
  });

  const { data: newItems } = useQuery({
    queryKey: ['new-items-tile', wholesaler],
    queryFn: () => catalog.newItems({ wholesaler: wholesaler || undefined, limit: 5000 }),
  });

  // ---- My Workspace: user-specific data ----
  const { data: favorites } = useQuery({ queryKey: ['watchlist'], queryFn: watchlist.get });
  const { data: draftOrders } = useQuery({
    queryKey: ['orders', 'draft'], queryFn: () => orders.list('draft'),
  });
  const { data: submittedOrders } = useQuery({
    queryKey: ['orders', 'submitted'], queryFn: () => orders.list('submitted'),
  });
  const { data: myNotes } = useQuery({ queryKey: ['notes', 'all'], queryFn: notes.all });

  // Price Drops / Increases KPIs are derived from the SAME matched-edition
  // price-comparison the "Price Changes (MoM)" tile uses, so the headline count,
  // the tile and the comparison pages all agree on one definition of a price
  // move (latest two editions, deduped by SKU). See FOUNDATION / the dashboard
  // tile accuracy test.
  const cmpDrops = useMemo(
    () => (priceCmp?.items ?? []).filter((r: any) => (r.delta_pct ?? 0) < 0).length,
    [priceCmp],
  );
  const cmpHikes = useMemo(
    () => (priceCmp?.items ?? []).filter((r: any) => (r.delta_pct ?? 0) > 0).length,
    [priceCmp],
  );

  return (
    <div className="page">
      <SmartHeaderStrip rightSlot={<WholesalerFilter value={wholesaler} onChange={setWholesaler} />} />

      <div className="section-label">Key Metrics</div>
      {!kpis ? (
        <div className="kpi-grid">
          {Array.from({ length: 6 }).map((_, i) => <div key={i} className="kpi-card kpi-skeleton" />)}
        </div>
      ) : (
        <div className="kpi-grid">
          <KPICard label="Total Items" value={kpis.total_items} color="#2563eb" icon={<Package size={20} />}
                   to={`/catalog${wholesaler ? `?wholesaler=${wholesaler}` : ''}`}
                   title="Open the full catalog" />
          <KPICard label="Active Discounts" value={kpis.active_discounts} color="#16a34a" icon={<BadgePercent size={20} />}
                   sub={`$${kpis.total_savings_pool?.toLocaleString()} savings pool`}
                   to="/discounts" title="Open the Discounts ranker" />
          <KPICard label="Clearance Items" value={kpis.clearance_items} color="#dc2626" icon={<TrendingDown size={20} />}
                   to="/clearance" title="Open the Clearance / Closeout list" />
          <KPICard label="Price Drops" value={priceCmp ? cmpDrops : '…'} color="#16a34a" icon={<ArrowDownRight size={20} />}
                   to="/price-drops" title="Open Price Drops" />
          <KPICard label="Price Increases" value={priceCmp ? cmpHikes : '…'} color="#ea580c" icon={<ArrowUpRight size={20} />}
                   to="/price-increases" title="Open Price Increases" />
          <KPICard label="Active RIPs" value={kpis.active_rips} color="#7c3aed" icon={<Zap size={20} />}
                   to="/catalog?hasRip=1" title="Open Catalog filtered to products with a RIP rebate" />
        </div>
      )}

      <div className="section-label">My Workspace</div>
      <div className="dashboard-tile-grid">
        <FavoritesTile data={favorites} open={open} />
        <OrdersTile data={draftOrders} label="My Orders in Progress" accent="#3b82f6"
          subtitle="Draft orders you're still building" status="draft" />
        <OrdersTile data={submittedOrders} label="My Submitted Orders" accent="#10b981"
          subtitle="Orders sent to distributors" status="submitted" />
        <NotesTile data={myNotes} open={open} />
      </div>

      <div className="section-label">Insights &amp; Opportunities</div>
      <div className="dashboard-tile-grid">
        <NewItemsTile data={newItems} open={open} />
        <TimeSensitiveTile data={timeSensitive} open={open} />
        {isAdmin && <PriceDropsTile data={drops} open={open} />}
        <TopDealsTile data={topDeals} open={open} />
        <PriceChangesTile data={priceCmp} open={open} />
        <CrossDistTile data={crossDist} label="Allied Cheaper" accent="var(--green)" open={open} />
        <CrossDistTile data={crossDistB} label="Fedway Cheaper" accent="#8b5cf6" open={open} />
        <CrossDistTile data={crossOpiciCombined} label="OPICI Cheaper" accent="#0ea5e9" open={open} />
        {isAdmin && <QATile data={qaReport} />}
      </div>

      {/* Pro Insights teaser block. Sample-data tiles + a drill-down modal that
          previews what the POS-integrated upgrade unlocks. Sits at the END of
          the dashboard (below the live data) since it's a preview, not data. */}
      <ProInsightsTiles />
    </div>
  );
}

// ---------- individual tile components ----------

// Bottles per case from unit_qty (e.g. "12").
function tsdQty(r: TimeSensitiveDeal): number {
  const q = r.unit_qty ? parseInt(r.unit_qty, 10) : 0;
  return isNaN(q) ? 0 : q;
}
// Discounted case price; fall back to the full price when there is no discount.
function tsdNetCase(r: TimeSensitiveDeal): number | null {
  return r.effective_case_price ?? r.frontline_case_price ?? null;
}
function tsdNetBtl(r: TimeSensitiveDeal): number | null {
  const q = tsdQty(r); const c = tsdNetCase(r);
  return q > 0 && c != null ? c / q : null;
}
// GP% = full price vs discounted price. No shelf price needed: the full
// (frontline) case price is the reference, the discounted price is the cost.
function tsdGp(r: TimeSensitiveDeal): number | null {
  const full = r.frontline_case_price; const net = tsdNetCase(r);
  if (full == null || net == null || full <= 0) return null;
  return ((full - net) / full) * 100;
}

// Gap in days between the deal start and end (0 = single day).
function tsdSpanDays(r: TimeSensitiveDeal): number | null {
  if (!r.from_date || !r.to_date) return null;
  const f = Date.parse(r.from_date); const t = Date.parse(r.to_date);
  if (isNaN(f) || isNaN(t)) return null;
  return Math.round((t - f) / 86400000);
}
// A coloured sticker for short-window deals: 1-day only, or under a week.
function tsdSticker(r: TimeSensitiveDeal) {
  const s = tsdSpanDays(r);
  if (s == null) return null;
  const base: React.CSSProperties = {
    display: 'inline-block', marginLeft: 6, padding: '1px 6px', borderRadius: 4,
    fontSize: 10, fontWeight: 700, letterSpacing: 0.3, verticalAlign: 'middle', whiteSpace: 'nowrap',
  };
  if (s <= 0) return <span style={{ ...base, background: '#fee2e2', color: '#b91c1c' }}>1-DAY ONLY</span>;
  if (s < 7) return <span style={{ ...base, background: '#ffedd5', color: '#c2410c' }}>UNDER A WEEK</span>;
  return null;
}

function TimeSensitiveTile({ data, open }: { data: TimeSensitiveDeal[] | undefined; open: (n: string, w: string, c?: any, opts?: { upc?: string; unitVolume?: string }) => void }) {
  const [win, setWin] = useState<'all' | '3' | '7' | '14' | 'next' | 'past'>('all');
  const [dist, setDist] = useState('');
  const items = data ?? [];
  // First day of next month, in ms, to split this-month deals from next-month.
  const firstNextMonth = useMemo(() => { const n = new Date(); return Date.UTC(n.getFullYear(), n.getMonth() + 1, 1); }, []);
  const isNextMonth = (r: TimeSensitiveDeal) => r.to_date != null && Date.parse(r.to_date) >= firstNextMonth;
  const active = useMemo(() => items.filter(i => i.days_to_expire != null && i.days_to_expire >= 0), [items]);
  const distributors = useMemo(() => [...new Set(items.map(i => i.wholesaler).filter(Boolean))].sort(), [items]);
  const filtered = useMemo(() => {
    let r = items;
    if (dist) r = r.filter(i => i.wholesaler === dist);
    if (win === 'past') {
      r = r.filter(i => i.days_to_expire != null && i.days_to_expire < 0);
    } else if (win === 'next') {
      r = r.filter(i => i.days_to_expire != null && i.days_to_expire >= 0 && isNextMonth(i));
    } else {
      r = r.filter(i => i.days_to_expire != null && i.days_to_expire >= 0);
      if (win !== 'all') {
        const max = parseInt(win, 10);
        r = r.filter(i => i.days_to_expire! <= max);
      }
    }
    return r;
  }, [items, win, dist, firstNextMonth]);
  const next3 = active.filter(i => i.days_to_expire! <= 3).length;
  const next7 = active.filter(i => i.days_to_expire! <= 7).length;
  const dayBadge = (d: number | null) => {
    if (d == null) return <span className="text-muted">-</span>;
    if (d < 0) return <span className="text-muted">ended</span>;
    const tone = d <= 3 ? 'var(--red)' : d <= 7 ? 'var(--yellow)' : 'var(--green)';
    return <span style={{ color: tone, fontWeight: 700 }}>{d === 0 ? 'Today' : d === 1 ? '1 day' : `${d} days`}</span>;
  };
  return (
    <DashboardTile
      title="Time-Sensitive Deals"
      to="/time-sensitive"
      accent="#dc2626"
      count={active.length}
      countLabel="active deals"
      subtitle={`${next3} expire in 3 days · ${next7} this week`}
      preview={active.slice(0, 3).map((r, i) => (
        <div key={i} className="dashboard-tile-preview-row">
          <span className="dashboard-tile-preview-name">{r.product_name}</span>
          <span className="dashboard-tile-preview-value" style={{ color: (r.days_to_expire ?? 99) <= 3 ? 'var(--red)' : 'var(--yellow)' }}>
            {r.days_to_expire != null ? `${r.days_to_expire}d` : '-'}
          </span>
        </div>
      ))}
      modalContent={() => (
        <>
          <div className="tile-filter-bar">
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              {([['all', 'All'], ['3', 'Next 3 days'], ['7', 'This week'], ['14', 'Next 2 weeks'], ['next', 'Next month'], ['past', 'Past deals']] as const).map(([v, l]) => (
                <button key={v} type="button" className={`filter-pill ${win === v ? 'active' : ''}`} onClick={() => setWin(v)}>{l}</button>
              ))}
              <select value={dist} onChange={e => setDist(e.target.value)}
                style={{ padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 6, fontSize: 13 }}>
                <option value="">All distributors</option>
                {distributors.map(d => <option key={d} value={d}>{distributorName(d)}</option>)}
              </select>
            </div>
            <span className="text-muted" style={{ fontSize: 12, marginLeft: 'auto' }}>{filtered.length} deals</span>
          </div>
          <div className="dense-table">
          <SortableTable
            columns={[
              { key: 'product_name', label: 'Product', sortable: true,
                render: r => <span>{r.product_name as string}{tsdSticker(r as TimeSensitiveDeal)}</span> },
              { key: 'wholesaler', label: 'Distributor', render: r => distributorName(r.wholesaler as string) },
              { key: 'deal_kind', label: 'Type' },
              { key: 'product_type', label: 'Category' },
              { key: 'from_date', label: 'Starts', sortable: true, render: r => fmtDate(r.from_date as string) },
              { key: 'to_date', label: 'Ends', sortable: true, render: r => fmtDate(r.to_date as string) },
              { key: 'days_to_expire', label: 'Days', align: 'right', sortable: true, render: r => dayBadge(r.days_to_expire as number | null) },
              { key: 'frontline_case_price', label: 'Orig/cs', align: 'right', sortable: true,
                render: r => fmt$(r.frontline_case_price as number | null) },
              { key: 'total_savings_per_case', label: 'Disc/cs', align: 'right', sortable: true,
                exportValue: r => (r.total_savings_per_case as number | null) ?? '',
                render: r => r.total_savings_per_case != null ? <span className="text-green">{fmt$(r.total_savings_per_case as number)}</span> : '-' },
              { key: 'effective_case_price', label: 'Net/cs', align: 'right', sortable: true,
                exportValue: r => tsdNetCase(r as TimeSensitiveDeal) ?? '',
                render: r => fmt$(tsdNetCase(r as TimeSensitiveDeal)) },
              { key: 'net_btl', label: 'Net/btl', align: 'right', sortable: true,
                sortValue: r => tsdNetBtl(r as TimeSensitiveDeal) ?? -1,
                exportValue: r => tsdNetBtl(r as TimeSensitiveDeal) ?? '',
                render: r => fmt$(tsdNetBtl(r as TimeSensitiveDeal)) },
              { key: 'gp', label: 'GP%', align: 'right', sortable: true,
                sortValue: r => tsdGp(r as TimeSensitiveDeal) ?? -999,
                exportValue: r => { const g = tsdGp(r as TimeSensitiveDeal); return g == null ? '' : Number(g.toFixed(1)); },
                render: r => { const g = tsdGp(r as TimeSensitiveDeal); return g == null ? <span className="text-muted">-</span> : <span style={{ fontWeight: 700, color: 'var(--green)' }}>{g.toFixed(1)}%</span>; } },
            ]}
            data={filtered}
            pageSize={50}
            exportName="time-sensitive-deals"
            onRowClick={r => open(r.product_name as string, r.wholesaler as string, undefined, { upc: r.upc as string ?? undefined, unitVolume: r.unit_volume as string ?? undefined })}
          />
          </div>
        </>
      )}
    />
  );
}

function PriceDropsTile({ data, open }: { data: any[] | undefined; open: (n: string, w: string, c?: any, opts?: { upc?: string; unitVolume?: string }) => void }) {
  const [limit, setLimit] = useState(50);
  const items = data ?? [];
  const productTypes = useMemo(() => [...new Set(items.map(d => d.product_type).filter(Boolean))].sort(), [items]);
  const { filtered, state, set } = useTableFilters(items, {
    nameKeys: ['product_name'], upcKeys: ['upc'], productTypeKey: 'product_type', priceKey: 'case_price',
  });
  return (
    <DashboardTile
      title="Biggest Price Drops"
      to="/price-drops"
      accent="#22c55e"
      count={(data ?? []).length}
      countLabel="products"
      subtitle="Edition-over-edition reductions"
      preview={(data ?? []).slice(0, 3).map((r, i) => (
        <div key={i} className="dashboard-tile-preview-row">
          <span className="dashboard-tile-preview-name">{r.product_name}</span>
          <span className="dashboard-tile-preview-value text-green">{r.case_delta_pct}%</span>
        </div>
      ))}
      modalContent={() => (
        <>
          <TileFilterBar
            state={state} set={set} productTypes={productTypes} showPrice
            rightSlot={<>
              <RowLimitSelect value={limit} onChange={setLimit} />
              <span className="text-muted" style={{ fontSize: 12 }}>{filtered.length} results</span>
            </>}
          />
          <SortableTable
            columns={[
              { key: 'product_name', label: 'Product', sortable: true },
              { key: 'wholesaler', label: 'Distributor', render: r => distributorName(r.wholesaler as string) },
              { key: 'product_type', label: 'Type' },
              { key: 'unit_volume', label: 'Size' },
              { key: 'case_price', label: 'Price', align: 'right',
                render: r => fmt$(r.case_price as number) },
              { key: 'case_delta_pct', label: 'Δ %', align: 'right', sortable: true,
                render: r => <span className="text-green">{r.case_delta_pct}%</span> },
            ]}
            data={filtered}
            pageSize={limit}
            exportName="price-drops"
            onRowClick={r => open(r.product_name as string, r.wholesaler as string, undefined, { upc: r.upc as string, unitVolume: r.unit_volume as string })}
          />
        </>
      )}
    />
  );
}

function TopDealsTile({ data, open }: { data: any[] | undefined; open: (n: string, w: string, c?: any, opts?: { upc?: string; unitVolume?: string }) => void }) {
  const [limit, setLimit] = useState(50);
  const items = data ?? [];
  const productTypes = useMemo(() => [...new Set(items.map(d => d.product_type).filter(Boolean))].sort(), [items]);
  const distributors = useMemo(() => [...new Set(items.map(d => d.wholesaler).filter(Boolean))].sort(), [items]);
  const { filtered, state, set } = useTableFilters(items, {
    nameKeys: ['product_name'], upcKeys: ['upc'], productTypeKey: 'product_type',
    distributorKey: 'wholesaler',
    priceKey: 'frontline_case_price', discountKey: 'has_discount', ripKey: 'has_rip',
  });
  return (
    <DashboardTile
      title="Top Discount Opportunities"
      to="/major-discounts"
      accent="#10b981"
      count={(data ?? []).length}
      countLabel="products"
      subtitle="Largest savings per case"
      preview={(data ?? []).slice(0, 3).map((r, i) => (
        <div key={i} className="dashboard-tile-preview-row">
          <span className="dashboard-tile-preview-name">{r.product_name}</span>
          <span className="dashboard-tile-preview-value text-green">${r.total_savings_per_case}</span>
        </div>
      ))}
      modalContent={() => (
        <>
          <TileFilterBar
            state={state} set={set} productTypes={productTypes} distributors={distributors} showPrice
            showDeals={{ discount: true, rip: true }}
            rightSlot={<>
              <RowLimitSelect value={limit} onChange={setLimit} />
              <span className="text-muted" style={{ fontSize: 12 }}>{filtered.length} results</span>
            </>}
          />
          <SortableTable
            columns={[
              { key: 'product_name', label: 'Product', sortable: true },
              { key: 'wholesaler', label: 'Distributor', render: r => distributorName(r.wholesaler as string) },
              { key: 'product_type', label: 'Type' },
              { key: 'unit_volume', label: 'Size' },
              { key: 'discount_source', label: 'Why', exportValue: r => (r.discount_source as string[] | undefined)?.join(' + ') ?? '',
                render: r => {
                  const srcs = (r.discount_source as string[] | undefined) ?? [];
                  if (srcs.length === 0) return <span className="text-muted">—</span>;
                  return <span style={{ display: 'inline-flex', gap: 3, flexWrap: 'wrap' }}>
                    {srcs.map(s => <span key={s} className={`source-badge source-${s.includes('RIP') ? 'rip' : s.includes('Close') ? 'closeout' : 'discount'}`}>{s}</span>)}
                  </span>;
                }},
              { key: 'frontline_case_price', label: 'List', align: 'right', sortable: true,
                render: r => {
                  const uq = Number(r.unit_qty);
                  return <div style={{ lineHeight: 1.2 }}>
                    <div>${Number(r.frontline_case_price).toFixed(2)}/cs</div>
                    {uq > 1 && <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>${(Number(r.frontline_case_price) / uq).toFixed(2)}/btl</div>}
                  </div>;
                }},
              { key: 'effective_case_price', label: 'You pay', align: 'right', sortable: true,
                render: r => {
                  const uq = Number(r.unit_qty);
                  return <div style={{ lineHeight: 1.2, fontWeight: 600 }}>
                    <div className="text-green">${Number(r.effective_case_price).toFixed(2)}/cs</div>
                    {uq > 1 && <div style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 400 }}>${(Number(r.effective_case_price) / uq).toFixed(2)}/btl</div>}
                  </div>;
                }},
              { key: 'total_savings_per_case', label: 'Save/Case', align: 'right', sortable: true,
                render: r => <span className="text-green">${r.total_savings_per_case} ({r.discount_pct}%)</span> },
              { key: 'better_month', label: 'Cheaper', align: 'center', sortable: true,
                render: r => {
                  const bm = r.better_month as string | undefined;
                  if (!bm) return <span className="text-muted">—</span>;
                  const variant = bm === 'Next month' ? 'next' : bm === 'This month' ? 'this' : 'same';
                  const ne = r.next_effective_case_price as number | null;
                  const title = ne != null ? `Next month effective: $${ne.toFixed(2)}/cs` : 'No next-month data';
                  return <span className="better-price-badge" data-variant={variant} title={title}>{bm === 'This month' ? 'Now' : bm === 'Next month' ? 'Next mo' : 'Same'}</span>;
                }},
            ]}
            data={filtered}
            pageSize={limit}
            exportName="top-deals"
            onRowClick={r => open(r.product_name as string, r.wholesaler as string, undefined, {
              upc: r.upc as string, unitVolume: r.unit_volume as string,
              unitQty: (r.unit_qty as string) || undefined,
            })}
          />
        </>
      )}
    />
  );
}

function PriceChangesTile({ data, open }: { data: any; open: (n: string, w: string, c?: any, opts?: { upc?: string; unitVolume?: string }) => void }) {
  const [direction, setDirection] = useState<'any' | 'down' | 'up'>('any');
  const [limit, setLimit] = useState(50);
  const items = (data?.items ?? []) as any[];
  const tileCount = (data?.total ?? items.length) as number;
  // The two months actually compared (earlier -> later), for column + subtitle labels.
  const fromLabel = data?.current_ym ? monthLabel(data.current_ym) : 'Earlier';
  const toLabel = data?.next_ym ? monthLabel(data.next_ym) : 'Latest';
  const productTypes = useMemo(() => [...new Set(items.map(d => d.product_type).filter(Boolean))].sort(), [items]);
  const dirFiltered = useMemo(() => {
    let r = items;
    if (direction === 'down') r = r.filter(i => i.delta_pct < 0);
    if (direction === 'up') r = r.filter(i => i.delta_pct > 0);
    return r;
  }, [items, direction]);
  const { filtered, state, set } = useTableFilters(dirFiltered, {
    nameKeys: ['product_name'], upcKeys: ['upc'], productTypeKey: 'product_type',
    priceKey: 'curr_case_price', discountKey: 'curr_has_discount', ripKey: 'curr_has_rip',
  });
  return (
    <DashboardTile
      title="Price Changes (Month over Month)"
      accent="#f97316"
      count={tileCount.toLocaleString()}
      countLabel="products"
      subtitle={data ? `Comparing ${fromLabel} → ${toLabel} (last 2 editions loaded)` : ''}
      preview={items.slice(0, 3).map((r, i) => (
        <div key={i} className="dashboard-tile-preview-row">
          <span className="dashboard-tile-preview-name">{r.product_name}</span>
          <span className="dashboard-tile-preview-value" style={{ color: r.delta_pct < 0 ? 'var(--green)' : 'var(--yellow)' }}>
            {r.delta_pct > 0 ? '+' : ''}{r.delta_pct?.toFixed(1)}%
          </span>
        </div>
      ))}
      modalContent={() => (
        <>
          <TileFilterBar
            state={state} set={set} productTypes={productTypes} showPrice
            showDeals={{ discount: true, rip: true }}
            rightSlot={<>
              {(['any', 'down', 'up'] as const).map(d => (
                <button key={d}
                  className={`filter-pill ${direction === d ? 'active' : ''}`}
                  onClick={() => setDirection(d)} type="button">
                  {d === 'any' ? 'All' : d === 'down' ? 'Drops' : 'Hikes'}
                </button>
              ))}
              <RowLimitSelect value={limit} onChange={setLimit} />
              <span className="text-muted" style={{ fontSize: 12 }}>{filtered.length} results</span>
            </>}
          />
          <SortableTable
            columns={[
              { key: 'product_name', label: 'Product', sortable: true,
                render: r => <span>{r.product_name as string}</span> },
              { key: 'wholesaler', label: 'Distributor', render: r => distributorName(r.wholesaler as string) },
              { key: 'unit_volume', label: 'Size' },
              { key: 'vintage', label: 'Vintage', align: 'center', sortable: true,
                // Wine/sparkling/vermouth only; each vintage is its own row.
                exportValue: r => (r.vintage as string) ?? '',
                render: r => r.vintage
                  ? <span className="tag tag-blue">{r.vintage as string}</span>
                  : <span className="text-muted">—</span> },
              { key: 'curr_case_price', label: fromLabel, align: 'right', sortable: true,
                render: r => fmt$(r.curr_case_price as number) },
              { key: 'next_case_price', label: toLabel, align: 'right', sortable: true,
                render: r => fmt$(r.next_case_price as number) },
              { key: 'delta_pct', label: 'Δ %', align: 'right', sortable: true,
                render: r => {
                  const d = r.delta_pct as number;
                  const cls = d < 0 ? 'text-green' : d > 0 ? 'text-yellow' : '';
                  return <span className={cls}>{d > 0 ? '+' : ''}{d.toFixed(1)}%</span>;
                }},
              { key: 'curr_rip_savings', label: `${fromLabel} RIP`, align: 'right',
                render: r => (r.curr_rip_savings as number) > 0 ? <span className="source-badge source-rip">${(r.curr_rip_savings as number).toFixed(2)}/cs</span> : '—' },
              { key: 'next_rip_savings', label: `${toLabel} RIP`, align: 'right',
                render: r => (r.next_rip_savings as number) > 0 ? <span className="source-badge source-rip">${(r.next_rip_savings as number).toFixed(2)}/cs</span> : '—' },
            ]}
            data={filtered}
            pageSize={limit}
            exportName="price-changes-mom"
            onRowClick={r => open(r.product_name as string, r.wholesaler as string, undefined, {
              upc: r.upc as string, unitVolume: r.unit_volume as string,
              unitQty: (r.unit_qty as string) || undefined, vintage: (r.vintage as string) || undefined,
              months: { curr: r.curr_edition as string, next: r.next_edition as string },
            })}
          />
        </>
      )}
    />
  );
}

function CrossDistTile({ data, label, accent, open }: {
  data: any; label: string; accent: string;
  open: (n: string, w: string, c?: any, opts?: any) => void;
}) {
  const [limit, setLimit] = useState(50);
  const items = (data?.items ?? []) as any[];
  const tileCount = (data?.total ?? items.length) as number;
  const productTypes = useMemo(() => [...new Set(items.map(d => d.product_type).filter(Boolean))].sort(), [items]);
  const { filtered, state, set } = useTableFilters(items, {
    nameKeys: ['product_name', 'b_product_name'], upcKeys: ['upc_norm', 'a_upc', 'b_upc'],
    productTypeKey: 'product_type', priceKey: 'a_effective',
  });
  const combined = !!data?.combined;
  const comps = (data?.competitors as string[] | undefined) ?? [];
  const aName = distributorName(data?.distributor_a ?? 'allied');
  const bName = combined
    ? `Cheapest of ${comps.map(distributorName).join(' / ')}`
    : distributorName(data?.distributor_b ?? 'fedway');
  const titleVs = combined ? comps.map(distributorName).join(' + ') : bName;
  return (
    <DashboardTile
      title={`${aName} vs ${titleVs} — ${label}`}
      accent={accent}
      count={tileCount.toLocaleString()}
      countLabel="products"
      subtitle="Same UPC, cheaper distributor"
      preview={items.slice(0, 3).map((r, i) => (
        <div key={i} className="dashboard-tile-preview-row">
          <span className="dashboard-tile-preview-name">{r.product_name}</span>
          <span className="dashboard-tile-preview-value text-green">${r.savings?.toFixed(0)}</span>
        </div>
      ))}
      modalContent={() => (
        <>
          <TileFilterBar
            state={state} set={set} productTypes={productTypes} showPrice
            rightSlot={<>
              <RowLimitSelect value={limit} onChange={setLimit} />
              <span className="text-muted" style={{ fontSize: 12 }}>{filtered.length} results</span>
            </>}
          />
          <SortableTable
            columns={[
              { key: 'product_name', label: `Product (${aName})`, sortable: true,
                render: r => (
                  <div>
                    <div style={{ fontWeight: 600 }}>{r.product_name}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                      {r.upc_norm} · {r.unit_qty ? `${r.unit_qty} × ` : ''}{r.unit_volume} · {r.product_type}
                    </div>
                  </div>
                )},
              { key: 'b_product_name', label: combined ? 'Cheapest rival' : `Product (${bName})`,
                render: r => (
                  <span style={{ fontSize: 12 }}>
                    {combined && r.b_wholesaler && <span className="cell-distributor-badge" style={{ marginRight: 6 }}>{distributorName(r.b_wholesaler as string)}</span>}
                    {r.b_product_name}
                  </span>
                ) },
              { key: 'a_vintage', label: 'Vintage', align: 'center', sortable: true,
                // Wine/sparkling/vermouth: each vintage is its own product. Show
                // it where applicable (either side carries it); blank for spirits.
                // The build never pairs two different non-null vintages, so the
                // value is unambiguous.
                exportValue: r => (r.a_vintage || r.b_vintage || ''),
                render: r => {
                  const v = r.a_vintage || r.b_vintage;
                  return v ? <span className="tag tag-blue">{v}</span> : <span className="text-muted">—</span>;
                }},
              { key: 'a_effective', label: aName, align: 'right', sortable: true,
                render: r => (
                  <div style={{ lineHeight: 1.2 }}>
                    <div>${(r.a_effective as number).toFixed(2)}/cs</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>${(r.a_effective_per_bottle as number).toFixed(2)}/btl</div>
                  </div>
                )},
              { key: 'b_effective', label: combined ? 'Best rival' : bName, align: 'right', sortable: true,
                render: r => (
                  <div style={{ lineHeight: 1.2 }}>
                    <div>${(r.b_effective as number).toFixed(2)}/cs</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>${(r.b_effective_per_bottle as number).toFixed(2)}/btl</div>
                  </div>
                )},
              { key: 'savings', label: 'Δ $', align: 'right', sortable: true,
                render: r => <span className="text-green">${(r.savings as number).toFixed(2)}</span> },
              { key: 'savings_pct', label: 'Δ %', align: 'right', sortable: true,
                render: r => <span className="text-green">{(r.savings_pct as number).toFixed(1)}%</span> },
              { key: 'cheaper', label: 'Cheaper',
                render: r => <span className="tag tag-green">{r.cheaper}</span> },
            ]}
            data={filtered}
            pageSize={limit}
            exportName="cross-distributor"
            onRowClick={r => open(
              r.product_name as string,
              data?.distributor_a ?? 'allied',
              {
                productName: r.b_product_name as string,
                wholesaler: (r.b_wholesaler as string) ?? data?.distributor_b ?? 'fedway',
                upc: r.b_upc as string,
                unitVolume: r.unit_volume as string,
              },
              { upc: r.a_upc as string, unitVolume: r.unit_volume as string },
            )}
          />
        </>
      )}
    />
  );
}

function QATile({ data }: { data: any }) {
  const [activeCheck, setActiveCheck] = useState('');
  const totals = (data?.totals ?? {}) as Record<string, number>;
  const totalFlagged = Object.values(totals).reduce((s, n) => s + n, 0);
  const checks = (data?.checks ?? {}) as Record<string, { rows: any[] }>;
  return (
    <DashboardTile
      title="QA: Data Quality Anomalies"
      accent="#ef4444"
      count={totalFlagged}
      countLabel="flagged"
      subtitle={data?.edition_checked ? `edition ${monthLabel(data.edition_checked)}` : ''}
      preview={Object.entries(totals).slice(0, 3).map(([k, n]) => (
        <div key={k} className="dashboard-tile-preview-row">
          <span className="dashboard-tile-preview-name">{k.replace(/_/g, ' ')}</span>
          <span className="dashboard-tile-preview-value">{n}</span>
        </div>
      ))}
      modalContent={() => {
        const active = checks[activeCheck];
        return (
          <>
            <div className="tile-filter-bar">
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {Object.entries(totals).map(([k, n]) => (
                  <button key={k} type="button"
                    className={`filter-pill ${activeCheck === k ? 'active' : ''}`}
                    onClick={() => setActiveCheck(activeCheck === k ? '' : k)}>
                    {k.replace(/_/g, ' ')}
                    <span className="filter-pill-count">{n}</span>
                  </button>
                ))}
              </div>
            </div>
            {active && active.rows.length > 0 ? (
              <div style={{ overflowX: 'auto', maxHeight: 500 }}>
                <table className="breakdown-table" style={{ fontSize: 11 }}>
                  <thead>
                    <tr>{Object.keys(active.rows[0]).map(c => <th key={c}>{c}</th>)}</tr>
                  </thead>
                  <tbody>
                    {active.rows.map((r, idx) => (
                      <tr key={idx}>
                        {Object.values(r).map((v, i) => <td key={i}>{v == null ? '—' : String(v)}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-muted" style={{ fontSize: 12 }}>
                {activeCheck ? 'No rows for this check.' : 'Click a chip above to inspect that check.'}
              </p>
            )}
          </>
        );
      }}
    />
  );
}

// Newly introduced products (UPC-based; an item not present in the prior
// edition). Count + a preview; the full detail is the New Items page, which is
// the Catalog with an Introduced column and a month filter.
function NewItemsTile({ data, open }: {
  data: NewItemsResponse | undefined;
  open: (n: string, w: string, c?: any, opts?: { upc?: string; unitVolume?: string }) => void;
}) {
  const items = data?.items ?? [];
  const total = data?.total ?? items.length;
  const monthsLabel = (data?.months ?? [])
    .map(m => `${monthLabel(m.edition)} (${m.count})`)
    .join(' · ');
  return (
    <DashboardTile
      title="New Items"
      accent="#0ea5e9"
      count={total.toLocaleString()}
      countLabel="new products"
      subtitle={monthsLabel || 'Introduced in recent editions'}
      preview={items.slice(0, 3).map((r, i) => (
        <div key={i} className="dashboard-tile-preview-row">
          <span className="dashboard-tile-preview-name">{r.product_name}</span>
          <span className="dashboard-tile-preview-value">{monthLabel(r.introduced_edition ?? '')}</span>
        </div>
      ))}
      modalContent={(close) => (
        <>
          <SortableTable
            columns={[
              { key: 'product_name', label: 'Product', sortable: true,
                render: r => <span style={{ fontWeight: 600 }}>{r.product_name as string}</span> },
              { key: 'wholesaler', label: 'Distributor', sortable: true,
                render: r => distributorName(r.wholesaler as string) },
              { key: 'product_type', label: 'Type' },
              { key: 'unit_volume', label: 'Size' },
              { key: 'introduced_edition', label: 'Introduced', sortable: true,
                render: r => <span className="tag tag-blue">{monthLabel(r.introduced_edition as string ?? '')}</span> },
              { key: 'frontline_case_price', label: 'Case', align: 'right', sortable: true,
                render: r => fmt$(r.frontline_case_price as number) },
              { key: 'effective_case_price', label: 'Effective', align: 'right', sortable: true,
                render: r => fmt$(r.effective_case_price as number) },
            ]}
            data={items}
            pageSize={50}
            exportName="new-items"
            onRowClick={r => open(r.product_name as string, r.wholesaler as string, undefined,
              { upc: r.upc as string, unitVolume: r.unit_volume as string })}
          />
          <ViewAllLink to="/new-items" label="Open New Items" close={close} />
        </>
      )}
    />
  );
}

// ---------- My Workspace tiles ----------

// Footer link inside a tile modal: closes the popup, then jumps to the
// associated full screen (reused with the filter for this user).
function ViewAllLink({ to, label, close }: { to: string; label: string; close: () => void }) {
  const navigate = useNavigate();
  return (
    <div style={{ marginTop: 14, textAlign: 'right' }}>
      <button className="btn btn-secondary btn-sm" onClick={() => { close(); navigate(to); }}>
        {label} <ArrowRight size={14} />
      </button>
    </div>
  );
}

function FavoritesTile({ data, open }: { data: WatchlistItem[] | undefined; open: (n: string, w: string) => void }) {
  const items = data ?? [];
  return (
    <DashboardTile
      title="My Favorites"
      accent="#f59e0b"
      count={items.length}
      countLabel="saved"
      subtitle="Products on your watchlist"
      preview={items.slice(0, 3).map((r, i) => (
        <div key={i} className="dashboard-tile-preview-row">
          <span className="dashboard-tile-preview-name">{r.product_name}</span>
          <span className="dashboard-tile-preview-value">{distributorName(r.wholesaler)}</span>
        </div>
      ))}
      modalContent={(close) => (
        <>
          <SortableTable
            columns={[
              { key: 'product_name', label: 'Product', sortable: true,
                render: r => <span style={{ fontWeight: 600 }}>{r.product_name}</span> },
              { key: 'wholesaler', label: 'Distributor', sortable: true,
                render: r => distributorName(r.wholesaler) },
              { key: 'unit_volume', label: 'Size' },
              { key: 'target_price', label: 'Target', align: 'right',
                render: r => fmt$(r.target_price) },
              { key: 'notes', label: 'Note',
                render: r => r.notes || <span className="text-muted">—</span> },
            ]}
            data={items}
            pageSize={50}
            exportName="my-favorites"
            onRowClick={r => open(r.product_name, r.wholesaler)}
          />
          <ViewAllLink to="/watchlist" label="Open Favorites" close={close} />
        </>
      )}
    />
  );
}

function OrdersTile({ data, label, accent, subtitle, status }: {
  data: Order[] | undefined; label: string; accent: string; subtitle: string; status: string;
}) {
  const navigate = useNavigate();
  const items = data ?? [];
  return (
    <DashboardTile
      title={label}
      accent={accent}
      count={items.length}
      countLabel="orders"
      subtitle={subtitle}
      preview={items.slice(0, 3).map((r, i) => (
        <div key={i} className="dashboard-tile-preview-row">
          <span className="dashboard-tile-preview-name">{r.name}</span>
          <span className="dashboard-tile-preview-value">{new Date(r.created_at).toLocaleDateString()}</span>
        </div>
      ))}
      modalContent={(close) => (
        <>
          <SortableTable
            columns={[
              { key: 'id', label: 'ID', sortable: true },
              { key: 'name', label: 'Name', sortable: true },
              { key: 'division', label: 'Division' },
              { key: 'created_at', label: 'Created', sortable: true,
                render: r => new Date(r.created_at).toLocaleDateString() },
              { key: 'updated_at', label: 'Updated', sortable: true,
                render: r => r.updated_at ? new Date(r.updated_at).toLocaleDateString() : '—' },
            ]}
            data={items}
            pageSize={50}
            exportName={`orders-${status}`}
            onRowClick={r => { close(); navigate(`/orders/${r.id}`); }}
          />
          <ViewAllLink to={`/orders?status=${status}`} label="Open in Orders" close={close} />
        </>
      )}
    />
  );
}

function NotesTile({ data, open }: { data: AllNote[] | undefined; open: (n: string, w: string) => void }) {
  const items = data ?? [];
  return (
    <DashboardTile
      title="My Notes"
      accent="#8b5cf6"
      count={items.length}
      countLabel="notes"
      subtitle="Across products, favorites, and orders"
      preview={items.slice(0, 3).map((r, i) => (
        <div key={i} className="dashboard-tile-preview-row">
          <span className="dashboard-tile-preview-name">{r.title}</span>
          <span className="dashboard-tile-preview-value text-muted" style={{ fontWeight: 400 }}>
            {r.note.length > 24 ? `${r.note.slice(0, 24)}…` : r.note}
          </span>
        </div>
      ))}
      modalContent={(close) => (
        <>
          <SortableTable
            columns={[
              { key: 'title', label: 'Item', sortable: true,
                render: r => <span style={{ fontWeight: 600 }}>{r.title}</span> },
              { key: 'source', label: 'Where', sortable: true,
                render: r => (r.source as string).replace('_', ' ') },
              { key: 'note', label: 'Note', render: r => r.note },
              { key: 'created_at', label: 'Added', sortable: true,
                render: r => new Date(r.created_at).toLocaleDateString() },
            ]}
            data={items}
            pageSize={50}
            exportName="my-notes"
            onRowClick={r => { if (r.product_name && r.wholesaler) open(r.product_name, r.wholesaler); }}
          />
          <ViewAllLink to="/notes" label="Open Notes" close={close} />
        </>
      )}
    />
  );
}
