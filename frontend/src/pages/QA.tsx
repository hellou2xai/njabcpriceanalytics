import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { qa, type QaFinding } from '../lib/api';
import SortableTable from '../components/SortableTable';
import WholesalerFilter from '../components/WholesalerFilter';
import { distributorName } from '../lib/distributors';
import { ShieldCheck, RefreshCw } from 'lucide-react';

const SEV_RANK: Record<string, number> = { high: 3, medium: 2, low: 1 };
const SEV_CLASS: Record<string, string> = { high: 'qa-sev-high', medium: 'qa-sev-med', low: 'qa-sev-low' };

const ROOT_CAUSE_LABEL: Record<string, string> = {
  vintage_change: 'Vintage change',
  pack_size_change: 'Pack-size change',
  promo_change: 'Promo change',
  stub_or_invalid_upc: 'Stub/invalid UPC',
  genuine_price_change: 'Genuine price change',
  vintage_mismatch: 'Vintage mismatch',
  ambiguous_upc: 'Ambiguous UPC',
  pack_or_volume_mismatch: 'Pack/volume mismatch',
  pack_size_missing: 'Pack size missing (name says pack, qty=1)',
  vintage_placeholder_dupe: 'Vintage placeholder duplicate',
  genuine_arbitrage: 'Cross-distributor gap',
  calculation_bug: 'Calculation bug',
};

const fmtPct = (v: number | null | undefined) =>
  v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`;

export default function QA() {
  const [threshold, setThreshold] = useState(5); // percent
  const [wholesaler, setWholesaler] = useState('');
  const [severity, setSeverity] = useState<'all' | 'high' | 'medium' | 'low'>('all');
  const [rootCause, setRootCause] = useState('');

  const { data, isFetching, refetch } = useQuery({
    queryKey: ['qa-scan', threshold, wholesaler],
    queryFn: () => qa.scan({
      threshold: threshold / 100,
      wholesaler: wholesaler || undefined,
      limit: 500,
    }),
  });

  const findings = useMemo(() => data?.findings ?? [], [data]);
  const rootCauses = useMemo(
    () => [...new Set(findings.map(f => f.root_cause))].sort(),
    [findings],
  );

  const filtered = useMemo(() => findings.filter(f =>
    (severity === 'all' || f.severity === severity) &&
    (!rootCause || f.root_cause === rootCause)
  ), [findings, severity, rootCause]);

  const summary = data?.summary;

  return (
    <div className="page">
      <div className="qa-header">
        <h2 style={{ display: 'flex', alignItems: 'center', gap: 8, margin: 0 }}>
          <ShieldCheck size={22} /> Agentic QA — Data Quality
        </h2>
        <p className="text-muted" style={{ margin: '4px 0 0', fontSize: 13 }}>
          Flags any variance above the threshold (price moves, cross-distributor gaps) and
          diagnoses a probable root cause with evidence and a suggested fix.
        </p>
      </div>

      <div className="qa-controls">
        <label className="qa-control">
          <span>Variance threshold</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="number" min={0} step={1} value={threshold}
              onChange={e => setThreshold(Math.max(0, Number(e.target.value)))}
              className="tile-filter-num" />
            <span className="text-muted">%</span>
          </div>
        </label>
        <label className="qa-control">
          <span>Distributor</span>
          <WholesalerFilter value={wholesaler} onChange={setWholesaler} />
        </label>
        <button className="btn btn-secondary btn-sm" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw size={14} className={isFetching ? 'spin' : ''} /> {isFetching ? 'Scanning…' : 'Re-scan'}
        </button>
      </div>

      {summary && (
        <div className="qa-summary-grid">
          <SummaryCard label="Findings" value={summary.total} accent="#3b82f6" active={severity === 'all' && !rootCause} onClick={() => { setSeverity('all'); setRootCause(''); }} />
          <SummaryCard label="High" value={summary.by_severity?.high ?? 0} accent="#ef4444" active={severity === 'high'} onClick={() => setSeverity(severity === 'high' ? 'all' : 'high')} />
          <SummaryCard label="Medium" value={summary.by_severity?.medium ?? 0} accent="#f59e0b" active={severity === 'medium'} onClick={() => setSeverity(severity === 'medium' ? 'all' : 'medium')} />
          <SummaryCard label="Low" value={summary.by_severity?.low ?? 0} accent="#10b981" active={severity === 'low'} onClick={() => setSeverity(severity === 'low' ? 'all' : 'low')} />
        </div>
      )}

      <div className="qa-rootcause-chips">
        <button className={`qa-chip ${!rootCause ? 'active' : ''}`} onClick={() => setRootCause('')}>
          All causes
        </button>
        {rootCauses.map(rc => (
          <button key={rc} className={`qa-chip ${rootCause === rc ? 'active' : ''}`} onClick={() => setRootCause(rootCause === rc ? '' : rc)}>
            {ROOT_CAUSE_LABEL[rc] ?? rc} <span className="qa-chip-count">{summary?.by_root_cause?.[rc] ?? ''}</span>
          </button>
        ))}
      </div>

      <SortableTable<QaFinding & { severity_rank: number }>
        data={filtered.map(f => ({ ...f, severity_rank: SEV_RANK[f.severity] ?? 0 }))}
        pageSize={25}
        exportName="qa-findings"
        columns={[
          { key: 'severity_rank', label: 'Severity', sortable: true,
            exportValue: r => r.severity,
            render: r => <span className={`qa-sev ${SEV_CLASS[r.severity]}`}>{r.severity}</span> },
          { key: 'product_name', label: 'Product', sortable: true,
            render: r => (
              <div>
                <div style={{ fontWeight: 600 }}>{r.product_name}</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  {distributorName(r.wholesaler)}{r.upc ? ` · ${r.upc}` : ''}{r.unit_volume ? ` · ${r.unit_volume}` : ''}{r.vintage ? ` · ${r.vintage}` : ''}
                </div>
              </div>
            ) },
          { key: 'variance_pct', label: 'Variance', align: 'right', sortable: true,
            render: r => <span className={r.variance_pct && r.variance_pct < 0 ? 'text-green' : 'text-yellow'}>{fmtPct(r.variance_pct)}</span> },
          { key: 'root_cause', label: 'Root cause', sortable: true,
            exportValue: r => ROOT_CAUSE_LABEL[r.root_cause] ?? r.root_cause,
            render: r => <span className="qa-rootcause">{ROOT_CAUSE_LABEL[r.root_cause] ?? r.root_cause}</span> },
          { key: 'root_cause_detail', label: 'Diagnosis',
            render: r => <span style={{ fontSize: 12 }}>{r.root_cause_detail}</span> },
          { key: 'suggested_fix', label: 'Suggested fix',
            render: r => <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{r.suggested_fix}</span> },
        ]}
      />
    </div>
  );
}

function SummaryCard({ label, value, accent, active, onClick }: {
  label: string; value: number; accent: string; active: boolean; onClick: () => void;
}) {
  return (
    <button type="button" className={`qa-summary-card ${active ? 'active' : ''}`} style={{ borderColor: active ? accent : undefined }} onClick={onClick}>
      <span className="qa-summary-value" style={{ color: accent }}>{value.toLocaleString()}</span>
      <span className="qa-summary-label">{label}</span>
    </button>
  );
}
