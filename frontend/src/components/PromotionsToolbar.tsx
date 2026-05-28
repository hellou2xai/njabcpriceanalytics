import { LayoutGrid, Table as TableIcon } from 'lucide-react';
import RowLimitSelect from './RowLimitSelect';
import SortBySelect, { type SortOption } from './SortBySelect';

/** Shared toolbar for every page under Promotions (Time-Sensitive Deals,
 *  Major Discounts, Price Drops, Price Increases, Top Discounts).
 *  Always shows, in this order: Sort by, Row limit, Showing X of Y,
 *  Cards/Table view toggle. Identical placement and styling everywhere. */
interface Props<V extends string = string> {
  sortValue: V;
  onSortChange: (v: V) => void;
  sortOptions: SortOption<V>[];
  limit: number;
  onLimitChange: (n: number) => void;
  total: number;            // total filtered rows
  shownInCards: number;     // how many are visible in the current card view
  view: 'cards' | 'table';
  onViewChange: (v: 'cards' | 'table') => void;
  noun?: string;            // "deals" | "products" — used in "Showing X of Y deals"
}

export default function PromotionsToolbar<V extends string = string>(p: Props<V>) {
  const shown = p.view === 'table' ? p.total : Math.min(p.shownInCards, p.total);
  const noun = p.noun ?? 'results';
  return (
    <div className="toolbar promo-toolbar" style={{ marginBottom: 12 }}>
      <SortBySelect value={p.sortValue} onChange={p.onSortChange} options={p.sortOptions} />
      <RowLimitSelect value={p.limit} onChange={p.onLimitChange} />
      <span className="text-muted" style={{ fontSize: 12 }}>
        Showing {shown} of {p.total} {noun}
      </span>
      <span className="ts-view-toggle" role="group" aria-label="View mode">
        <button type="button" className={`btn btn-sm ${p.view === 'cards' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => p.onViewChange('cards')} title="Card view">
          <LayoutGrid size={14} /> Cards
        </button>
        <button type="button" className={`btn btn-sm ${p.view === 'table' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => p.onViewChange('table')} title="Table view (every column)">
          <TableIcon size={14} /> Table
        </button>
      </span>
    </div>
  );
}
