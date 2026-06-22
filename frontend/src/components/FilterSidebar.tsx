import { useState, useEffect, type ReactNode } from 'react';
import { ChevronLeft, ChevronUp, SlidersHorizontal, XCircle, X } from 'lucide-react';
import { useIsMobile } from '../hooks/useIsMobile';

export type FilterOption = { label: string; value: string; count?: number };

// `highlight` lets a page mark one section (e.g. a Display toggle) as the
// primary thing the user should notice. Highlighted sections render with an
// accent tint and PIN to the TOP of the rail, so a key toggle like
// "Group by Case Mix RIP" is the first thing seen and stays put.
// `defaultCollapsed` starts a section closed (e.g. the Distributors list, which
// is long now that there are many distributors); the head still shows an
// active-count badge so a collapsed-but-applied filter stays visible.
type CommonSectionProps = { highlight?: boolean; defaultCollapsed?: boolean };
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
 * The app's single, shared filter control: a collapsible VERTICAL LEFT RAIL
 * pinned beside the page content. Every list/analysis page uses this so the
 * filtering experience looks and behaves identically across the app (it reuses
 * the same `prod-filter-*` rail skin the Catalog/Products rail uses).
 *
 * The section-model prop API (`sections[]` of pills / multi-pills / select /
 * text / range / toggle / custom, plus `storageKey`, `onReset`, `children`) is
 * unchanged from the previous horizontal-toolbar layout, so pages that already
 * passed sections pick up the rail with no edits. Pages pass their results as
 * `children`; the rail owns the 2-column grid and the collapse/expand state.
 */
export default function FilterSidebar({ storageKey, sections, onReset, children }: FilterSidebarProps) {
  const lsKey = `filter_toolbar_${storageKey}`;
  const isMobile = useIsMobile();
  // On mobile the rail is a slide-over drawer, HIDDEN by default; on desktop it
  // honours the saved collapse preference.
  const [collapsed, setCollapsed] = useState<boolean>(() =>
    (typeof window !== 'undefined' && window.matchMedia('(max-width: 1023px)').matches)
      ? true : localStorage.getItem(lsKey) === 'true');
  // Persist the preference only on desktop (the drawer's open state is transient).
  useEffect(() => { if (!isMobile) localStorage.setItem(lsKey, String(collapsed)); }, [collapsed, lsKey, isMobile]);
  // Collapse the drawer whenever we drop to mobile so it never blocks content.
  useEffect(() => { if (isMobile) setCollapsed(true); }, [isMobile]);
  const drawer = isMobile && !collapsed;

  // Highlighted sections pin to the TOP of the rail, then everything else keeps
  // its given order.
  const ordered = [...sections.filter(s => s.highlight), ...sections.filter(s => !s.highlight)];

  if (collapsed) {
    return (
      <div className="filter-rail-layout filter-rail-layout--collapsed">
        <button
          type="button"
          className="prod-rail-reopen"
          onClick={() => setCollapsed(false)}
          title="Show filters"
          aria-label="Show filters"
        >
          <SlidersHorizontal size={16} />
          <span className="prod-rail-reopen-label">Filters</span>
        </button>
        <div className="filter-rail-main">{children}</div>
      </div>
    );
  }

  return (
    <div className={`filter-rail-layout${drawer ? ' filter-rail-layout--drawer' : ''}`}>
      {drawer && <div className="filter-rail-backdrop" onClick={() => setCollapsed(true)} />}
      <aside className={`prod-filter-rail${drawer ? ' prod-filter-rail--drawer' : ''}`}>
        <button
          type="button"
          className={`prod-filter-collapse-handle${drawer ? ' prod-filter-collapse-handle--drawer' : ''}`}
          onClick={() => setCollapsed(true)}
          title="Collapse the filter rail"
          aria-label="Collapse the filter rail"
        >
          {drawer ? <X size={18} /> : <ChevronLeft size={16} />}
        </button>
        <div className="prod-filter-rail-body">
          <div className="prod-filter-rail-head">
            <span className="prod-filter-rail-title"><SlidersHorizontal size={16} /> Filters</span>
            <span className="prod-filter-rail-actions">
              {onReset && (
                <button type="button" className="prod-filter-clear" onClick={onReset} title="Clear all filters on this page">
                  <XCircle size={13} /> Clear all
                </button>
              )}
            </span>
          </div>
          {ordered.map(s => (
            <FilterRailSection key={s.key} section={s} />
          ))}
        </div>
      </aside>
      <div className="filter-rail-main">{children}</div>
    </div>
  );
}

/** One collapsible rail section: an accordion head (the section title) over the
    control body. Highlighted sections render with the accent tint. */
function FilterRailSection({ section: s }: { section: FilterSection }) {
  const [open, setOpen] = useState(!s.defaultCollapsed);
  // Number of active selections, surfaced as a head badge so a collapsed filter
  // still shows it's applied (multi-pills = how many picked; pills/select = 1
  // when a non-empty value is chosen).
  const badge = s.type === 'multi-pills' ? s.values.length
    : (s.type === 'pills' || s.type === 'select') ? (s.value ? 1 : 0)
    : 0;
  return (
    <div className={`prod-filter-sect${open ? '' : ' is-collapsed'}${s.highlight ? ' is-highlight' : ''}`}>
      <button type="button" className="prod-filter-sect-head" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <span>{s.title}{badge ? <span className="prod-filter-sect-badge">{badge}</span> : null}</span>
        <ChevronUp size={15} className={`prod-filter-chev${open ? '' : ' is-collapsed'}`} />
      </button>
      {open && (
        <div className="prod-filter-sect-body">
          <FilterSectionControl section={s} />
        </div>
      )}
    </div>
  );
}

/** The control for a section, by type. Unchanged from the prior toolbar so
    every section behaves exactly as before — only the chrome around it moved
    from a horizontal toolbar to the vertical rail. */
function FilterSectionControl({ section: s }: { section: FilterSection }) {
  return (
    <>
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
    </>
  );
}
