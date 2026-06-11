import { useState, useMemo, useRef, useEffect, type ReactNode } from 'react';
import { ChevronDown, ChevronUp, XCircle, Filter as FilterIcon } from 'lucide-react';
import type { Product, CatalogFacets } from '../lib/api';
import { distributorName } from '../lib/distributors';
import TrackedOnlyToggle from './TrackedOnlyToggle';

// ---- Filter state interface ----
export interface CatalogFilters {
  hasRip?: boolean;
  hasDiscount?: boolean;
  inCombo?: boolean;
  // Only products with a DATED (sub-month) QD/RIP window this edition.
  timeSensitive?: boolean;
  // When true, the search backend clusters products sharing a Case Mix RIP
  // rebate (each row gets a coloured band keyed off the rip code, and rows
  // whose CPL rip_code drifted from the RIP sheet wear a "check with sales
  // rep" sticker).
  groupByRip?: boolean;
  // Price-trend radio: filter by this-month vs next-month effective best
  // price. Mutually exclusive (radio semantics, not stacking checkboxes);
  // undefined = no filter. Backed server-side so pagination + result count
  // reconcile.
  priceTrend?: 'drop' | 'increase';
  divisions: string[];
  priceMin?: number;
  priceMax?: number;
  categories: string[];
  brands: string[];
  sizes: string[];
  unitKinds: string[];   // container type: Bottle / Can / Keg
}

export const emptyCatalogFilters: CatalogFilters = {
  divisions: [],
  categories: [],
  brands: [],
  sizes: [],
  unitKinds: [],
};

export function countActiveFilters(f: CatalogFilters): number {
  let n = 0;
  if (f.hasRip !== undefined) n++;
  if (f.hasDiscount !== undefined) n++;
  if (f.inCombo) n++;
  if (f.timeSensitive) n++;
  if (f.groupByRip) n++;
  if (f.priceTrend) n++;
  n += f.divisions.length;
  if (f.priceMin !== undefined) n++;
  if (f.priceMax !== undefined) n++;
  n += f.categories.length;
  n += f.brands.length;
  n += f.sizes.length;
  n += f.unitKinds?.length ?? 0;
  return n;
}

// ---- Dropdown button used for every catalog filter section ----
function FilterDropdown({
  title,
  activeCount,
  isOpen,
  onOpen,
  onClose,
  dataTour,
  children,
}: {
  title: string;
  activeCount: number;
  isOpen: boolean;
  onOpen: () => void;
  onClose: () => void;
  dataTour?: string;
  children: ReactNode;
}) {
  // Close on outside click + Escape so the popover behaves like every other
  // dropdown menu in the app.
  const wrapRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!isOpen) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [isOpen, onClose]);

  return (
    <div className="catalog-filter-dd" data-tour={dataTour} ref={wrapRef}>
      <button
        type="button"
        className={`catalog-filter-dd-btn ${isOpen ? 'is-open' : ''} ${activeCount > 0 ? 'has-active' : ''}`}
        onClick={() => (isOpen ? onClose() : onOpen())}
      >
        <span>{title}</span>
        {activeCount > 0 && <span className="catalog-filter-dd-count">{activeCount}</span>}
        <ChevronDown size={13} className={`catalog-filter-dd-chev ${isOpen ? 'is-open' : ''}`} />
      </button>
      {isOpen && (
        <div className="catalog-filter-dd-panel" role="dialog">
          {children}
        </div>
      )}
    </div>
  );
}

// Parse a size label (e.g. "750ML", "1.5L", "16OZ") to millilitres so sizes
// sort smallest -> largest instead of alphabetically. Unknowns sort last.
function toMl(label: string): number {
  const s = (label || '').toUpperCase().trim();
  const m = s.match(/^([\d.]+)\s*(ML|L|LIT|LITER|OZ)?/);
  if (!m) return Number.MAX_SAFE_INTEGER;
  const n = parseFloat(m[1]);
  if (isNaN(n)) return Number.MAX_SAFE_INTEGER;
  const unit = m[2] || 'ML';
  if (unit.startsWith('L')) return n * 1000;
  if (unit === 'OZ') return n * 29.5735;
  return n;
}

