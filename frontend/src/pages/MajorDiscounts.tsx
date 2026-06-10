import { useEffect, useMemo, useState } from 'react';
import { useSearchParams, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useResultCount } from '../lib/resultCount';
import { Percent } from 'lucide-react';
import { deals, watchlist, type Product } from '../lib/api';
import { ContextMenuProvider, RowMenuButton } from '../components/ContextMenu';
import FavoriteButton from '../components/FavoriteButton';
import AddToCartButton from '../components/AddToCartButton';
import AddToListButton from '../components/AddToListButton';
import ProductThumb from '../components/ProductThumb';
import FilterSidebar, { type FilterSection } from '../components/FilterSidebar';
import PromotionsToolbar from '../components/PromotionsToolbar';
import PromotionsPager from '../components/PromotionsPager';
import PromotionsTable, { type PromotionRow } from '../components/PromotionsTable';
import MonthEffectiveSparkline from '../components/MonthEffectiveSparkline';
import { buildSparkProps } from '../lib/promotionsSparkline';
import { AI_EXPLAINERS_ENABLED } from '../lib/flags';
import VintageSticker from '../components/VintageSticker';
import { useProductQuickView } from '../components/ProductQuickView';
import { distributorName, ALL_DISTRIBUTORS, priceUnit, perUnitAbbr } from '../lib/distributors';
import { useAuth } from '../contexts/AuthContext';

const money = (v?: number | null) => (v == null ? '-' : `$${Number(v).toFixed(2)}`);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtEdition(ed?: string | null): string {
  if (!ed) return '-';
  const m = /^(\d{4})-(\d{1,2})/.exec(ed);
  return m ? `${MONTHS[parseInt(m[2], 10) - 1]} ${m[1]}` : ed;
}

// Admin-only: the same discount data is available to regular users via the
// Catalog "In QD" filter and the per-product detail page. This dense ranker is
// kept as an internal admin tool. The exported component gates on is_admin so
// the implementation's hooks never run when the gate denies access.
export default function MajorDiscounts() {
  const { user } = useAuth();
  if (!user?.is_admin) {
    return (
      <div className="page">
        <div className="orders-header"><h2>Major Discounts</h2></div>
        <p className="text-muted" style={{ marginTop: 8 }}>
          This page is admin-only. The same quantity-discount information is on the{' '}
          <a href="/products" style={{ color: 'var(--accent)' }}>Products</a> page — filter by
          {' '}<strong>In QD</strong> to see every product with a quantity discount this edition.
        </p>
      </div>
    );
  }
  return <MajorDiscountsImpl />;
}

