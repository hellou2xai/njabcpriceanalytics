import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { catalog, deals, cart as cartApi, watchlist, lists as listsApi } from '../lib/api';
import { distributorName } from '../lib/distributors';
import WholesalerFilter from '../components/WholesalerFilter';
import RowLimitSelect from '../components/RowLimitSelect';
import { useProductQuickView } from '../components/ProductQuickView';
import CatalogTable, { loadCart, saveCart, type CartState } from '../components/CatalogTable';
import CatalogFilterPanel, {
  emptyCatalogFilters,
} from '../components/CatalogFilterPanel';
import type { CatalogFilters } from '../components/CatalogFilterPanel';
import AiAssistantPanel from '../components/AiAssistantPanel';
import type { Product, CatalogAiResponse, CatalogAiAction } from '../lib/api';

/**
 * Test For Font Catalog (admin-only sandbox).
 *
 * A 1:1 functional copy of the production Catalog page. The ONLY difference is
 * the outer `font-test-catalog` wrapper class, which a scoped stylesheet in
 * index.css uses to enlarge the catalog's small (11–13px) type to a more
 * readable size. The real Catalog page is deliberately left untouched — this
 * page exists so we can trial larger typography before rolling it out.
 */
export default function CatalogFontTest() {
  const [params] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const [wholesaler, setWholesaler] = useState(params.get('wholesaler') ?? '');
  const [sort, setSort] = useState<'product_name' | 'frontline_case_price' | 'effective_case_price'>('product_name');
  const [order, setOrder] = useState<'asc' | 'desc'>('asc');
  const [page, setPage] = useState(0);
  const [limit, setLimit] = useState(50);
  const [trackedOnly, setTrackedOnly] = useState(false);
  const [filters, setFilters] = useState<CatalogFilters>(() => {
    const next: CatalogFilters = { ...emptyCatalogFilters };
    if (params.get('hasRip') === '1') next.hasRip = true;
    if (params.get('hasDiscount') === '1') next.hasDiscount = true;
    return next;
  });
  const [cart, setCartState] = useState<CartState>(loadCart);
  const { open } = useProductQuickView();
  // Separate localStorage key so toggling filters here doesn't fight the real
  // Catalog page's stored preference.
  const [showFilters, setShowFilters] = useState(() => {
    const stored = localStorage.getItem('lpb_catalog_font_filters_open');
    if (stored !== null) return stored !== 'false';
    return typeof window === 'undefined' || window.innerWidth > 1023;
  });
  const toggleFilters = () => setShowFilters(s => { localStorage.setItem('lpb_catalog_font_filters_open', String(!s)); return !s; });
  const [showPro, setShowPro] = useState<boolean>(() => {
    const stored = localStorage.getItem('lpb_catalog_show_pro');
    return stored === null ? true : stored !== 'false';
  });
  const onShowProChange = (v: boolean) => {
    setShowPro(v);
    localStorage.setItem('lpb_catalog_show_pro', String(v));
  };

  const setCart = useCallback((update: CartState | ((p: CartState) => CartState)) => {
    setCartState(prev => {
      const next = typeof update === 'function' ? update(prev) : update;
      saveCart(next);
      return next;
    });
  }, []);

  const updateQty = useCallback((key: string, field: 'cases' | 'units', value: number) => {
    setCart(prev => ({
      ...prev,
      [key]: {
        cases: prev[key]?.cases ?? 0,
        units: prev[key]?.units ?? 0,
        [field]: value,
      },
    }));
  }, [setCart]);

  const filterParams = {
    has_rip: filters.hasRip,
    has_discount: filters.hasDiscount,
    in_combo: filters.inCombo || undefined,
    group_by_rip: filters.groupByRip || undefined,
    price_drop: filters.priceTrend === 'drop' || undefined,
    price_increase: filters.priceTrend === 'increase' || undefined,
    divisions: filters.divisions.join(',') || undefined,
    categories: filters.categories.join(',') || undefined,
    brands: filters.brands.join(',') || undefined,
    sizes: filters.sizes.join(',') || undefined,
    min_price: filters.priceMin,
    max_price: filters.priceMax,
  };
  const filterKey = JSON.stringify(filters);

  const { data, isLoading } = useQuery({
    queryKey: ['catalog', q, wholesaler, sort, order, page, limit, trackedOnly, filterKey],
    queryFn: () => catalog.search({
      q,
      wholesaler: wholesaler || undefined,
      sort, order, limit,
      offset: page * limit,
      ...filterParams,
      tracked_only: trackedOnly || undefined,
      include_tiers: true,
    }),
  });

  const { data: facets } = useQuery({
    queryKey: ['catalog-facets', q, wholesaler, filterKey],
    queryFn: () => catalog.facets({ q, wholesaler: wholesaler || undefined, ...filterParams }),
  });

  const { data: comboIdx } = useQuery({ queryKey: ['combo-index'], queryFn: () => deals.comboIndex(), staleTime: 300_000 });
  const comboMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of comboIdx?.items ?? []) m.set(`${c.wholesaler}|${c.upc_norm}`, c.combo_code);
    return m;
  }, [comboIdx]);
  const comboLink = useCallback((item: Product) => {
    const norm = String(item.upc ?? '').replace(/^0+/, '');
    const code = norm ? comboMap.get(`${item.wholesaler}|${norm}`) : undefined;
    return code ? `/combos?code=${encodeURIComponent(code)}` : null;
  }, [comboMap]);

  const items = data?.items ?? [];
  const facetItems = data?.items ?? [];

  const handleSort = (col: 'product_name' | 'frontline_case_price' | 'effective_case_price') => {
    if (sort === col) setOrder(o => o === 'asc' ? 'desc' : 'asc');
    else { setSort(col); setOrder(col === 'product_name' ? 'asc' : 'desc'); }
    setPage(0);
  };
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / limit));
  const qc = useQueryClient();

  // ---- Resizable / collapsible assistant panel ----
  const PANEL_MIN = 320, PANEL_MAX = 760;
  const [panelOpen, setPanelOpen] = useState<boolean>(() => localStorage.getItem('catalog_ai_open') !== 'false');
  const [panelWidth, setPanelWidth] = useState<number>(() => {
    const n = parseInt(localStorage.getItem('catalog_ai_w') ?? '', 10);
    return Number.isFinite(n) ? Math.min(PANEL_MAX, Math.max(PANEL_MIN, n)) : 400;
  });
  useEffect(() => { localStorage.setItem('catalog_ai_open', String(panelOpen)); }, [panelOpen]);
  useEffect(() => { localStorage.setItem('catalog_ai_w', String(panelWidth)); }, [panelWidth]);
  const resizeRef = useRef<{ startX: number; startW: number } | null>(null);
  const onResizeDown = (e: React.PointerEvent) => {
    resizeRef.current = { startX: e.clientX, startW: panelWidth };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };
  const onResizeMove = (e: React.PointerEvent) => {
    const r = resizeRef.current;
    if (!r) return;
    // Panel is on the RIGHT, so dragging the handle left widens it.
    const next = Math.min(PANEL_MAX, Math.max(PANEL_MIN, r.startW - (e.clientX - r.startX)));
    setPanelWidth(next);
  };
  const onResizeUp = (e: React.PointerEvent) => {
    resizeRef.current = null;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* */ }
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  };

  // Execute the human-style actions the assistant planned (add to cart / set
  // quantity / favorite / add to list). The backend already resolved each
  // action to concrete products, so we just call the same APIs the buttons do.
  const runAiActions = useCallback(async (actions: CatalogAiAction[]) => {
    for (const a of actions) {
      try {
        if (a.type === 'add_to_cart' || a.type === 'update_quantity') {
          for (const p of a.products) {
            await cartApi.add({
              product_name: p.product_name, wholesaler: p.wholesaler,
              upc: p.upc ?? undefined, unit_volume: p.unit_volume ?? undefined,
              qty_cases: a.cases || 0, qty_units: a.bottles || 0,
            });
          }
        } else if (a.type === 'add_to_favorites') {
          for (const p of a.products) {
            await watchlist.add({
              product_name: p.product_name, wholesaler: p.wholesaler,
              upc: p.upc ?? undefined, unit_volume: p.unit_volume ?? undefined,
            });
          }
        } else if (a.type === 'add_to_list') {
          const name = (a.list_name || 'AI List').trim();
          const existing = await listsApi.list();
          let target = existing.find(l => l.name.toLowerCase() === name.toLowerCase());
          if (!target) target = await listsApi.create(name);
          for (const p of a.products) {
            await listsApi.addItem(target.id, {
              product_name: p.product_name, wholesaler: p.wholesaler,
              upc: p.upc ?? undefined, unit_volume: p.unit_volume ?? undefined,
            });
          }
        }
      } catch { /* keep going on partial failures */ }
    }
    qc.invalidateQueries({ queryKey: ['cart'] });
    qc.invalidateQueries({ queryKey: ['watchlist'] });
    qc.invalidateQueries({ queryKey: ['lists'] });
  }, [qc]);

  // The AI assistant returns the same knobs the catalog already supports; apply
  // them to page state so the existing query re-runs and the screen reflects
  // the answer, then run any actions it planned.
  const applyAiResult = useCallback((res: CatalogAiResponse) => {
    setQ(res.q ?? '');
    const f = res.filters ?? {};
    setFilters({
      ...emptyCatalogFilters,
      hasRip: f.hasRip ?? undefined,
      hasDiscount: f.hasDiscount ?? undefined,
      inCombo: f.inCombo || undefined,
      priceTrend: f.priceTrend ?? undefined,
      divisions: f.divisions ?? [],
      categories: f.categories ?? [],
      brands: f.brands ?? [],
      sizes: f.sizes ?? [],
      priceMin: f.priceMin ?? undefined,
      priceMax: f.priceMax ?? undefined,
    });
    if (res.sort) setSort(res.sort);
    if (res.order) setOrder(res.order);
    setPage(0);
    if (res.actions?.length) runAiActions(res.actions);
  }, [runAiActions]);

  // Chips summarising what the assistant did (actions first, then filters).
  const describeAiResult = useCallback((res: CatalogAiResponse): string[] => {
    const chips: string[] = [];
    for (const a of res.actions ?? []) {
      const names = a.products.map(p => p.product_name);
      const label = names.length === 1 ? names[0] : `${names.length} items`;
      if (a.type === 'add_to_cart') chips.push(`🛒 ${label}${a.cases ? ` ×${a.cases}cs` : ''}${a.bottles ? ` ×${a.bottles}btl` : ''}`);
      else if (a.type === 'update_quantity') chips.push(`✏️ ${label} → ${a.cases}cs / ${a.bottles}btl`);
      else if (a.type === 'add_to_favorites') chips.push(`⭐ ${label}`);
      else if (a.type === 'add_to_list') chips.push(`📋 ${a.list_name ?? 'List'} (+${a.products.length})`);
      if (a.note) chips.push(`⚠ ${a.note}`);
    }
    const f = res.filters ?? {};
    if (res.q) chips.push(`“${res.q}”`);
    (f.categories ?? []).forEach(c => chips.push(c));
    (f.divisions ?? []).forEach(d => chips.push(distributorName(d)));
    if (f.hasRip) chips.push('RIP rebate');
    if (f.hasDiscount) chips.push('On discount');
    if (f.priceMax != null) chips.push(`≤ $${f.priceMax}`);
    if (f.priceMin != null) chips.push(`≥ $${f.priceMin}`);
    if (res.sort === 'effective_case_price') chips.push(res.order === 'asc' ? 'Cheapest first' : 'Priciest first');
    return chips;
  }, []);

  return (
    <div className="page font-test-catalog">
      <div className="font-test-banner">
        🔠 <strong>Test For Font Catalog</strong> — admin sandbox for trialling larger, more
        readable typography. The production Catalog page is unchanged.
      </div>
      <div className="orders-header">
        <h2>Product Catalog</h2>
        <WholesalerFilter value={wholesaler} onChange={(v) => { setWholesaler(v); setPage(0); }} />
      </div>

      <div className="search-bar">
        <input type="text" placeholder="Search products..." value={q} onChange={e => { setQ(e.target.value); setPage(0); }} />
        <span className="search-count">{isLoading ? 'Fetching data…' : `${(data?.total ?? 0).toLocaleString()} results`}</span>
      </div>
      {data?.corrected_query && data.corrected_query.toLowerCase() !== q.trim().toLowerCase() && (
        <p className="search-correction" style={{ color: 'var(--text-muted)', margin: '-8px 0 12px' }}>
          No exact match for "{q.trim()}". Showing results for{' '}
          <button type="button" className="link-btn" onClick={() => { setQ(data.corrected_query!); setPage(0); }}
            style={{ background: 'none', border: 0, padding: 0, color: 'var(--accent)', fontWeight: 600, cursor: 'pointer' }}>
            "{data.corrected_query}"
          </button>.
        </p>
      )}

      <CatalogFilterPanel
        filters={filters}
        onChange={(f) => { setFilters(f); setPage(0); }}
        items={facetItems}
        facets={facets}
        trackedOnly={trackedOnly}
        onTrackedChange={(v) => { setTrackedOnly(v); setPage(0); }}
        showPro={showPro}
        onShowProChange={onShowProChange}
        collapsed={!showFilters}
        onToggleCollapsed={toggleFilters}
      />

      <div className="toolbar">
        <RowLimitSelect value={limit} onChange={v => { setLimit(v); setPage(0); }} />
      </div>

      <div className="catalog-with-assistant" style={{ ['--ai-panel-w' as string]: `${panelWidth}px` } as React.CSSProperties}>
        <div className="catalog-layout catalog-layout--full">
          <div className="catalog-results">
            {isLoading ? <p>Loading...</p> : (
              <CatalogTable
                items={items as Product[]}
                open={open}
                cart={cart}
                updateQty={updateQty}
                sortControls={{ sort, order, onSort: (c) => handleSort(c) }}
                comboLink={comboLink}
                groupByRip={!!filters.groupByRip}
                showProColumns={showPro}
              />
            )}

            <div className="pagination">
              <button disabled={page === 0} onClick={() => setPage(p => p - 1)}>Prev</button>
              <span>Page {page + 1} of {totalPages}</span>
              <button disabled={(page + 1) * limit >= (data?.total ?? 0)} onClick={() => setPage(p => p + 1)}>Next</button>
            </div>
          </div>

          {panelOpen && (
            <div className="ai-resizer" role="separator" aria-orientation="vertical"
                 aria-label="Resize assistant panel" title="Drag to resize"
                 onPointerDown={onResizeDown} onPointerMove={onResizeMove} onPointerUp={onResizeUp}>
              <span className="ai-resizer-grip" />
            </div>
          )}

          <AiAssistantPanel<CatalogAiResponse>
            open={panelOpen}
            onOpenChange={setPanelOpen}
            title="Catalog Assistant"
            subtitle="Ask or speak — I filter the catalog and can add to cart, favorites or lists."
            placeholder="e.g. add 2 cases of the cheapest tequila to my cart"
            storageKey="catalog_ai"
            suggestions={[
              'Wine under $150 with a RIP rebate',
              'Cheapest tequila at Allied',
              'Add 2 cases of the cheapest prosecco to my cart',
              'Save the cheapest cabernet to favorites',
              'Make a list called Holiday Picks with 5 sparkling wines',
            ]}
            send={(question) => catalog.aiQuery(question)}
            onApply={applyAiResult}
            describeResult={describeAiResult}
          />
        </div>
      </div>
    </div>
  );
}
