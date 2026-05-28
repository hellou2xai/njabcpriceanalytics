import SortableTable from './SortableTable';
import { distributorName } from '../lib/distributors';

/** The canonical promotion row shape. Every Promotions page adapts its native
 *  rows to this shape before handing them to PromotionsTable, so the table
 *  view is identical across Time-Sensitive Deals, Major Discounts, Price
 *  Drops, Price Increases, and Top Discounts. */
export interface PromotionRow {
  // identity
  product_name: string;
  brand?: string | null;
  wholesaler: string;
  upc?: string | null;
  product_type?: string | null;
  unit_volume?: string | null;
  // standard promotion columns
  type_label: string;                 // "Discount", "Closeout", "Price drop", "Price up"
  from_date?: string | null;          // ISO date "YYYY-MM-DD"
  to_date?: string | null;
  days_to_expire?: number | null;
  orig_case_price?: number | null;
  disc_per_case?: number | null;      // savings per case (always positive)
  net_case_price?: number | null;
  net_btl_price?: number | null;
  gp_pct?: number | null;
  off_pct?: number | null;
  has_rip?: boolean | null;
  has_closeout?: boolean | null;
  ai_blurb?: string | null;
  // optional sticker support (e.g. "1-DAY ONLY", "Active May 2026 only")
  sticker?: { label: string; tone: 'red' | 'orange' | 'blue' | 'green' } | null;
}

function money(v: number | null | undefined): string {
  return v == null ? '-' : `$${Number(v).toFixed(2)}`;
}
function fmtDate(d?: string | null): string {
  if (!d) return '-';
  const [y, m, day] = d.split(/[ T]/)[0].split('-').map(Number);
  if (!y || !m || !day) return d;
  return new Date(y, m - 1, day).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function dayBadge(days: number | null | undefined) {
  if (days == null) return <span className="text-muted">-</span>;
  const colour = days < 0 ? '#6b7280' : days <= 3 ? '#dc2626' : days <= 7 ? '#d97706' : days <= 14 ? '#2563eb' : '#16a34a';
  const label = days < 0 ? `${-days}d ago` : `${days}d`;
  return <span style={{ fontWeight: 700, color: colour }}>{label}</span>;
}
function StickerChip({ s }: { s: PromotionRow['sticker'] }) {
  if (!s) return null;
  const tones: Record<string, { bg: string; fg: string }> = {
    red:    { bg: '#fee2e2', fg: '#b91c1c' },
    orange: { bg: '#ffedd5', fg: '#c2410c' },
    blue:   { bg: '#dbeafe', fg: '#1d4ed8' },
    green:  { bg: '#dcfce7', fg: '#15803d' },
  };
  const t = tones[s.tone] ?? tones.blue;
  return (
    <span style={{
      display: 'inline-block', marginLeft: 6, padding: '1px 6px', borderRadius: 4,
      fontSize: 10, fontWeight: 700, letterSpacing: 0.3, verticalAlign: 'middle',
      whiteSpace: 'nowrap', background: t.bg, color: t.fg,
    }}>{s.label}</span>
  );
}

interface Props {
  rows: PromotionRow[];
  exportName: string;
  onRowClick?: (r: PromotionRow) => void;
}

export default function PromotionsTable({ rows, exportName, onRowClick }: Props) {
  return (
    <div className="dense-table">
      <SortableTable
        data={rows as unknown as Record<string, unknown>[]}
        pageSize={50}
        exportName={exportName}
        onRowClick={(r) => onRowClick?.(r as unknown as PromotionRow)}
        columns={[
          { key: 'product_name', label: 'Product', sortable: true,
            render: r => <span>{r.product_name as string}<StickerChip s={(r as unknown as PromotionRow).sticker ?? null} /></span> },
          { key: 'wholesaler', label: 'Distributor', sortable: true,
            render: r => distributorName(r.wholesaler as string) },
          { key: 'type_label', label: 'Type', sortable: true,
            render: r => <span className="text-muted">{r.type_label as string}</span> },
          { key: 'product_type', label: 'Category', sortable: true,
            render: r => (r.product_type as string | null) ?? '-' },
          { key: 'unit_volume', label: 'Size',
            render: r => (r.unit_volume as string | null) ?? '-' },
          { key: 'from_date', label: 'Starts', sortable: true,
            render: r => fmtDate(r.from_date as string | null) },
          { key: 'to_date', label: 'Ends', sortable: true,
            render: r => fmtDate(r.to_date as string | null) },
          { key: 'days_to_expire', label: 'Days', align: 'right', sortable: true,
            render: r => dayBadge(r.days_to_expire as number | null) },
          { key: 'orig_case_price', label: 'Orig/cs', align: 'right', sortable: true,
            render: r => money(r.orig_case_price as number | null) },
          { key: 'disc_per_case', label: 'Disc/cs', align: 'right', sortable: true,
            exportValue: r => (r.disc_per_case as number | null) ?? '',
            render: r => r.disc_per_case != null
              ? <span className="text-green">{money(r.disc_per_case as number)}</span>
              : '-' },
          { key: 'net_case_price', label: 'Net/cs', align: 'right', sortable: true,
            render: r => money(r.net_case_price as number | null) },
          { key: 'net_btl_price', label: 'Net/btl', align: 'right', sortable: true,
            render: r => money(r.net_btl_price as number | null) },
          { key: 'gp_pct', label: 'GP%', align: 'right', sortable: true,
            sortValue: r => (r.gp_pct as number | null) ?? -999,
            exportValue: r => { const g = r.gp_pct as number | null; return g == null ? '' : Number(g.toFixed(1)); },
            render: r => {
              const g = r.gp_pct as number | null;
              return g == null
                ? <span className="text-muted">-</span>
                : <span style={{ fontWeight: 700, color: 'var(--green)' }}>{g.toFixed(1)}%</span>;
            } },
          { key: 'off_pct', label: '% off', align: 'right', sortable: true,
            render: r => r.off_pct != null ? `${(r.off_pct as number).toFixed(0)}%` : '-' },
          { key: 'has_rip', label: 'RIP', align: 'center',
            exportValue: r => r.has_rip ? 'yes' : '',
            render: r => r.has_rip ? <span className="source-badge source-rip">RIP</span> : '' },
          { key: 'has_closeout', label: 'Closeout', align: 'center',
            exportValue: r => r.has_closeout ? 'yes' : '',
            render: r => r.has_closeout ? <span className="tag tag-orange">Closeout</span> : '' },
          { key: 'ai_blurb', label: 'AI note',
            exportValue: r => (r.ai_blurb as string | null) ?? '',
            render: r => r.ai_blurb
              ? <span title={r.ai_blurb as string} style={{ color: 'var(--accent)', fontSize: 12 }}>✨ hover</span>
              : <span className="text-muted">-</span> },
        ]}
      />
    </div>
  );
}
