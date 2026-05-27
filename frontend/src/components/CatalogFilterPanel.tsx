import { useState, useMemo } from 'react';
import type { Product, CatalogFacets } from '../lib/api';
import { distributorName } from '../lib/distributors';
import TrackedOnlyToggle from './TrackedOnlyToggle';

// ---- Filter state interface ----
export interface CatalogFilters {
  hasRip?: boolean;
  hasDiscount?: boolean;
  inCombo?: boolean;
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
  n += f.divisions.length;
  if (f.priceMin !== undefined) n++;
  if (f.priceMax !== undefined) n++;
  n += f.categories.length;
  n += f.brands.length;
  n += f.sizes.length;
  return n;
}

// ---- Collapsible section sub-component ----
function FilterSection({
  title,
  activeCount,
  defaultOpen = true,
  dataTour,
  children,
}: {
  title: string;
  activeCount: number;
  defaultOpen?: boolean;
  dataTour?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="filter-section" data-tour={dataTour}>
      <button
        className="filter-header"
        onClick={() => setOpen((o) => !o)}
        type="button"
      >
        <span className="filter-header-title">
          {title}
          {activeCount > 0 && (
            <span className="filter-active-count">{activeCount}</span>
          )}
        </span>
        <svg
          className={`filter-chevron${open ? ' filter-chevron-open' : ''}`}
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
        >
          <path
            d="M4 6l4 4 4-4"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open && <div className="filter-section-body">{children}</div>}
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
  if (unit.startsWith('L')) return n * 1000;   // L / LIT / LITER
  if (unit === 'OZ') return n * 29.5735;
  return n;                                     // ML
}

// ---- Helpers to extract facets from items ----
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

