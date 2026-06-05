import { useQuery } from '@tanstack/react-query';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
} from 'recharts';
import { Database } from 'lucide-react';
import { agents, type PosRow } from '../lib/api';

// Admin-only: what the store's POS feed says. This is the demand side the
// agents reason from - velocity, days of cover, lapsed items. Currently the
// synthetic Planet of Wine feed; a real POS export lands in the same tables.
const money = (v?: number | null) => `$${(Number(v) || 0).toLocaleString()}`;
const num = (v?: number | null) => (Number(v) || 0).toLocaleString();

function PosTable({ rows, cols }: {
  rows: PosRow[];
  cols: { key: string; label: string; right?: boolean; render?: (r: PosRow) => React.ReactNode }[];
}) {
  return (
    <div className="table-container">
      <table className="catalog-table">
        <thead>
          <tr>{cols.map(c => <th key={c.key} className={c.right ? 'right' : undefined}>{c.label}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.upc}-${i}`}>
              {cols.map(c => (
                <td key={c.key} className={c.right ? 'right' : undefined}>
                  {c.render ? c.render(r) : String((r as unknown as Record<string, unknown>)[c.key] ?? '')}
                </td>
              ))}
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={cols.length} className="empty">No rows.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

const sourceCell = (r: PosRow) => r.wholesaler
  ? <>{r.wholesaler} <span className="text-muted">{money(r.effective_case_price)}/cs</span>
      {r.has_rip ? <span className="tag tag-green" style={{ marginLeft: 4 }}>RIP</span> : null}
      {r.has_discount ? <span className="tag tag-blue" style={{ marginLeft: 4 }}>disc</span> : null}</>
  : <span className="tag tag-red">no source</span>;

export default function AgentStoreFeed() {
  const { data: summary } = useQuery({ queryKey: ['pos-summary'], queryFn: agents.posSummary });
  const { data: velocity } = useQuery({ queryKey: ['pos-velocity'], queryFn: () => agents.posVelocity(25) });
  const { data: lowStock } = useQuery({ queryKey: ['pos-low-stock'], queryFn: () => agents.posLowStock(14, 25) });
  const { data: lapsed } = useQuery({ queryKey: ['pos-lapsed'], queryFn: () => agents.posLapsed(60, 25) });

  const t = summary?.totals ?? {};
  return (
    <div className="page">
      <div className="orders-header">
        <h2><Database size={20} style={{ verticalAlign: -3, marginRight: 6 }} />Store Feed</h2>
        <span className="text-muted" style={{ fontSize: 13 }}>
          {summary?.store ? `${summary.store.name} · ${summary.store.city ?? ''} ${summary.store.state ?? ''}` : 'POS sell-through'}
          {summary?.last_feed && ` · last feed: ${summary.last_feed.source} (${num(summary.last_feed.rows_ingested)} rows, through ${summary.last_feed.period_end})`}
        </span>
      </div>

      <div className="ai-usage-cards">
        <div className="ai-usage-card"><span>Active SKUs</span><strong>{num(t.skus)}</strong></div>
        <div className="ai-usage-card"><span>Units sold (history)</span><strong>{num(t.units)}</strong></div>
        <div className="ai-usage-card"><span>Revenue (history)</span><strong>{money(t.revenue)}</strong></div>
        <div className="ai-usage-card"><span>Coverage</span><strong style={{ fontSize: 14 }}>{t.first_sale} → {t.last_sale}</strong></div>
      </div>

      <h4>Revenue by month (last 12)</h4>
      <div style={{ height: 220, background: 'var(--surface)', borderRadius: 'var(--radius)', padding: 12, boxShadow: 'var(--shadow-card)' }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={summary?.months ?? []}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="ym" fontSize={11} />
            <YAxis fontSize={11} tickFormatter={v => `$${(v / 1000).toFixed(0)}k`} />
            <Tooltip formatter={v => money(Number(v))} />
            <Bar dataKey="revenue" fill="#2563eb" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <h4 style={{ marginTop: 20 }}>Running low <span className="text-muted" style={{ fontSize: 11, fontWeight: 400 }}>(≤ 14 days of cover - the agents' first priority)</span></h4>
      <PosTable rows={lowStock?.rows ?? []} cols={[
        { key: 'product_name', label: 'Product' },
        { key: 'category', label: 'Category' },
        { key: 'units_per_day', label: 'Units/day', right: true },
        { key: 'on_hand_units', label: 'On hand', right: true },
        { key: 'days_of_cover', label: 'Days cover', right: true, render: r => <span className="text-red font-bold">{r.days_of_cover}</span> },
        { key: 'source', label: 'Cheapest source', render: sourceCell },
      ]} />

      <h4 style={{ marginTop: 20 }}>Top movers <span className="text-muted" style={{ fontSize: 11, fontWeight: 400 }}>(last 90 days)</span></h4>
      <PosTable rows={velocity?.rows ?? []} cols={[
        { key: 'product_name', label: 'Product' },
        { key: 'category', label: 'Category' },
        { key: 'units_per_day', label: 'Units/day', right: true },
        { key: 'unit_retail', label: 'Retail', right: true, render: r => money(r.unit_retail) },
        { key: 'days_of_cover', label: 'Days cover', right: true },
        { key: 'source', label: 'Cheapest source', render: sourceCell },
      ]} />

      <h4 style={{ marginTop: 20 }}>Lapsed items <span className="text-muted" style={{ fontSize: 11, fontWeight: 400 }}>(sold steadily before, nothing in 60+ days)</span></h4>
      <PosTable rows={lapsed?.rows ?? []} cols={[
        { key: 'product_name', label: 'Product' },
        { key: 'category', label: 'Category' },
        { key: 'lifetime_units', label: 'Lifetime units', right: true },
        { key: 'last_sale', label: 'Last sale' },
        { key: 'source', label: 'Available now?', render: r => r.still_available ? sourceCell(r) : <span className="tag tag-gray">gone from CPL</span> },
      ]} />
    </div>
  );
}
