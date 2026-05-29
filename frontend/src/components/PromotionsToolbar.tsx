import { LayoutGrid, Table as TableIcon, ChevronLeft, ChevronRight } from 'lucide-react';
import RowLimitSelect from './RowLimitSelect';
import SortBySelect, { type SortOption } from './SortBySelect';

/** Shared toolbar for every page under Promotions (Time-Sensitive Deals,
 *  Major Discounts, Price Drops, Price Increases, Top Discounts).
 *  Always shows, in this order: Sort by, Row limit, Showing X of Y,
 *  Cards/Table view toggle, Prev / page X of N / Next. Identical
 *  placement and styling everywhere. */
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
  // Optional pagination. When `page` and `onPageChange` are set, the toolbar
  // also renders Prev / Next + "Page X of N" so the buyer can reach results
  // beyond the first `limit`. Card view is paginated; table view shows
  // everything (omit the controls in that mode).
  page?: number;            // zero-indexed
  onPageChange?: (p: number) => void;
}

export default function PromotionsToolbar<V extends string = string>(p: Props<V>) {
  const shown = p.view === 'table' ? p.total : Math.min(p.shownInCards, p.total);
  const noun = p.noun ?? 'results';
  const totalPages = Math.max(1, Math.ceil(p.total / Math.max(p.limit, 1)));
  const page = p.page ?? 0;
  const hasPaging = p.onPageChange != null && p.view === 'cards';
  // Showing line gets a per-page range when paging is active so the buyer
  // can tell which slice they're looking at.
  const rangeFrom = page * p.limit;
  const rangeTo = Math.min(rangeFrom + p.limit, p.total);
  return (
    <div className="toolbar promo-toolbar" style={{ marginBottom: 12 }}>
      <SortBySelect value={p.sortValue} onChange={p.onSortChange} options={p.sortOptions} />
      <RowLimitSelect value={p.limit} onChange={(n) => { p.onLimitChange(n); p.onPageChange?.(0); }} />
      <span className="text-muted" style={{ fontSize: 12 }}>
        {hasPaging
          ? `Showing ${rangeFrom + 1}–${rangeTo} of ${p.total.toLocaleString()} ${noun}`
          : `Showing ${shown} of ${p.total.toLocaleString()} ${noun}`}
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
      {hasPaging && totalPages > 1 && (
        <span className="promo-paging" role="group" aria-label="Page navigation">
          <button type="button" className="btn btn-sm btn-secondary"
            disabled={page === 0}
            onClick={() => p.onPageChange?.(page - 1)}
            title="Previous page">
            <ChevronLeft size={14} /> Prev
          </button>
          <span className="text-muted" style={{ fontSize: 12, padding: '0 8px' }}>
            Page {page + 1} of {totalPages}
          </span>
          <button type="button" className="btn btn-sm btn-secondary"
            disabled={page >= totalPages - 1}
            onClick={() => p.onPageChange?.(page + 1)}
            title="Next page">
            Next <ChevronRight size={14} />
          </button>
        </span>
      )}
    </div>
  );
}