// ---- Main component ----
export default function CatalogFilterPanel({
  filters,
  onChange,
  items,
  facets,
  trackedOnly,
  onTrackedChange,
}: {
  filters: CatalogFilters;
  onChange: (f: CatalogFilters) => void;
  items: Product[];
  facets?: CatalogFacets;
  trackedOnly?: boolean;
  onTrackedChange?: (v: boolean) => void;
}) {
  // Local price inputs (only applied on "Go")
  const [priceMinInput, setPriceMinInput] = useState(
    filters.priceMin?.toString() ?? ''
  );
  const [priceMaxInput, setPriceMaxInput] = useState(
    filters.priceMax?.toString() ?? ''
  );

  // Brand/size search
  const [brandSearch, setBrandSearch] = useState('');
  const [sizeSearch, setSizeSearch] = useState('');
  const [brandShowAll, setBrandShowAll] = useState(false);

  // Facets: prefer server-side counts (whole dataset) over per-page counts
  const toMap = (arr?: { key: string; count: number }[]) => {
    const m = new Map<string, number>();
    if (arr) for (const b of arr) m.set(b.key, b.count);
    return m;
  };
  const divisionFacet = useMemo(
    () => facets ? toMap(facets.divisions) : buildFacet(items, 'wholesaler'),
    [facets, items]
  );
  const categoryFacet = useMemo(() => {
    const m = facets ? toMap(facets.categories) : buildFacet(items, 'product_type');
    // "Combo" is a product_type on a few bundle-header rows, not the real
    // "in a combo" concept (that's the In combo deal filter). Hide it here so
    // the Category list stays meaningful.
    m.delete('Combo');
    return m;
  }, [facets, items]);
  const brandFacet = useMemo(
    () => facets ? toMap(facets.brands) : buildFacet(items, 'brand'),
    [facets, items]
  );
  const sizeFacet = useMemo(
    () => facets ? toMap(facets.sizes) : buildFacet(items, 'unit_volume'),
    [facets, items]
  );

  // RIP counts (server total when available)
  const ripCount = facets?.has_rip ?? items.filter((i) => i.has_rip).length;
  const noRipCount = facets?.no_rip ?? items.filter((i) => !i.has_rip).length;
  const discCount = facets?.has_discount ?? items.filter((i) => i.has_discount).length;
  const noDiscCount = facets?.no_discount ?? items.filter((i) => !i.has_discount).length;
  const comboCount = facets?.has_combo ?? items.filter((i) => !!i.combo_code && i.combo_code !== '0').length;

  const toggleArrayValue = (
    arr: string[],
    val: string
  ): string[] =>
    arr.includes(val) ? arr.filter((v) => v !== val) : [...arr, val];

  // ---- Deals toggle ----
  const dealsActiveCount = (filters.hasRip !== undefined ? 1 : 0) + (filters.hasDiscount !== undefined ? 1 : 0) + (filters.inCombo ? 1 : 0);

  // ---- Price active count ----
  const priceActiveCount =
    (filters.priceMin !== undefined ? 1 : 0) +
    (filters.priceMax !== undefined ? 1 : 0);

  // ---- Filtered brand list ----
  const brandEntries = useMemo(() => {
    const entries = [...brandFacet.entries()];
    if (!brandSearch) return entries;
    const q = brandSearch.toLowerCase();
    return entries.filter(([name]) => name.toLowerCase().includes(q));
  }, [brandFacet, brandSearch]);

  const visibleBrands = brandShowAll ? brandEntries : brandEntries.slice(0, 7);

  // ---- Filtered size list ----
  const sizeEntries = useMemo(() => {
    let entries = [...sizeFacet.entries()];
    if (sizeSearch) {
      const q = sizeSearch.toLowerCase();
      entries = entries.filter(([name]) => name.toLowerCase().includes(q));
    }
    // Smallest -> largest by actual volume, not alphabetical.
    return entries.sort((a, b) => toMl(a[0]) - toMl(b[0]));
  }, [sizeFacet, sizeSearch]);

  return (
    <aside className="filter-panel">
      {/* ---- In Favorites (watchlist) ---- */}
      {onTrackedChange && (
        <div className="filter-favorites">
          <TrackedOnlyToggle enabled={!!trackedOnly} onChange={onTrackedChange} />
        </div>
      )}

      {/* ---- Deals Toggle ---- */}
      <FilterSection title="Deals" activeCount={dealsActiveCount} dataTour="filter-deals">
        <div className="filter-checkbox-list">
          <label className="filter-checkbox">
            <input
              type="checkbox"
              checked={filters.hasRip === true}
              onChange={() =>
                onChange({
                  ...filters,
                  hasRip: filters.hasRip === true ? undefined : true,
                })
              }
            />
            <span>Has RIP offer</span>
            <span className="filter-facet-count">{ripCount}</span>
          </label>
          <label className="filter-checkbox">
            <input
              type="checkbox"
              checked={filters.hasRip === false}
              onChange={() =>
                onChange({
                  ...filters,
                  hasRip: filters.hasRip === false ? undefined : false,
                })
              }
            />
            <span>No RIP</span>
            <span className="filter-facet-count">{noRipCount}</span>
          </label>
          <label className="filter-checkbox">
            <input
              type="checkbox"
              checked={filters.hasDiscount === true}
              onChange={() =>
                onChange({ ...filters, hasDiscount: filters.hasDiscount === true ? undefined : true })
              }
            />
            <span>Has discount</span>
            <span className="filter-facet-count">{discCount}</span>
          </label>
          <label className="filter-checkbox">
            <input
              type="checkbox"
              checked={filters.hasDiscount === false}
              onChange={() =>
                onChange({ ...filters, hasDiscount: filters.hasDiscount === false ? undefined : false })
              }
            />
            <span>No discount</span>
            <span className="filter-facet-count">{noDiscCount}</span>
          </label>
          <label className="filter-checkbox">
            <input
              type="checkbox"
              checked={filters.inCombo === true}
              onChange={() =>
                onChange({ ...filters, inCombo: filters.inCombo ? undefined : true })
              }
            />
            <span>In combo</span>
            <span className="filter-facet-count">{comboCount}</span>
          </label>
        </div>
      </FilterSection>

      {/* ---- Distributors ---- */}
      <FilterSection
        title="Distributors"
        activeCount={filters.divisions.length}
      >
        <div className="filter-checkbox-list" style={{ maxHeight: 200 }}>
          {[...divisionFacet.entries()].map(([div, count]) => (
            <label key={div} className="filter-checkbox">
              <input
                type="checkbox"
                checked={filters.divisions.includes(div)}
                onChange={() =>
                  onChange({
                    ...filters,
                    divisions: toggleArrayValue(filters.divisions, div),
                  })
                }
              />
              <span>{distributorName(div)}</span>
              <span className="filter-facet-count">{count}</span>
            </label>
          ))}
        </div>
      </FilterSection>

      {/* ---- Brand ---- */}
      <FilterSection title="Brand" activeCount={filters.brands.length} dataTour="filter-brand">
        <input
          type="text"
          className="filter-search"
          placeholder="Search brands..."
          value={brandSearch}
          onChange={(e) => setBrandSearch(e.target.value)}
        />
        <div className="filter-checkbox-list" style={{ maxHeight: 240 }}>
          {visibleBrands.map(([brand, count]) => (
            <label key={brand} className="filter-checkbox">
              <input
                type="checkbox"
                checked={filters.brands.includes(brand)}
                onChange={() =>
                  onChange({
                    ...filters,
                    brands: toggleArrayValue(filters.brands, brand),
                  })
                }
              />
              <span>{brand}</span>
              <span className="filter-facet-count">{count}</span>
            </label>
          ))}
        </div>
        {!brandShowAll && brandEntries.length > 7 && (
          <button
            className="filter-show-all"
            type="button"
            onClick={() => setBrandShowAll(true)}
          >
            Show all {brandEntries.length}...
          </button>
        )}
        {brandShowAll && brandEntries.length > 7 && (
          <button
            className="filter-show-all"
            type="button"
            onClick={() => setBrandShowAll(false)}
          >
            Show fewer
          </button>
        )}
      </FilterSection>

      {/* ---- Price Range ---- */}
      <FilterSection title="Price Range (Case)" activeCount={priceActiveCount} dataTour="filter-price">
        <div className="filter-price-range">
          <input
            type="number"
            className="filter-price-input"
            placeholder="Min"
            value={priceMinInput}
            onChange={(e) => setPriceMinInput(e.target.value)}
          />
          <span className="filter-price-sep">to</span>
          <input
            type="number"
            className="filter-price-input"
            placeholder="Max"
            value={priceMaxInput}
            onChange={(e) => setPriceMaxInput(e.target.value)}
          />
          <button
            className="btn btn-secondary filter-price-go"
            type="button"
            onClick={() => {
              onChange({
                ...filters,
                priceMin: priceMinInput ? Number(priceMinInput) : undefined,
                priceMax: priceMaxInput ? Number(priceMaxInput) : undefined,
              });
            }}
          >
            Go
          </button>
        </div>
      </FilterSection>

      {/* ---- Category ---- */}
      <FilterSection
        title="Category"
        activeCount={filters.categories.length}
        dataTour="filter-category"
      >
        <div className="filter-checkbox-list">
          {[...categoryFacet.entries()].map(([cat, count]) => (
            <label key={cat} className="filter-checkbox">
              <input
                type="checkbox"
                checked={filters.categories.includes(cat)}
                onChange={() =>
                  onChange({
                    ...filters,
                    categories: toggleArrayValue(filters.categories, cat),
                  })
                }
              />
              <span>{cat}</span>
              <span className="filter-facet-count">{count}</span>
            </label>
          ))}
        </div>
      </FilterSection>

      {/* ---- Size ---- */}
      <FilterSection
        title="Size"
        activeCount={filters.sizes.length}
        defaultOpen={false}
      >
        <input
          type="text"
          className="filter-search"
          placeholder="Search sizes..."
          value={sizeSearch}
          onChange={(e) => setSizeSearch(e.target.value)}
        />
        <div className="filter-checkbox-list" style={{ maxHeight: 240 }}>
          {sizeEntries.map(([size, count]) => (
            <label key={size} className="filter-checkbox">
              <input
                type="checkbox"
                checked={filters.sizes.includes(size)}
                onChange={() =>
                  onChange({
                    ...filters,
                    sizes: toggleArrayValue(filters.sizes, size),
                  })
                }
              />
              <span>{size}</span>
              <span className="filter-facet-count">{count}</span>
            </label>
          ))}
        </div>
      </FilterSection>
    </aside>
  );
}
