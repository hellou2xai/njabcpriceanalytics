import { ArrowUpDown } from 'lucide-react';

/** Top-of-page "Sort by" dropdown used across the Promotions pages.
 *  A plain native <select> behind a small icon: matches the existing toolbar
 *  controls (RowLimitSelect) and works on mobile + keyboard out of the box. */
export interface SortOption<V extends string = string> {
  value: V;
  label: string;
}

interface Props<V extends string = string> {
  value: V;
  onChange: (v: V) => void;
  options: SortOption<V>[];
}

export default function SortBySelect<V extends string = string>({ value, onChange, options }: Props<V>) {
  return (
    <label className="sort-by-select" title="Sort results">
      <ArrowUpDown size={14} aria-hidden />
      <span className="sort-by-label">Sort by</span>
      <select value={value} onChange={(e) => onChange(e.target.value as V)} aria-label="Sort by">
        {options.map(o => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </label>
  );
}
