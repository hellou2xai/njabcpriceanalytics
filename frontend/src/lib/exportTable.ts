// Excel-compatible CSV export shared by every data table (primary pages + tile
// popups). CSV (with a UTF-8 BOM) opens directly in Excel and needs no extra
// dependency. Columns mirror a SortableTable column: { key, label } plus an
// optional exportValue() for computed/rendered cells.

export interface ExportColumn<T = Record<string, unknown>> {
  key: string;
  label: string;
  exportValue?: (row: T) => string | number | null | undefined;
}

function csvEscape(value: unknown): string {
  const s = value == null ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function buildCsv<T extends Record<string, unknown>>(
  columns: ExportColumn<T>[],
  rows: T[],
): string {
  const header = columns.map(c => csvEscape(c.label)).join(',');
  const body = rows.map(row =>
    columns
      .map(c => csvEscape(c.exportValue ? c.exportValue(row) : (row as Record<string, unknown>)[c.key]))
      .join(',')
  );
  return [header, ...body].join('\r\n');
}

export function downloadCsv<T extends Record<string, unknown>>(
  filenameBase: string,
  columns: ExportColumn<T>[],
  rows: T[],
): void {
  // Leading BOM so Excel detects UTF-8 (keeps accented brand names intact).
  const csv = '﻿' + buildCsv(columns, rows);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${filenameBase}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