function MajorDiscountsImpl() {
  const { open } = useProductQuickView();
  const [params] = useSearchParams();
  const [wholesaler, setWholesaler] = useState('');
  const [q, setQ] = useState(params.get('q') ?? '');
  // The assistant can filter this page in place by pushing ?q=<term|upc>.
  useEffect(() => { const u = params.get('q'); if (u !== null) setQ(u); }, [params]);
  const [productType, setProductType] = useState('');
  const [minSave, setMinSave] = useState('');
  const [minDiscount, setMinDiscount] = useState('');
  const [hasRip, setHasRip] = useState<'' | 'yes' | 'no'>('');
  const [hasCloseout, setHasCloseout] = useState<'' | 'yes' | 'no'>('');
  const [size, setSize] = useState('');
  const [trackedOnly, setTrackedOnly] = useState(false);
  const [sort, setSort] = useState<'biggest-save' | 'biggest-pct' | 'name'>('biggest-save');
  const [limit, setLimit] = useState(60);
  const [page, setPage] = useState(0);
  const [view, setView] = useState<'cards' | 'table'>(() => (localStorage.getItem('md-view') as 'cards' | 'table') || 'cards');
  useEffect(() => { localStorage.setItem('md-view', view); }, [view]);

  const { data, isLoading } = useQuery({
    queryKey: ['major-discounts', wholesaler, minDiscount, sort],
    queryFn: () => deals.discounts({
      wholesaler: wholesaler || undefined,
      min_discount_pct: minDiscount ? parseFloat(minDiscount) : undefined,
      sort: sort === 'biggest-pct' ? 'discount_pct' : 'total_savings_per_case',
      limit: 1000,
    }),
  });
  const { data: wl } = useQuery({ queryKey: ['watchlist'], queryFn: watchlist.get, enabled: trackedOnly });
  // Category facet from the actual discount list, not the global catalog
  // (see TimeSensitive.tsx / PriceMovers.tsx for the same reasoning).
  const cats = useMemo(() => {
    const counts = new Map<string, number>();
    for (const d of data ?? []) {
      const t = d.product_type;
      if (!t) continue;
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([product_type, count]) => ({ product_type, count }))
      .sort((a, b) => b.count - a.count);
  }, [data]);

  const items = useMemo(() => {
    let res: Product[] = data ?? [];
    if (q) {
      const ql = q.toLowerCase();
      { const qd = q.replace(/\D/g, '');
        res = res.filter(i =>
          i.product_name.toLowerCase().includes(ql) ||
          (i.brand ?? '').toLowerCase().includes(ql) ||
          (qd.length >= 6 && String(i.upc ?? '').replace(/^0+/, '').includes(qd.replace(/^0+/, '')))); }
    }
    if (productType) res = res.filter(i => i.product_type === productType);
    if (size) res = res.filter(i => (i.unit_volume ?? '').toLowerCase().includes(size.toLowerCase()));
    if (hasRip === 'yes') res = res.filter(i => i.has_rip);
    if (hasRip === 'no') res = res.filter(i => !i.has_rip);
    if (hasCloseout === 'yes') res = res.filter(i => i.has_closeout);
    if (hasCloseout === 'no') res = res.filter(i => !i.has_closeout);
    if (minSave) { const n = parseFloat(minSave); res = res.filter(i => (i.total_savings_per_case ?? 0) >= n); }
    if (trackedOnly && wl) {
      const tracked = new Set(wl.map(i => `${i.product_name}|${i.wholesaler}`));
      res = res.filter(i => tracked.has(`${i.product_name}|${i.wholesaler}`));
    }
    if (sort === 'name') res = [...res].sort((a, b) => a.product_name.localeCompare(b.product_name));
    return res;
  }, [data, q, productType, size, hasRip, hasCloseout, minSave, trackedOnly, wl, sort]);

  const shown = items.slice(page * limit, (page + 1) * limit);

  // Publish the matched-row count so the AI assistant echoes the exact number.
  const { report } = useResultCount();
  const { pathname } = useLocation();
  useEffect(() => {
    if (!isLoading) report(pathname, items.length);
  }, [isLoading, items.length, pathname, report]);

  const sections: FilterSection[] = [
    { type: 'text', key: 'q', title: 'Search', placeholder: 'Product or brand', value: q, onChange: setQ },
    { type: 'pills', key: 'wholesaler', title: 'Distributor', options: ALL_DISTRIBUTORS, value: wholesaler, onChange: setWholesaler },
    { type: 'select', key: 'product_type', title: 'Category', placeholder: 'All categories',
      options: (cats ?? []).map(c => ({ value: c.product_type, label: c.product_type, count: c.count })),
      value: productType, onChange: setProductType },
    { type: 'pills', key: 'min_save', title: 'Min saving / case', value: minSave, onChange: setMinSave,
      options: [
        { value: '', label: 'Any' }, { value: '5', label: '$5+' }, { value: '10', label: '$10+' },
        { value: '25', label: '$25+' }, { value: '50', label: '$50+' }, { value: '100', label: '$100+' },
      ] },
    { type: 'pills', key: 'min_pct', title: 'Min discount %', value: minDiscount, onChange: setMinDiscount,
      options: [
        { value: '', label: 'Any' }, { value: '5', label: '5%+' }, { value: '10', label: '10%+' },
        { value: '15', label: '15%+' }, { value: '25', label: '25%+' },
      ] },
    { type: 'pills', key: 'has_rip', title: 'Has RIP rebate', value: hasRip, onChange: v => setHasRip(v as '' | 'yes' | 'no'),
      options: [{ value: '', label: 'Any' }, { value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }] },
    { type: 'pills', key: 'has_closeout', title: 'Closeout', value: hasCloseout, onChange: v => setHasCloseout(v as '' | 'yes' | 'no'),
      options: [{ value: '', label: 'Any' }, { value: 'yes', label: 'Closeout' }, { value: 'no', label: 'No' }] },
    { type: 'text', key: 'size', title: 'Size', placeholder: 'e.g. 750ML, 1.75L', value: size, onChange: setSize },
    { type: 'toggle', key: 'tracked', title: 'Favorites', value: trackedOnly, onChange: setTrackedOnly, label: 'Only my favourites' },
  ];

  const sortOptions = [
    { value: 'biggest-save' as const, label: 'Biggest saving $' },
    { value: 'biggest-pct' as const,  label: 'Biggest % off' },
    { value: 'name' as const,         label: 'Name (A-Z)' },
  ];

  return (
    <div className="page">
      <div className="orders-header">
        <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Percent size={22} color="#2563eb" /> Major Discounts
        </h2>
        <span className="text-muted" style={{ fontSize: 13 }}>
          {isLoading ? 'Loading…' : `${items.length.toLocaleString()} product${items.length === 1 ? '' : 's'}`}
        </span>
      </div>
      <p className="text-muted" style={{ marginTop: 0, fontSize: 13 }}>
        Products with the biggest active discounts this edition. Largest savings per case at the top.
      </p>

      <div className="catalog-layout">
        <FilterSidebar storageKey="md-filters" sections={sections}
          onReset={() => { setQ(''); setWholesaler(''); setProductType(''); setMinSave(''); setMinDiscount(''); setHasRip(''); setHasCloseout(''); setSize(''); setTrackedOnly(false); setSort('biggest-save'); }} />

        <div className="catalog-results">
          <PromotionsToolbar
            sortValue={sort}
            onSortChange={setSort}
            sortOptions={sortOptions}
            limit={limit}
            onLimitChange={(n) => { setLimit(n); setPage(0); }}
            total={items.length}
            shownInCards={shown.length}
            view={view}
            onViewChange={setView}
            noun="discounts"
            page={page}
            onPageChange={setPage}
          />

          <ContextMenuProvider onView={open}>
            {view === 'cards' ? (
              <div className="deal-cards">
                {/* Key includes vintage / edition / row index so the multi-
                    vintage Remy Louis lines (1P / COF1P / GIFT1P all
                    landing as $32.99) don't collide on (wholesaler, UPC). */}
                {shown.map((d, i) => <DiscountCard key={`${d.wholesaler}|${d.upc ?? d.product_name}|${d.unit_volume ?? ''}|${d.edition ?? ''}|${i}`} d={d} open={open} />)}
                {!isLoading && shown.length === 0 && (
                  <div className="empty" style={{ padding: 30, textAlign: 'center' }}>No products match these filters.</div>
                )}
              </div>
            ) : (
              <PromotionsTable
                rows={items.map(productToPromotionRow)}
                exportName="major-discounts"
                onRowClick={r => open(r.product_name, r.wholesaler, undefined,
                  { upc: r.upc ?? undefined, unitVolume: r.unit_volume ?? undefined })}
              />
            )}
          </ContextMenuProvider>
          <PromotionsPager page={page} total={items.length} limit={limit} onPageChange={setPage} view={view} />
        </div>
      </div>
    </div>
  );
}