function buildFacet(items: Product[], key: keyof Product): Map<string, number> {
  const m = new Map<string, number>();
  for (const item of items) {
    const v = item[key];
    if (v == null || v === '') continue;
    const s = String(v);
    m.set(s, (m.get(s) ?? 0) + 1);
  }
  return new Map([...m.entries()].sort((a, b) => b[1] - a[1]));
}

interface Props {
  filters: CatalogFilters;
  onChange: (f: CatalogFilters) => void;
  items: Product[];
  facets?: CatalogFacets;
  trackedOnly?: boolean;
  onTrackedChange?: (v: boolean) => void;
  // Display preference: show / hide the three Pro teaser columns. On
  // by default; persisted by the parent (Catalog.tsx) in localStorage.
  showPro?: boolean;
  onShowProChange?: (v: boolean) => void;
  // Display preference: show / hide the AI Catalog Assistant panel. When this
  // handler is provided a "Show AI Chat" toggle appears in the toolbar.
  showAiChat?: boolean;
  onShowAiChatChange?: (v: boolean) => void;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}

/**
 * Catalog filter toolbar: horizontal row of dropdown buttons pinned above the
 * product grid. Each dropdown is a popover containing the same checkbox list
 * the old vertical panel used, so behaviour is unchanged — only the layout
 * moves from a 240px left rail to a sticky top toolbar, freeing the catalog
 * grid to use the full viewport.
 *
 * The "Clear all filters" action is anchored on the LEFT, matching the same
 * placement the user requested for the rest of the app's filter toolbars.
 */
