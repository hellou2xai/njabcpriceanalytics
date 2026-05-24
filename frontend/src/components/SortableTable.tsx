import { useEffect, useMemo, useState } from 'react';
import { ChevronUp, ChevronDown, ChevronLeft, ChevronRight, Download } from 'lucide-react';
import { downloadCsv } from '../lib/exportTable';
import { RowMenuButton } from './ContextMenu';

interface Column<T> {
  key: string;
  label: string;
  sortable?: boolean;
  render?: (row: T) => React.ReactNode;
  align?: 'left' | 'right' | 'center';
  // Value used when exporting to CSV/Excel. Defaults to row[key]. Provide this
  // for computed/rendered columns whose key isn't a plain field.
  exportValue?: (row: T) => string | number | null | undefined;
  // Value used when sorting. Defaults to row[key]. Provide this for computed
  // columns whose key isn't a plain field.
  sortValue?: (row: T) => string | number | null | undefined;
}

interface Props<T> {
  columns: Column<T>[];
  data: T[];
  onSort?: (key: string, dir: 'asc' | 'desc') => void;
  onRowClick?: (row: T) => void;
  // When set, paginate internally at this page size (sort applies to the FULL
  // data set first, then the current page is shown).
  pageSize?: number;
  // When set, show an "Export to Excel" button that downloads ALL rows
  // (sorted/filtered) as a CSV named <exportName>-<date>.csv.
  exportName?: string;
  // Override how a row maps to a product for the global right-click menu.
  // By default any row with product_name + wholesaler becomes right-clickable.
  getRowProduct?: (row: T) => { product_name: string; wholesaler: string; upc?: string; unit_volume?: string } | null;
  // Show a visible "⋯" actions column on product rows (default true).
  rowActions?: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default function SortableTable<T extends Record<string, any>>({
  columns, data, onSort, onRowClick, pageSize, exportName, getRowProduct, rowActions = true,
}: Props<T>) {
  const productOf = (row: T) => {
    if (getRowProduct) return getRowProduct(row);
    if (row.product_name && row.wholesaler) {
      const upc = row.upc ?? row.a_upc ?? row.upc_norm;
      return {
        product_name: String(row.product_name),
        wholesaler: String(row.wholesaler),
        upc: upc != null ? String(upc) : undefined,
        unit_volume: row.unit_volume != null ? String(row.unit_volume) : undefined,
      };
    }
    return null;
  };
  const [sortKey, setSortKey] = useState('');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [page, setPage] = useState(1);

  const handleSort = (key: string) => {
    const newDir = sortKey === key && sortDir === 'asc' ? 'desc' : 'asc';
    setSortKey(key);
    setSortDir(newDir);
    onSort?.(key, newDir);
  };

  // Sort client-side by the clicked column. When the parent opts into
  // server-side sorting (onSort), leave ordering to it. Until a header is
  // clicked, preserve the incoming order (usually the query's own sort).
  const sortedData = useMemo(() => {
    if (!sortKey || onSort) return data;
    const sortCol = columns.find(c => c.key === sortKey);
    const copy = [...data];
    copy.sort((a, b) => {
      const av = sortCol?.sortValue ? sortCol.sortValue(a) : a[sortKey];
      const bv = sortCol?.sortValue ? sortCol.sortValue(b) : b[sortKey];
      const aNull = av == null || av === '';
      const bNull = bv == null || bv === '';
      if (aNull && bNull) return 0;
      if (aNull) return 1;   // nulls/blanks always last
      if (bNull) return -1;
      let cmp: number;
      if (typeof av === 'number' && typeof bv === 'number') {
        cmp = av - bv;
      } else {
        cmp = String(av).localeCompare(String(bv), undefined, { numeric: true });
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return copy;
  }, [data, sortKey, sortDir, onSort, columns]);

  // Reset to the first page whenever the result set or ordering changes.
  const total = sortedData.length;
  const totalPages = pageSize ? Math.max(1, Math.ceil(total / pageSize)) : 1;
  useEffect(() => { setPage(1); }, [total, sortKey, sortDir]);
  const safePage = Math.min(page, totalPages);
  const pagedData = pageSize
    ? sortedData.slice((safePage - 1) * pageSize, safePage * pageSize)
    : sortedData;

  const handleExport = () => {
    downloadCsv(
      exportName || 'export',
      columns.map(c => ({ key: c.key, label: c.label, exportValue: c.exportValue })),
      sortedData,
    );
  };

  const showToolbar = !!exportName;
  const showPager = !!pageSize && total > pageSize;
  const showActions = rowActions && sortedData.some(r => !!productOf(r));

  return (
    <div>
      {showToolbar && (
        <div className="table-toolbar">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={handleExport}
            disabled={total === 0}
            title="Download all rows as an Excel-compatible CSV"
          >
            <Download size={14} /> Export to Excel
          </button>
        </div>
      )}
      <div className="table-container">
        <table>
          <thead>
            <tr>
              {columns.map(col => (
                <th
                  key={col.key}
                  className={col.sortable ? 'sortable' : ''}
                  style={{ textAlign: col.align ?? 'left' }}
                  onClick={() => col.sortable && handleSort(col.key)}
                >
                  {col.label}
                  {col.sortable && sortKey === col.key && (
                    sortDir === 'asc' ? <ChevronUp size={14} /> : <ChevronDown size={14} />
                  )}
                </th>
              ))}
              {showActions && <th className="col-actions" aria-label="Actions" />}
            </tr>
          </thead>
          <tbody>
            {pagedData.map((row, i) => {
              const p = productOf(row);
              return (
              <tr
                key={i}
                onClick={() => onRowClick?.(row)}
                className={onRowClick ? 'clickable' : ''}
                data-ctx={p ? '' : undefined}
                data-ctx-product={p?.product_name}
                data-ctx-wholesaler={p?.wholesaler}
                data-ctx-upc={p?.upc}
                data-ctx-volume={p?.unit_volume}
              >
                {columns.map(col => (
                  <td key={col.key} style={{ textAlign: col.align ?? 'left' }}>
                    {col.render ? col.render(row) : String(row[col.key] ?? '')}
                  </td>
                ))}
                {showActions && (
                  <td className="col-actions">{p ? <RowMenuButton product={p} /> : null}</td>
                )}
              </tr>
              );
            })}
            {total === 0 && (
              <tr><td colSpan={columns.length + (showActions ? 1 : 0)} className="empty">No data</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {showPager && (
        <div className="table-pager">
          <button
            type="button" className="btn btn-secondary btn-sm"
            onClick={() => setPage(p => Math.max(1, p - 1))}
            disabled={safePage <= 1}
          >
            <ChevronLeft size={14} /> Prev
          </button>
          <span className="table-pager-info">
            {(safePage - 1) * pageSize! + 1}–{Math.min(safePage * pageSize!, total)} of {total.toLocaleString()}
          </span>
          <button
            type="button" className="btn btn-secondary btn-sm"
            onClick={() => setPage(p => Math.min(totalPages, p + 1))}
            disabled={safePage >= totalPages}
          >
            Next <ChevronRight size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
