import { useState, useEffect, type ReactNode } from 'react';
import { ChevronDown, ChevronUp, Filter as FilterIcon, XCircle } from 'lucide-react';

export type FilterOption = { label: string; value: string; count?: number };

// `highlight` lets a page mark one section (e.g. a Display toggle) as the
// primary thing the user should notice. Highlighted sections render with an
// accent border + tint, pin to the LEFT of the toolbar, and keep their place
// even when the toolbar is collapsed.
type CommonSectionProps = { highlight?: boolean };
export type FilterSection = CommonSectionProps & (
  | {
      type: 'pills';
      key: string;
      title: string;
      options: FilterOption[];
      value: string;
      onChange: (v: string) => void;
    }
  | {
      // Multi-select pill group. Clicking a pill toggles its value in / out
      // of `values`. Used by Price Drops / Increases for the Size filter
      // so the buyer can pick "750ML + 1.75L + 50ML" in one go without
      // typing into a text input.
      type: 'multi-pills';
      key: string;
      title: string;
      options: FilterOption[];
      values: string[];
      onChange: (v: string[]) => void;
    }
  | {
      type: 'select';
      key: string;
      title: string;
      options: FilterOption[];
      value: string;
      onChange: (v: string) => void;
      placeholder?: string;
    }
  | {
      type: 'text';
      key: string;
      title: string;
      value: string;
      onChange: (v: string) => void;
      placeholder?: string;
    }
  | {
      type: 'range';
      key: string;
      title: string;
      min: string;
      max: string;
      onMinChange: (v: string) => void;
      onMaxChange: (v: string) => void;
      minPlaceholder?: string;
      maxPlaceholder?: string;
    }
  | {
      type: 'toggle';
      key: string;
      title: string;
      value: boolean;
      onChange: (v: boolean) => void;
      label: string;
    }
  | {
      type: 'custom';
      key: string;
      title: string;
      render: () => ReactNode;
    }
);

interface FilterSidebarProps {
  storageKey: string;
  sections: FilterSection[];
  onReset?: () => void;
  children: ReactNode;
}

/**
 * Horizontal filter toolbar pinned above the page content.
 *
 * Replaced the prior vertical sidebar so list pages get their full width back
 * for the data. The component name and prop API stay the same so every page
 * already using it (Combos, Clearance, Discounts, MajorDiscounts, PriceMovers,
 * RipProducts, Rips, ...) picks up the new layout without changes.
 *
 * Sections lay out as labelled inline controls that wrap to additional rows
 * on narrow screens; a Clear/Reset action is anchored on the LEFT so it's the
 * first thing users see, matching the user's "Clear all filters tagged in the
 * horizontal menu on the left" request. A right-aligned Hide toggle collapses
 * the toolbar to a single row when the user wants the data to take over.
 */
export default function FilterSidebar({ storageKey, sections, onReset, children }: FilterSidebarProps) {
  const lsKey = `filter_toolbar_${storageKey}`;
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    const stored = localStorage.getItem(lsKey);
    return stored === 'true';
  });

  useEffect(() => {
    localStorage.setItem(lsKey, String(collapsed));
  }, [collapsed, lsKey]);

  // Highlighted sections are pinned to the LEFT, immediately after the Clear
  // action, so the user can't miss them. Everything else keeps its original
  // order on the right.
  const highlightedSections = sections.filter(s => s.highlight);
  const regularSections = sections.filter(s => !s.highlight);

  return (
    <div className="page-with-filters horizontal">
      <div className={`filter-toolbar ${collapsed ? 'is-collapsed' : ''}`}>
        <div className="filter-toolbar-row">
          {onReset && (
            <button
              className="filter-toolbar-clear"
              onClick={onReset}
              type="button"
              title="Clear all filters on this page"
            >
              <XCircle size={14} /> Clear all filters
            </button>
          )}
          {!onReset && (
            <span className="filter-toolbar-label">
              <FilterIcon size={14} /> Filters
            </span>
          )}

          {/* Highlighted sections stay visible even when the rest are hidden,
              so a key toggle like "Group by Case Mix RIP" is always reachable. */}
          {highlightedSections.length > 0 && (
            <div className="filter-toolbar-sections is-highlight">
              {highlightedSections.map(s => (
                <FilterSectionInline key={s.key} section={s} />
              ))}
            </div>
          )}

          {!collapsed && regularSections.length > 0 && (
            <div className="filter-toolbar-sections">
              {regularSections.map(s => (
                <FilterSectionInline key={s.key} section={s} />
              ))}
            </div>
          )}

          <button
            className="filter-toolbar-toggle"
            onClick={() => setCollapsed(c => !c)}
            title={collapsed ? 'Show filters' : 'Hide filters'}
            type="button"
          >
            {collapsed
              ? (<><ChevronDown size={14} /> Show filters</>)
              : (<><ChevronUp size={14} /> Hide</>)}
          </button>
        </div>
      </div>

      <div className="page-with-filters-main">
        {children}
      </div>
    </div>
  );
}