function DiscountCard({ d, open }: { d: Product; open: (n: string, w: string, c?: unknown, opts?: { upc?: string; unitVolume?: string }) => void }) {
  const list = d.frontline_case_price ?? null;
  const eff = d.effective_case_price ?? null;
  const save = d.total_savings_per_case ?? null;
  const pct = d.discount_pct ?? null;
  const uq = Number(d.unit_qty) || 0;
  const effBtl = eff != null && uq > 1 ? eff / uq : null;
  return (
    <div className="deal-card" role="button" tabIndex={0}
         data-ctx data-ctx-product={d.product_name} data-ctx-wholesaler={d.wholesaler}
         data-ctx-upc={d.upc ?? ''} data-ctx-volume={d.unit_volume ?? ''}
         onClick={(e) => {
           const t = e.target as HTMLElement;
           if (t.closest('button, a, input, label, .deal-card-actions, .add-to-list-menu, .row-menu-btn, .ctx-menu')) return;
           open(d.product_name, d.wholesaler, undefined, { upc: d.upc ?? undefined, unitVolume: d.unit_volume ?? undefined, unitQty: d.unit_qty ?? undefined, vintage: (d.vintage as string | null) ?? undefined });
         }}
         onKeyDown={(e) => {
           if (e.key === 'Enter' || e.key === ' ') {
             e.preventDefault();
             open(d.product_name, d.wholesaler, undefined, { upc: d.upc ?? undefined, unitVolume: d.unit_volume ?? undefined, unitQty: d.unit_qty ?? undefined, vintage: (d.vintage as string | null) ?? undefined });
           }
         }}>
      <div className="deal-card-head">
        <ProductThumb src={d.image_url ?? undefined} alt={d.product_name} size={70} />
        <div className="deal-card-id">
          <div className="deal-card-name" title={d.product_name}>{d.product_name}</div>
          <div className="deal-card-sub">
            {d.brand && <span>{d.brand}</span>}
            {d.unit_volume && <span>· {d.unit_volume}</span>}
            {d.vintage && !/^(0|0\.0+|na|n\/a|nv|none)$/i.test(String(d.vintage)) && (
              <span>· Vintage {String(d.vintage).replace(/\.0+$/, '')}</span>
            )}
            <span className="cell-distributor-badge">{distributorName(d.wholesaler)}</span>
            <VintageSticker vintages={d.vintages_available} currentVintage={d.vintage as string | null} />
          </div>
        </div>
        <div className="deal-card-pills">
          <span className="deal-urgency" style={{ background: '#dcfce7', color: '#15803d' }}>Discount</span>
          <span className="mover-month">Active {fmtEdition(d.edition)}</span>
        </div>
      </div>

      <div className="deal-card-price">
        {list != null && <span className="deal-was">{money(list)}</span>}
        <span className="deal-now">{money(eff ?? list)}<span className="deal-unit">/{priceUnit(d.unit_volume)}</span></span>
        {save != null && save > 0 && (
          <span className="deal-save">Save <strong>{money(save)}/{priceUnit(d.unit_volume)}</strong>{pct ? ` · ${pct.toFixed(0)}% off` : ''}</span>
        )}
      </div>
      {effBtl != null && (
        <div className="deal-btl-now">{money(effBtl)}<span className="deal-unit">/{perUnitAbbr(d.unit_volume, d.unit_type)}</span><span className="deal-btl-tag">effective</span></div>
      )}

      <div className="deal-card-meta">
        {d.has_rip && <span className="source-badge source-rip">RIP rebate stacks</span>}
        {d.has_closeout && <span className="tag tag-orange">Closeout</span>}
        {(d.discount_source && d.discount_source.length > 0) && (
          <span className="text-muted">· {d.discount_source.join(' + ')}</span>
        )}
      </div>

      <div className="deal-card-spark">
        {/* Same this-month vs next-month sparkline + popover as the
            Catalog row. tiers + next_tiers come from the backend's
            attach_promotion_tiers so the popover shows the full
            Frontline / Discount / RIP / Best breakdown for both
            months, not just headline prices. */}
        <MonthEffectiveSparkline {...buildSparkProps(d)} />
        <span className="text-muted" style={{ fontSize: 11 }}>Edition {fmtEdition(d.edition)}</span>
      </div>

      {AI_EXPLAINERS_ENABLED && d.ai_blurb && (
        <div className="deal-card-ai" title="AI explanation of this discount">
          <span className="deal-ai-mark">✨</span> {d.ai_blurb}
        </div>
      )}

      <div className="deal-card-actions">
        <FavoriteButton productName={d.product_name} wholesaler={d.wholesaler}
          upc={d.upc ?? undefined} unitVolume={d.unit_volume ?? undefined} />
        <AddToCartButton productName={d.product_name} wholesaler={d.wholesaler}
          upc={d.upc ?? undefined} unitVolume={d.unit_volume ?? undefined} qtyCases={1} qtyUnits={0} />
        <AddToListButton productName={d.product_name} wholesaler={d.wholesaler}
          upc={d.upc ?? undefined} unitVolume={d.unit_volume ?? undefined} />
        <RowMenuButton product={{ product_name: d.product_name, wholesaler: d.wholesaler, upc: d.upc ?? undefined, unit_volume: d.unit_volume ?? undefined }} />
      </div>
    </div>
  );
}

