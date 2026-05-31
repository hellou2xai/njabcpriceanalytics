import { ChevronLeft, ChevronRight } from 'lucide-react';

/** Standalone Prev / "Page X of N" / Next control. The same pager lives at the
 *  TOP (inside PromotionsToolbar); this renders it again at the BOTTOM of the
 *  card grid so the buyer can page on without scrolling back up. Only shows in
 *  card view and only when there is more than one page. */
interface Props {
  page: number;            // zero-indexed
  total: number;           // total filtered rows
  limit: number;           // rows per page
  onPageChange: (p: number) => void;
  view: 'cards' | 'table';
}

export default function PromotionsPager({ page, total, limit, onPageChange, view }: Props) {
  const totalPages = Math.max(1, Math.ceil(total / Math.max(limit, 1)));
  if (view !== 'cards' || totalPages <= 1) return null;
  const rangeFrom = page * limit;
  const rangeTo = Math.min(rangeFrom + limit, total);
  return (
    <div className="promo-paging-bottom" role="group" aria-label="Page navigation">
      <button type="button" className="btn btn-sm btn-secondary"
        disabled={page === 0}
        onClick={() => onPageChange(page - 1)}
        title="Previous page">
        <ChevronLeft size={14} /> Prev
      </button>
      <span className="text-muted" style={{ fontSize: 12, padding: '0 8px' }}>
        Showing {rangeFrom + 1}–{rangeTo} of {total.toLocaleString()} · Page {page + 1} of {totalPages}
      </span>
      <button type="button" className="btn btn-sm btn-secondary"
        disabled={page >= totalPages - 1}
        onClick={() => onPageChange(page + 1)}
        title="Next page">
        Next <ChevronRight size={14} />
      </button>
    </div>
  );
}