function FilterSectionInline({ section: s }: { section: FilterSection }) {
  return (
    <div className={`filter-toolbar-section${s.highlight ? ' is-highlight' : ''}`} data-section-type={s.type}>
      <div className="filter-toolbar-section-title">{s.title}</div>
      <div className="filter-toolbar-section-body">
        {s.type === 'pills' && (
          <div className="filter-pills">
            {s.options.map(opt => (
              <button
                key={opt.value}
                className={`filter-pill ${s.value === opt.value ? 'active' : ''}`}
                onClick={() => s.onChange(opt.value)}
                type="button"
              >
                {opt.label}
                {opt.count != null && <span className="filter-pill-count">{opt.count}</span>}
              </button>
            ))}
          </div>
        )}

        {s.type === 'multi-pills' && (
          <div className="filter-pills">
            {s.options.map(opt => {
              const active = s.values.includes(opt.value);
              return (
                <button
                  key={opt.value}
                  className={`filter-pill ${active ? 'active' : ''}`}
                  onClick={() => {
                    if (active) s.onChange(s.values.filter(v => v !== opt.value));
                    else s.onChange([...s.values, opt.value]);
                  }}
                  type="button"
                >
                  {opt.label}
                  {opt.count != null && <span className="filter-pill-count">{opt.count}</span>}
                </button>
              );
            })}
          </div>
        )}

        {s.type === 'select' && (
          <select
            className="filter-select"
            value={s.value}
            onChange={e => s.onChange(e.target.value)}
          >
            {s.placeholder !== undefined && <option value="">{s.placeholder}</option>}
            {s.options.map(opt => (
              <option key={opt.value} value={opt.value}>
                {opt.label}{opt.count != null ? ` (${opt.count})` : ''}
              </option>
            ))}
          </select>
        )}

        {s.type === 'text' && (
          <input
            type="text"
            className="filter-text"
            placeholder={s.placeholder}
            value={s.value}
            onChange={e => s.onChange(e.target.value)}
          />
        )}

        {s.type === 'range' && (
          <div className="filter-range">
            <input
              type="number"
              className="filter-range-input"
              placeholder={s.minPlaceholder ?? 'Min'}
              value={s.min}
              onChange={e => s.onMinChange(e.target.value)}
            />
            <span className="filter-range-sep">to</span>
            <input
              type="number"
              className="filter-range-input"
              placeholder={s.maxPlaceholder ?? 'Max'}
              value={s.max}
              onChange={e => s.onMaxChange(e.target.value)}
            />
          </div>
        )}

        {s.type === 'toggle' && (
          <label className="filter-toggle">
            <input
              type="checkbox"
              checked={s.value}
              onChange={e => s.onChange(e.target.checked)}
            />
            <span>{s.label}</span>
          </label>
        )}

        {s.type === 'custom' && s.render()}
      </div>
    </div>
  );
}
