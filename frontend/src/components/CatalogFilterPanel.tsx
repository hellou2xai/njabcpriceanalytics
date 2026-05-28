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
  // When true, the search backend clusters products sharing a Case Mix RIP
  // rebate (each row gets a coloured band keyed off the rip code, and rows
  // whose CPL rip_code drifted from the RIP sheet wear a "check with sales
  // rep" sticker).
  groupByRip?: boolean;
  divisions: string[];
  priceMin?: number;
  priceMax?: number;
  categories: string[];
  brands: string[];
  sizes: string[];
}

export const emptyCatalogFilters: CatalogFilters = {
  divisions: [],
  categories: [],
  brands: [],
  sizes: [],
};

export function countActiveFilters(f: CatalogFilters): number {
  let n = 0;
  if (f.hasRip !== undefined) n++;
  if (f.hasDiscount !== undefined) n++;
  if (f.inCombo) n++;
  if (f.groupByRip) n++;
  n += f.divisions.length;
  if (f.priceMin !== undefined) n++;
  if (f.priceMax !== undefined) n++;
  n += f.categories.length;
  n += f.brands.length;
  n += f.sizes.length;
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
  collapsed = false, onToggleCollapsed,
}: Props) {
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
  const sizeFacet = useMemo(
    () => (facets ? toMap(facets.sizes) : buildFacet(items, 'unit_volume')),
    [facets, items]
  );

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
    (filters.inCombo ? 1 : 0) +
    (filters.groupByRip ? 1 : 0);
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
    <aside className={`catalog-filter-toolbar ${collapsed ? 'is-collapsed' : ''}`}>
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
                <label className="filter-checkbox"
                  title="Cluster products that share a RIP rebate (from the RIP sheet) and colour-band each group">
                  <input type="checkbox" checked={filters.groupByRip === true}
                    onChange={() => onChange({ ...filters, groupByRip: filters.groupByRip ? undefined : true })} />
                  <span>Group by Case Mix RIP</span>
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