// ---- adapter: Product -> standard PromotionRow ----
// MajorDiscounts deals are tied to an edition (a calendar month). Starts is
// the first of that month, Ends is the last day, Days = days until end of
// edition month. Type defaults to "Discount" but rolls up "Closeout" or RIP if
// those flags are set, matching the Time-Sensitive page's deal_kind nuance.
function editionMonthStart(ed?: string | null): string | null {
  if (!ed) return null;
  const m = /^(\d{4})-(\d{1,2})/.exec(ed);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-01` : null;
}
function editionMonthEnd(ed?: string | null): string | null {
  if (!ed) return null;
  const m = /^(\d{4})-(\d{1,2})/.exec(ed);
  if (!m) return null;
  const y = parseInt(m[1], 10); const mo = parseInt(m[2], 10);
  const d = new Date(y, mo, 0);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function daysFromTodayTo(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso); if (isNaN(t)) return null;
  const now = new Date(); const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((t - today) / 86400000);
}

function productToPromotionRow(p: Product): PromotionRow {
  const from = editionMonthStart(p.edition);
  const to   = editionMonthEnd(p.edition);
  const days = daysFromTodayTo(to);
  const qty = Number(p.unit_qty) || 0;
  const net = p.effective_case_price ?? null;
  const netBtl = qty > 0 && net != null ? net / qty : null;
  const full = p.frontline_case_price ?? null;
  const gp = full != null && net != null && full > 0 ? ((full - net) / full) * 100 : null;
  const typeLabel = p.has_closeout ? 'Closeout' : (p.has_rip ? 'RIP rebate' : 'Discount');
  return {
    product_name: p.product_name,
    brand: p.brand ?? null,
    wholesaler: p.wholesaler,
    upc: p.upc ?? null,
    product_type: p.product_type ?? null,
    unit_volume: p.unit_volume ?? null,
    type_label: typeLabel,
    from_date: from,
    to_date: to,
    days_to_expire: days,
    orig_case_price: full,
    disc_per_case: p.total_savings_per_case ?? null,
    net_case_price: net,
    net_btl_price: netBtl,
    gp_pct: gp,
    off_pct: p.discount_pct ?? null,
    has_rip: p.has_rip ?? false,
    has_closeout: p.has_closeout ?? false,
    ai_blurb: p.ai_blurb ?? null,
    sticker: null,
  };
}
