import { useState, useEffect, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight, Filter as FilterIcon } from 'lucide-react';

export type FilterOption = { label: string; value: string; count?: number };

export type FilterSection =
  | {
      type: 'pills';
      key: string;
      title: string;
      options: FilterOption[];
      value: string;
      onChange: (v: string) => void;
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
    };

interface FilterSidebarProps {
  storageKey: string;
  sections: FilterSection[];
  onReset?: () => void;
  children: ReactNode;
}

export default function FilterSidebar({ storageKey, sections, onReset, children }: FilterSidebarProps) {
  const lsKey = `filter_sidebar_${storageKey}`;
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    return localStorage.getItem(lsKey) === 'true';
  });

  useEffect(() => {
    localStorage.setItem(lsKey, String(collapsed));
  }, [collapsed, lsKey]);

  return (
    <div className={`page-with-filters ${collapsed ? 'filters-collapsed' : ''}`}>
      <aside className="filter-sidebar">
        <div className="filter-sidebar-header">
          {!collapsed && (
            <>
              <span className="filter-sidebar-title">
                <FilterIcon size={14} /> Filters
              </span>
              {onReset && (
                <button className="filter-reset-btn" onClick={onReset} type="button">
                  Reset
                </button>
              )}
            </>
          )}
          <button
            className="filter-sidebar-toggle"
            onClick={() => setCollapsed(c => !c)}
            title={collapsed ? 'Show filters' : 'Hide filters'}
            type="button"
          >
            {collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
          </button>
        </div>

        {!collapsed && (
          <div className="filter-sidebar-body">
            {sections.map(s => (
              <FilterSectionBlock key={s.key} section={s} />
            ))}
          </div>
        )}
      </aside>

      <div className="page-with-filters-main">
        {children}
      </div>
    </div>
  );
}

function FilterSectionBlock({ section: s }: { section: FilterSection }) {
  return (
    <div className="filter-section">
      <div className="filter-section-title">{s.title}</div>
      <div className="filter-section-body">
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