export default function CatalogFilterPanel({
  filters, onChange, items, facets,
  trackedOnly, onTrackedChange,
  showPro, onShowProChange,
  showAiChat, onShowAiChatChange,
  collapsed = false, onToggleCollapsed,
}: Props) {
  // Publish the rendered height of the toolbar as a CSS custom property
  // so the catalog table header (which is also sticky) can park just
  // below it. The toolbar wraps onto multiple lines as the viewport
  // narrows or more pills get added, so a static `top: 56px` would
  // leave the column headers half-hidden in those cases.
  const toolbarRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const node = toolbarRef.current;
    if (!node) return;
    const publish = () => {
      const h = Math.ceil(node.getBoundingClientRect().height);
      document.documentElement.style.setProperty('--catalog-filter-toolbar-h', `${h}px`);
    };
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(node);
    window.addEventListener('resize', publish);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', publish);
    };
  }, []);
  const [priceMinInput, setPriceMinInput] = useState(filters.priceMin?.toString() ?? '');
  const [priceMaxInput, setPriceMaxInput] = useState(filters.priceMax?.toString() ?? '');
  const [brandSearch, setBrandSearch] = useState('');
  const [sizeSearch, setSizeSearch] = useState('');
  const [brandShowAll, setBrandShowAll] = useState(false);
  // Only one dropdown is open at a time; null = all closed.
  const [openKey, setOpenKey] = useState<string | null>(null);
  const opener = (k: string) => () => setOpenKey(k);
  const closeAll = () => setOpenKey(null);

  const toMap = (arr?: { key: string; count: number }[]) => {
    const m = new Map<string, number>();
    if (arr) for (const b of arr) m.set(b.key, b.count);
    return m;
  };
  const divisionFacet = useMemo(
    () => (facets ? toMap(facets.divisions) : buildFacet(items, 'wholesaler')),
    [facets, items]
  );
  const categoryFacet = useMemo(() => {
    const m = facets ? toMap(facets.categories) : buildFacet(items, 'product_type');
    m.delete('Combo');
    return m;
  }, [facets, items]);
  const brandFacet = useMemo(
    () => (facets ? toMap(facets.brands) : buildFacet(items, 'brand')),
    [facets, items]
  );
  const sizeFacet = useMemo(() => {
    // Sizes must read smallest -> largest (750ML, 1L, 1.5L, 1.75L), not
    // alphabetically or by count.
    const base = facets ? toMap(facets.sizes) : buildFacet(items, 'unit_volume');
    return new Map([...base.entries()].sort((a, b) => toMl(a[0]) - toMl(b[0])));
  }, [facets, items]);
  // Container type: standardised Bottle / Can / Keg buckets from the backend.
  const unitKindFacet = useMemo(() => {
    const order = ['Bottle', 'Can', 'Keg'];
    const base = facets?.unit_kinds ? toMap(facets.unit_kinds) : new Map<string, number>();
    return new Map([...base.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0])));
  }, [facets]);

  const ripCount = facets?.has_rip ?? items.filter(i => i.has_rip).length;
  const noRipCount = facets?.no_rip ?? items.filter(i => !i.has_rip).length;
  const discCount = facets?.has_discount ?? items.filter(i => i.has_discount).length;
  const noDiscCount = facets?.no_discount ?? items.filter(i => !i.has_discount).length;
  const comboCount = facets?.has_combo ?? items.filter(i => !!i.combo_code && i.combo_code !== '0').length;

  const toggleArrayValue = (arr: string[], val: string): string[] =>
    arr.includes(val) ? arr.filter(v => v !== val) : [...arr, val];

  const dealsActiveCount =
    (filters.hasRip !== undefined ? 1 : 0) +
    (filters.hasDiscount !== undefined ? 1 : 0) +
    (filters.inCombo ? 1 : 0);
  const priceActiveCount =
    (filters.priceMin !== undefined ? 1 : 0) +
    (filters.priceMax !== undefined ? 1 : 0);
  const totalActive = countActiveFilters(filters);

  const brandEntries = useMemo(() => {
    const entries = [...brandFacet.entries()];
    if (!brandSearch) return entries;
    const q = brandSearch.toLowerCase();
    return entries.filter(([name]) => name.toLowerCase().includes(q));
  }, [brandFacet, brandSearch]);
  const visibleBrands = brandShowAll ? brandEntries : brandEntries.slice(0, 12);

  const sizeEntries = useMemo(() => {
    let entries = [...sizeFacet.entries()];
    if (sizeSearch) {
      const q = sizeSearch.toLowerCase();
      entries = entries.filter(([name]) => name.toLowerCase().includes(q));
    }
    return entries.sort((a, b) => toMl(a[0]) - toMl(b[0]));
  }, [sizeFacet, sizeSearch]);

  const onClearAll = () => {
    onChange({ ...emptyCatalogFilters });
    setPriceMinInput('');
    setPriceMaxInput('');
    setBrandSearch('');
    setSizeSearch('');
    setBrandShowAll(false);
  };

  return (
    <aside ref={toolbarRef} className={`catalog-filter-toolbar ${collapsed ? 'is-collapsed' : ''}`}>
      <div className="catalog-filter-toolbar-row">
        <button
          type="button"
          className="catalog-filter-clear"
          onClick={onClearAll}
          title="Clear all filters on this page"
        >
          <XCircle size={14} /> Clear all filters
          {totalActive > 0 && <span className="catalog-filter-clear-count">{totalActive}</span>}
        </button>

        {!collapsed && (
          <div className="catalog-filter-row-sections">
            {onTrackedChange && (
              <div className="catalog-filter-favorites" data-tour="filter-favorites">
                <TrackedOnlyToggle enabled={!!trackedOnly} onChange={onTrackedChange} />
              </div>
            )}
            {/* Group-by-Case-Mix-RIP used to live inside the Deals dropdown,
                but it's a view mode (changes how rows are clustered), not a
                facet filter — so it gets its own toggle pill next to the
                Favorites toggle where it's discoverable. */}
            <label
              className={`tracked-toggle ${filters.groupByRip ? 'is-active' : ''}`}
              data-tour="filter-group-rip"
              title="Cluster products that share a RIP rebate (from the RIP sheet) and colour-band each group"
            >
              <input
                type="checkbox"
                checked={filters.groupByRip === true}
                onChange={() => onChange({ ...filters, groupByRip: filters.groupByRip ? undefined : true })}
              />
              <span>Group by Case Mix RIP</span>
            </label>
            {/* Quick-access shortcuts for the two most common deal filters.
                The Deals dropdown still has the full Has/No pair for each. */}
            <label
              className={`tracked-toggle ${filters.hasRip === true ? 'is-active' : ''}`}
              data-tour="filter-rip-only"
              title="Show only products that carry a RIP rebate"
            >
              <input
                type="checkbox"
                checked={filters.hasRip === true}
                onChange={() => onChange({ ...filters, hasRip: filters.hasRip === true ? undefined : true })}
              />
              <span>Has RIP</span>
            </label>
            <label
              className={`tracked-toggle ${filters.hasDiscount === true ? 'is-active' : ''}`}
              data-tour="filter-discount-only"
              title="Show only products with an active CPL discount tier"
            >
              <input
                type="checkbox"
                checked={filters.hasDiscount === true}
                onChange={() => onChange({ ...filters, hasDiscount: filters.hasDiscount === true ? undefined : true })}
              />
              <span>Has Discount</span>
            </label>
            {/* Price-trend radio: keep rows whose this-month vs next-month
                best effective case price moves. Radio semantics, so picking
                one clears the other; clicking the already-selected one
                clears the filter entirely. The "Better price: THIS / NEXT
                MONTH" sticker on each row tells the buyer which direction
                it moved. */}
            <label
              className={`tracked-toggle ${filters.priceTrend === 'drop' ? 'is-active' : ''}`}
              data-tour="filter-price-drop"
              title="Show only products whose effective best price drops next month"
            >
              <input
                type="radio"
                name="catalog-price-trend"
                checked={filters.priceTrend === 'drop'}
                onClick={() => onChange({ ...filters, priceTrend: filters.priceTrend === 'drop' ? undefined : 'drop' })}
                onChange={() => { /* click-handled so we can also toggle off */ }}
              />
              <span>Price Drop</span>
            </label>
            <label
              className={`tracked-toggle ${filters.priceTrend === 'increase' ? 'is-active' : ''}`}
              data-tour="filter-price-increase"
              title="Show only products whose effective best price rises next month"
            >
              <input
                type="radio"
                name="catalog-price-trend"
                checked={filters.priceTrend === 'increase'}
                onClick={() => onChange({ ...filters, priceTrend: filters.priceTrend === 'increase' ? undefined : 'increase' })}
                onChange={() => { /* click-handled so we can also toggle off */ }}
              />
              <span>Price Increase</span>
            </label>
            {/* Display toggle for the three Pro teaser columns (Time to
                Sell, Suggested Qty, Quantity Justification). On by
                default so a new visitor sees the upgrade preview; the
                buyer can hide it if they want a denser table. Choice
                is persisted by the parent in localStorage. */}
            {onShowProChange && (
              <label
                className={`tracked-toggle ${showPro ? 'is-active' : ''}`}
                data-tour="filter-show-pro"
                title="Show or hide the three Pro teaser columns (Time to Sell, Suggested Qty, Quantity Justification). On by default."
              >
                <input
                  type="checkbox"
                  checked={!!showPro}
                  onChange={() => onShowProChange(!showPro)}
                />
                <span>Show Pro Features</span>
              </label>
            )}

            {onShowAiChatChange && (
              <label
                className={`tracked-toggle ${showAiChat ? 'is-active' : ''}`}
                title="Show or hide the AI Catalog Assistant chat panel. On by default."
              >
                <input
                  type="checkbox"
                  checked={!!showAiChat}
                  onChange={() => onShowAiChatChange(!showAiChat)}
                />
                <span>Show AI Chat</span>
              </label>
            )}

            <FilterDropdown
              title="Deals"
              activeCount={dealsActiveCount}
              isOpen={openKey === 'deals'}
              onOpen={opener('deals')}
              onClose={closeAll}
              dataTour="filter-deals"
            >
              <div className="filter-checkbox-list">
                <label className="filter-checkbox">
                  <input type="checkbox" checked={filters.hasRip === true}
                    onChange={() => onChange({ ...filters, hasRip: filters.hasRip === true ? undefined : true })} />
                  <span>Has RIP offer</span><span className="filter-facet-count">{ripCount}</span>
                </label>
                <label className="filter-checkbox">
                  <input type="checkbox" checked={filters.hasRip === false}
                    onChange={() => onChange({ ...filters, hasRip: filters.hasRip === false ? undefined : false })} />
                  <span>No RIP</span><span className="filter-facet-count">{noRipCount}</span>
                </label>
                <label className="filter-checkbox">
                  <input type="checkbox" checked={filters.hasDiscount === true}
                    onChange={() => onChange({ ...filters, hasDiscount: filters.hasDiscount === true ? undefined : true })} />
                  <span>Has discount</span><span className="filter-facet-count">{discCount}</span>
                </label>
                <label className="filter-checkbox">
                  <input type="checkbox" checked={filters.hasDiscount === false}
                    onChange={() => onChange({ ...filters, hasDiscount: filters.hasDiscount === false ? undefined : false })} />
                  <span>No discount</span><span className="filter-facet-count">{noDiscCount}</span>
                </label>
                <label className="filter-checkbox">
                  <input type="checkbox" checked={filters.inCombo === true}
                    onChange={() => onChange({ ...filters, inCombo: filters.inCombo ? undefined : true })} />
                  <span>In combo</span><span className="filter-facet-count">{comboCount}</span>
                </label>
              </div>
            </FilterDropdown>

            <FilterDropdown
              title="Distributors"
              activeCount={filters.divisions.length}
              isOpen={openKey === 'divisions'}
              onOpen={opener('divisions')}
              onClose={closeAll}
            >
              <div className="filter-checkbox-list catalog-filter-scroll">
                {[...divisionFacet.entries()].map(([div, count]) => (
                  <label key={div} className="filter-checkbox">
                    <input type="checkbox" checked={filters.divisions.includes(div)}
                      onChange={() => onChange({ ...filters, divisions: toggleArrayValue(filters.divisions, div) })} />
                    <span>{distributorName(div)}</span><span className="filter-facet-count">{count}</span>
                  </label>
                ))}
              </div>
            </FilterDropdown>

            <FilterDropdown
              title="Brand"
              activeCount={filters.brands.length}
              isOpen={openKey === 'brands'}
              onOpen={opener('brands')}
              onClose={closeAll}
              dataTour="filter-brand"
            >
              <input
                type="text" className="filter-search" placeholder="Search brands..."
                value={brandSearch} onChange={e => setBrandSearch(e.target.value)}
              />
              <div className="filter-checkbox-list catalog-filter-scroll">
                {visibleBrands.map(([brand, count]) => (
                  <label key={brand} className="filter-checkbox">
                    <input type="checkbox" checked={filters.brands.includes(brand)}
                      onChange={() => onChange({ ...filters, brands: toggleArrayValue(filters.brands, brand) })} />
                    <span>{brand}</span><span className="filter-facet-count">{count}</span>
                  </label>
                ))}
              </div>
              {!brandShowAll && brandEntries.length > 12 && (
                <button className="filter-show-all" type="button" onClick={() => setBrandShowAll(true)}>
                  Show all {brandEntries.length}...
                </button>
              )}
              {brandShowAll && brandEntries.length > 12 && (
                <button className="filter-show-all" type="button" onClick={() => setBrandShowAll(false)}>
                  Show fewer
                </button>
              )}
            </FilterDropdown>

            <FilterDropdown
              title="Price (Case)"
              activeCount={priceActiveCount}
              isOpen={openKey === 'price'}
              onOpen={opener('price')}
              onClose={closeAll}
              dataTour="filter-price"
            >
              <div className="filter-price-range">
                <input
                  type="number" className="filter-price-input" placeholder="Min"
                  value={priceMinInput} onChange={e => setPriceMinInput(e.target.value)}
                />
                <span className="filter-price-sep">to</span>
                <input
                  type="number" className="filter-price-input" placeholder="Max"
                  value={priceMaxInput} onChange={e => setPriceMaxInput(e.target.value)}
                />
                <button
                  className="btn btn-secondary filter-price-go" type="button"
                  onClick={() => {
                    onChange({
                      ...filters,
                      priceMin: priceMinInput ? Number(priceMinInput) : undefined,
                      priceMax: priceMaxInput ? Number(priceMaxInput) : undefined,
                    });
                    closeAll();
                  }}
                >Go</button>
              </div>
            </FilterDropdown>

            <FilterDropdown
              title="Category"
              activeCount={filters.categories.length}
              isOpen={openKey === 'categories'}
              onOpen={opener('categories')}
              onClose={closeAll}
              dataTour="filter-category"
            >
              <div className="filter-checkbox-list catalog-filter-scroll">
                {[...categoryFacet.entries()].map(([cat, count]) => (
                  <label key={cat} className="filter-checkbox">
                    <input type="checkbox" checked={filters.categories.includes(cat)}
                      onChange={() => onChange({ ...filters, categories: toggleArrayValue(filters.categories, cat) })} />
                    <span>{cat}</span><span className="filter-facet-count">{count}</span>
                  </label>
                ))}
              </div>
            </FilterDropdown>

            <FilterDropdown
              title="Size"
              activeCount={filters.sizes.length}
              isOpen={openKey === 'sizes'}
              onOpen={opener('sizes')}
              onClose={closeAll}
            >
              <input
                type="text" className="filter-search" placeholder="Search sizes..."
                value={sizeSearch} onChange={e => setSizeSearch(e.target.value)}
              />
              <div className="filter-checkbox-list catalog-filter-scroll">
                {sizeEntries.map(([size, count]) => (
                  <label key={size} className="filter-checkbox">
                    <input type="checkbox" checked={filters.sizes.includes(size)}
                      onChange={() => onChange({ ...filters, sizes: toggleArrayValue(filters.sizes, size) })} />
                    <span>{size}</span><span className="filter-facet-count">{count}</span>
                  </label>
                ))}
              </div>
            </FilterDropdown>

            {unitKindFacet.size > 0 && (
              <FilterDropdown
                title="Unit type"
                activeCount={filters.unitKinds?.length ?? 0}
                isOpen={openKey === 'unitKinds'}
                onOpen={opener('unitKinds')}
                onClose={closeAll}
              >
                <div className="filter-checkbox-list">
                  {[...unitKindFacet.entries()].map(([kind, count]) => (
                    <label key={kind} className="filter-checkbox">
                      <input type="checkbox" checked={(filters.unitKinds ?? []).includes(kind)}
                        onChange={() => onChange({ ...filters, unitKinds: toggleArrayValue(filters.unitKinds ?? [], kind) })} />
                      <span>{kind}</span><span className="filter-facet-count">{count}</span>
                    </label>
                  ))}
                </div>
              </FilterDropdown>
            )}
          </div>
        )}

        {onToggleCollapsed && (
          <button
            type="button"
            className="catalog-filter-toggle"
            onClick={onToggleCollapsed}
            title={collapsed ? 'Show filters' : 'Hide filters'}
          >
            {collapsed
              ? (<><FilterIcon size={13} /> Show filters</>)
              : (<><ChevronUp size={13} /> Hide</>)}
          </button>
        )}
      </div>
    </aside>
  );
}
