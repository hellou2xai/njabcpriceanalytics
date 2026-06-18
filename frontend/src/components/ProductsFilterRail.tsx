/**
 * Left filter rail for the Products page — the vertical sidebar from the
 * reference design. It drives the SAME `CatalogFilters` state the Catalog page
 * uses, so the page sends identical params to `/catalog/search` and the
 * semantic search, facet counts and pagination all behave the same. Only the
 * presentation (a left rail of collapsible sections vs. the catalog's top
 * dropdown toolbar) is new.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronUp, SlidersHorizontal, XCircle } from 'lucide-react';
import type { CatalogFilters } from './CatalogFilterPanel';
import { emptyCatalogFilters, countActiveFilters } from './CatalogFilterPanel';
import type { Product, CatalogFacets } from '../lib/api';
import { distributorName } from '../lib/distributors';
import TrackedOnlyToggle from './TrackedOnlyToggle';
import { sizeToMl } from '../lib/productSizes';

const toMl = sizeToMl;   // one canonical size parser (handles bare "LITER", "1.75L", …)

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

function toMap(arr?: { key: string; count: number }[]): Map<string, number> {
  const m = new Map<string, number>();
  if (arr) for (const b of arr) m.set(b.key, b.count);
  return m;
}

function Section({ title, children, defaultOpen = true }: { title: string; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`prod-filter-sect${open ? '' : ' is-collapsed'}`}>
      <button type="button" className="prod-filter-sect-head" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <span>{title}</span>
        <ChevronUp size={15} className={`prod-filter-chev${open ? '' : ' is-collapsed'}`} />
      </button>
      {open && <div className="prod-filter-sect-body">{children}</div>}
    </div>
  );
}

interface Props {
  filters: CatalogFilters;
  onChange: (f: CatalogFilters) => void;
  items: Product[];
  facets?: CatalogFacets;
  trackedOnly?: boolean;
  onTrackedChange?: (v: boolean) => void;
  // When provided, the rail shows a collapse control in its header.
  onCollapse?: () => void;
  // "RIP / QD month": which month's tier ladder the cards show. Only rendered
  // when a next edition is loaded (nextMonthLabel set).
  dealMonth?: 'current' | 'next';
  onDealMonthChange?: (v: 'current' | 'next') => void;
  currentMonthLabel?: string;
  nextMonthLabel?: string;
}

export default function ProductsFilterRail({ filters, onChange, items, facets, trackedOnly, onTrackedChange, onCollapse, dealMonth = 'current', onDealMonthChange, currentMonthLabel, nextMonthLabel }: Props) {
  const [priceMin, setPriceMin] = useState(filters.priceMin?.toString() ?? '');
  const [priceMax, setPriceMax] = useState(filters.priceMax?.toString() ?? '');
  const [brandSearch, setBrandSearch] = useState('');
  const [brandShowAll, setBrandShowAll] = useState(false);

  const divisionFacet = useMemo(
    () => (facets ? toMap(facets.divisions) : buildFacet(items, 'wholesaler')),
    [facets, items]);
  const categoryFacet = useMemo(() => {
    const m = facets ? toMap(facets.categories) : buildFacet(items, 'product_type');
    m.delete('Combo');
    return m;
  }, [facets, items]);
  const brandFacet = useMemo(
    () => (facets ? toMap(facets.brands) : buildFacet(items, 'brand')),
    [facets, items]);
  const sizeFacet = useMemo(() => {
    const base = facets ? toMap(facets.sizes) : buildFacet(items, 'unit_volume');
    return new Map([...base.entries()].sort((a, b) => toMl(a[0]) - toMl(b[0])));
  }, [facets, items]);

  const ripCount = facets?.has_rip ?? items.filter(i => i.has_rip).length;
  const discCount = facets?.has_discount ?? items.filter(i => i.has_discount).length;
  const comboCount = facets?.has_combo ?? items.filter(i => !!i.combo_code && i.combo_code !== '0').length;

  const toggle = (arr: string[], val: string): string[] =>
    arr.includes(val) ? arr.filter(v => v !== val) : [...arr, val];

  const brandEntries = useMemo(() => {
    const entries = [...brandFacet.entries()];
    if (!brandSearch) return entries;
    const q = brandSearch.toLowerCase();
    return entries.filter(([name]) => name.toLowerCase().includes(q));
  }, [brandFacet, brandSearch]);
  const visibleBrands = brandShowAll ? brandEntries : brandEntries.slice(0, 10);

  const total = countActiveFilters(filters);

  const clearAll = () => {
    onChange({ ...emptyCatalogFilters });
    setPriceMin(''); setPriceMax(''); setBrandSearch(''); setBrandShowAll(false);
  };

  return (
    <aside className="prod-filter-rail">
      {/* Collapse handle: a tab on the rail's right edge, vertically centered
          (not tucked in the header) so it sits at the middle of the rail. */}
      {onCollapse && (
        <button type="button" className="prod-filter-collapse-handle" onClick={onCollapse}
                title="Collapse the filter rail" aria-label="Collapse the filter rail">
          <ChevronLeft size={16} />
        </button>
      )}
      <div className="prod-filter-rail-body">
      <div className="prod-filter-rail-head">
        <span className="prod-filter-rail-title"><SlidersHorizontal size={16} /> Filters</span>
        <span className="prod-filter-rail-actions">
          {total > 0 && (
            <button type="button" className="prod-filter-clear" onClick={clearAll}>
              <XCircle size={13} /> Clear ({total})
            </button>
          )}
        </span>
      </div>

      <Section title="Featured">
        {onTrackedChange && (
          <div className="prod-filter-tracked">
            <TrackedOnlyToggle enabled={!!trackedOnly} onChange={onTrackedChange} />
          </div>
        )}
        {/* "In QD" (not the vague "Deals"): this drives hasDiscount, i.e. a
            quantity discount — named like its siblings Has RIP / In combo. */}
        <label className="prod-filter-check" title="Has a volume quantity discount of more than 1 case this edition (1-case QDs excluded — that's just the single-case price)">
          <input type="checkbox" checked={filters.hasDiscount === true}
            onChange={() => onChange({ ...filters, hasDiscount: filters.hasDiscount === true ? undefined : true })} />
          <span>In QD (&gt; 1 CS)</span><span className="prod-filter-count">{discCount}</span>
        </label>
        <label className="prod-filter-check">
          <input type="checkbox" checked={filters.hasRip === true}
            onChange={() => onChange({ ...filters, hasRip: filters.hasRip === true ? undefined : true })} />
          <span>Has RIP</span><span className="prod-filter-count">{ripCount}</span>
        </label>
        <label className="prod-filter-check">
          <input type="checkbox" checked={filters.inCombo === true}
            onChange={() => onChange({ ...filters, inCombo: filters.inCombo ? undefined : true })} />
          <span>In combo</span><span className="prod-filter-count">{comboCount}</span>
        </label>
      </Section>

      {onDealMonthChange && nextMonthLabel && (
        <Section title="RIP / QD month">
          <div className="prod-filter-segmented"
            title="Which month's RIP and QD tiers the cards show. Defaults to the current month; switch to preview next month's deals (loaded early).">
            <button type="button" className={dealMonth === 'current' ? 'on' : ''}
              onClick={() => onDealMonthChange('current')}>{currentMonthLabel || 'This month'}</button>
            <button type="button" className={dealMonth === 'next' ? 'on' : ''}
              onClick={() => onDealMonthChange('next')}>{nextMonthLabel}</button>
          </div>
        </Section>
      )}

      <Section title="Time Sensitive Deals">
        <label className="prod-filter-check"
          title="Only products with a dated (sub-month) QD or RIP window this edition: deals that start or stop mid-month.">
          <input type="checkbox" checked={filters.timeSensitive === true}
            onChange={() => onChange({ ...filters, timeSensitive: filters.timeSensitive ? undefined : true })} />
          <span>Dated deal this month</span>
        </label>
      </Section>

      <Section title="Distributor">
        <div className="prod-filter-list">
          {[...divisionFacet.entries()].map(([div, count]) => (
            <label key={div} className="prod-filter-check">
              <input type="checkbox" checked={filters.divisions.includes(div)}
                onChange={() => onChange({ ...filters, divisions: toggle(filters.divisions, div) })} />
              <span>{distributorName(div)}</span><span className="prod-filter-count">{count}</span>
            </label>
          ))}
        </div>
      </Section>

      <Section title="Frontline price (per case)">
        <p className="prod-filter-hint">Filter products by per-case price range.</p>
        <div className="prod-filter-price">
          <input type="number" placeholder="Min" value={priceMin} onChange={e => setPriceMin(e.target.value)} />
          <span>to</span>
          <input type="number" placeholder="Max" value={priceMax} onChange={e => setPriceMax(e.target.value)} />
          <button type="button" className="btn btn-secondary"
            onClick={() => onChange({
              ...filters,
              priceMin: priceMin ? Number(priceMin) : undefined,
              priceMax: priceMax ? Number(priceMax) : undefined,
            })}>Go</button>
        </div>
      </Section>

      <Section title="Brand">
        <input type="text" className="prod-filter-search" placeholder="Search brands…"
          value={brandSearch} onChange={e => setBrandSearch(e.target.value)} />
        <div className="prod-filter-list">
          {visibleBrands.map(([brand, count]) => (
            <label key={brand} className="prod-filter-check">
              <input type="checkbox" checked={filters.brands.includes(brand)}
                onChange={() => onChange({ ...filters, brands: toggle(filters.brands, brand) })} />
              <span>{brand}</span><span className="prod-filter-count">{count}</span>
            </label>
          ))}
        </div>
        {brandEntries.length > 10 && (
          <button type="button" className="prod-filter-showall" onClick={() => setBrandShowAll(s => !s)}>
            {brandShowAll ? 'Show fewer' : `Show all ${brandEntries.length}…`}
          </button>
        )}
      </Section>

      <Section title="Category">
        <div className="prod-filter-list">
          {[...categoryFacet.entries()].map(([cat, count]) => (
            <label key={cat} className="prod-filter-check">
              <input type="checkbox" checked={filters.categories.includes(cat)}
                onChange={() => onChange({ ...filters, categories: toggle(filters.categories, cat) })} />
              <span>{cat}</span><span className="prod-filter-count">{count}</span>
            </label>
          ))}
        </div>
      </Section>

      <Section title="Size">
        <div className="prod-filter-list">
          {[...sizeFacet.entries()].map(([size, count]) => (
            <label key={size} className="prod-filter-check">
              <input type="checkbox" checked={filters.sizes.includes(size)}
                onChange={() => onChange({ ...filters, sizes: toggle(filters.sizes, size) })} />
              <span>{size}</span><span className="prod-filter-count">{count}</span>
            </label>
          ))}
        </div>
      </Section>
      </div>
    </aside>
  );
}
