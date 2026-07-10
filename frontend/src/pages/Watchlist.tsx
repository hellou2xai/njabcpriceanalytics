import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { watchlist, intelligence, catalog } from '../lib/api';
import type { WatchlistItem, BuySignal } from '../lib/api';
import RowLimitSelect from '../components/RowLimitSelect';
import FavoriteButton from '../components/FavoriteButton';
import ProductThumb from '../components/ProductThumb';
import { RowMenuButton } from '../components/ContextMenu';
import PriceTrendIndicator from '../components/PriceTrendIndicator';
import AddToCartButton from '../components/AddToCartButton';
import { Download, Layers } from 'lucide-react';
import { distributorName, abgSku, skuLabel } from '../lib/distributors';
import { ErrorState, EmptyState } from '../components/DataState';
import DataLoading from '../components/DataLoading';

// Transient per-row quantities (cases/units) used to seed the "Add to cart"
// button and the running totals. Not persisted: the real cart lives server-side.
type Qty = { cases: number; units: number };
type QtyState = Record<string, Qty>; // key = "product_name|wholesaler"

// ---- Inline Editable Cell ----
function InlineEdit({
  value, onSave, placeholder, type = 'text', align, prefix,
}: {
  value: string; onSave: (v: string) => void; placeholder: string;
  type?: 'text' | 'number'; align?: 'left' | 'right'; prefix?: string;
}) {
  const [val, setVal] = useState(value);
  const [saved, setSaved] = useState(false);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => { setVal(value); }, [value]);

  const handleBlur = () => {
    if (val !== value) {
      onSave(val);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    }
  };

  return (
    <span className="inline-edit-cell">
      {prefix && val !== '' && <span className="inline-edit-prefix">{prefix}</span>}
      <input ref={ref} className="inline-edit-input" type={type} value={val}
        onChange={e => setVal(e.target.value)} onBlur={handleBlur}
        onKeyDown={e => { if (e.key === 'Enter') ref.current?.blur(); }}
        placeholder={placeholder} style={{ textAlign: align ?? 'left' }} />
      {saved && <span className="inline-edit-saved">Saved</span>}
    </span>
  );
}

// ---- CSV Export ----
function exportCSV(items: WatchlistItem[], signals: BuySignal[], qtys: QtyState) {
  const signalMap = new Map(signals.map(s => [`${s.product_name}|${s.wholesaler}`, s]));
  const headers = ['SKU', 'Description', 'Brand', 'Size', 'Source', 'Category', 'Case Price',
    'Bottle Price', 'Effective Price', 'Savings', 'Target Price', 'Buy Signal', 'Cases', 'Units', 'Note'];
  const rows = items.map(item => {
    const key = `${item.product_name}|${item.wholesaler}`;
    const sig = signalMap.get(key);
    const qty = qtys[key] ?? { cases: 0, units: 0 };
    return [
      item.upc ?? '', item.product_name, sig?.brand ?? '', item.unit_volume ?? '', item.wholesaler,
      sig?.product_type ?? '', sig ? sig.frontline_case_price.toFixed(2) : '',
      sig ? sig.frontline_unit_price.toFixed(2) : '',
      sig ? sig.effective_case_price.toFixed(2) : '',
      sig ? sig.total_savings_per_case.toFixed(2) : '',
      item.target_price != null ? item.target_price.toFixed(2) : '',
      sig?.signal ?? '', String(qty.cases || ''), String(qty.units || ''),
      item.notes ?? '',
    ];
  });

  const escape = (s: string) =>
    s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;

  const csv = [headers, ...rows].map(row => row.map(escape).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `favorites-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ---- Buy Signal Badge (inline) ----
const SIGNAL_COLORS: Record<string, { bg: string; color: string }> = {
  BUY_NOW: { bg: 'rgba(16,185,129,0.2)', color: 'var(--green)' },
  GOOD_BUY: { bg: 'rgba(56,189,248,0.2)', color: '#38bdf8' },
  HOLD: { bg: 'rgba(107,114,128,0.2)', color: 'var(--text-muted)' },
  WAIT: { bg: 'rgba(245,158,11,0.2)', color: 'var(--yellow)' },
  DEFER: { bg: 'rgba(245,158,11,0.2)', color: 'var(--yellow)' },
};

function SignalBadge({ signal }: { signal?: string }) {
  if (!signal) return null;
  const style = SIGNAL_COLORS[signal] ?? { bg: 'rgba(107,114,128,0.2)', color: 'var(--text-muted)' };
  return <span className="tag" style={{ background: style.bg, color: style.color }}>{signal.replace('_', ' ')}</span>;
}

// ---- Signal Summary Pill ----
const PILL_COLORS: Record<string, string> = {
  BUY_NOW: 'var(--green)',
  GOOD_BUY: '#38bdf8',
  HOLD: 'var(--text-muted)',
  WAIT: 'var(--yellow)',
  DEFER: 'var(--yellow)',
};

function SignalPill({ signal, count }: { signal: string; count: number }) {
  const color = PILL_COLORS[signal] ?? 'var(--text-muted)';
  return (
    <span className="signal-pill" style={{ background: `${color}22`, color, border: `1px solid ${color}44` }}>
      {count} {signal.replace('_', ' ')}
    </span>
  );
}

// ---- Distributor Badge ----
const DIST_COLORS: Record<string, string> = {
  allied: '#3b82f6',
  fedway: '#8b5cf6',
  high_grade: '#f97316',
  opici: '#10b981',
  peerless: '#ef4444',
};

function DistributorBadge({ code }: { code: string }) {
  const color = DIST_COLORS[code] ?? 'var(--text-muted)';
  return (
    <span className="cell-distributor-badge" style={{ background: `${color}22`, color }}>
      {distributorName(code)}
    </span>
  );
}

// ---- Quantity Stepper ----
function QtyStepper({
  label, value, onChange,
}: { label: string; value: number; onChange: (n: number) => void }) {
  return (
    <div className="qty-stepper">
      <span style={{ fontSize: 10, color: 'var(--text-muted)', width: 28, flexShrink: 0 }}>{label}</span>
      <button disabled={value <= 0} onClick={e => { e.stopPropagation(); onChange(Math.max(0, value - 1)); }}>-</button>
      <input
        type="number"
        value={value || ''}
        placeholder="0"
        onChange={e => { e.stopPropagation(); onChange(Math.max(0, parseInt(e.target.value) || 0)); }}
        onClick={e => e.stopPropagation()}
      />
      <button onClick={e => { e.stopPropagation(); onChange(value + 1); }}>+</button>
    </div>
  );
}

// ---- RIP Progress Bar ----
function RipProgress({ currentCases, tierCases, tierLabel }: { currentCases: number; tierCases: number; tierLabel: string }) {
  const pct = tierCases > 0 ? Math.min(100, (currentCases / tierCases) * 100) : 0;
  const met = currentCases >= tierCases && tierCases > 0;
  return (
    <div>
      <div className="rip-progress">
        <div className="rip-progress-fill" style={{
          width: `${pct}%`,
          background: met ? 'var(--green)' : 'var(--yellow)',
        }} />
      </div>
      <div className="rip-progress-label">
        {met ? 'RIP unlocked!' : `${currentCases}/${tierLabel}`}
      </div>
    </div>
  );
}

// ---- Tier label helper ----
function shortUnit(unit?: string | null): string {
  if (!unit) return 'cs';
  const u = unit.toLowerCase();
  if (u.startsWith('case') || u === 'c') return 'cs';
  if (u.startsWith('bottle') || u.startsWith('btl') || u === 'b') return 'btl';
  return unit;
}

// ---- Incentive Tier Cell: fetches and shows discount+RIP tiers for one product ----
function IncentiveTierCell({ wholesaler, productName, currentCases }:
  { wholesaler: string; productName: string; currentCases: number }) {
  const { data } = useQuery({
    queryKey: ['product-detail', wholesaler, productName],
    queryFn: () => catalog.product(wholesaler, productName),
    staleTime: 5 * 60_000,
  });

  const discounts = data?.discount_tiers ?? [];
  const rips = data?.rip_tiers ?? [];

  if (discounts.length === 0 && rips.length === 0) {
    return <span style={{ color: 'var(--text-muted)' }}>&mdash;</span>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 170 }}>
      {discounts.map(d => {
        const qNum = d.quantity ?? 0;
        const isBtl = /^b/i.test(d.unit ?? '');
        const met = qNum > 0 && !isBtl && currentCases >= qNum;
        return (
          <div key={`d-${d.tier}`} className="incentive-tier-row" data-met={met ? 'true' : 'false'}>
            <span className="source-badge source-discount">DISC</span>
            <span className="incentive-tier-text">
              {qNum}+ {isBtl ? 'btl' : 'cs'} = <strong>-${d.amount_per_case}/cs</strong>
              <span className="incentive-roi">{d.roi_pct}%</span>
            </span>
          </div>
        );
      })}
      {rips.map((r, idx) => {
        const met = currentCases >= r.qty;
        return (
          <div key={`r-${idx}`} className="incentive-tier-row" data-met={met ? 'true' : 'false'}>
            <span className="source-badge source-rip">RIP</span>
            <span className="incentive-tier-text">
              {r.qty}{shortUnit(r.unit)} = <strong>-${r.amount}</strong>
              <span className="incentive-per-case">(-${r.per_case_savings}/cs)</span>
              <span className="incentive-roi">{r.roi_pct}%</span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ---- Parse RIP tier info from quantity string ----
function parseRipTier(quantityStr?: string): { minCases: number; label: string } | null {
  if (!quantityStr) return null;
  // e.g. "5CS", "10 CS", "3cs"
  const match = quantityStr.match(/(\d+)\s*CS/i);
  if (match) return { minCases: parseInt(match[1]), label: `${match[1]}CS` };
  return null;
}

// ---- Main Component ----
export default function WatchlistPage() {
  const qc = useQueryClient();
  const [limit, setLimit] = useState(100);
  const [groupByCategory, setGroupByCategory] = useState(false);
  const [qtys, setQtys] = useState<QtyState>({});
  const [searchTerm, setSearchTerm] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');

  const { data, isLoading, isError, refetch } = useQuery({ queryKey: ['watchlist'], queryFn: watchlist.get });
  const { data: signals } = useQuery({
    queryKey: ['buy-signals'],
    queryFn: () => intelligence.buySignals(),
  });

  const notesMut = useMutation({
    mutationFn: ({ id, notes }: { id: number; notes: string }) => watchlist.setNotes(id, notes),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['watchlist'] }),
  });
  const priceMut = useMutation({
    mutationFn: ({ id, price }: { id: number; price: number }) => watchlist.setTargetPrice(id, price),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['watchlist'] }),
  });

  const updateQty = useCallback((key: string, field: 'cases' | 'units', value: number) => {
    setQtys(prev => ({
      ...prev,
      [key]: { cases: prev[key]?.cases ?? 0, units: prev[key]?.units ?? 0, [field]: value },
    }));
  }, []);

  const allItems = data ?? [];
  const signalMap = useMemo(() => new Map((signals ?? []).map(s => [`${s.product_name}|${s.wholesaler}`, s])), [signals]);

  // Distinct categories from signals
  const categories = useMemo(() => {
    const cats = new Set<string>();
    for (const item of allItems) {
      const sig = signalMap.get(`${item.product_name}|${item.wholesaler}`);
      if (sig?.product_type) cats.add(sig.product_type);
    }
    return Array.from(cats).sort();
  }, [allItems, signalMap]);

  // Filter items
  const filteredItems = useMemo(() => {
    let result = allItems;
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      result = result.filter(i => i.product_name.toLowerCase().includes(term));
    }
    if (categoryFilter) {
      result = result.filter(i => {
        const sig = signalMap.get(`${i.product_name}|${i.wholesaler}`);
        return sig?.product_type === categoryFilter;
      });
    }
    return result.slice(0, limit);
  }, [allItems, searchTerm, categoryFilter, limit, signalMap]);

  // Signal counts for summary bar
  const signalCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const item of allItems) {
      const sig = signalMap.get(`${item.product_name}|${item.wholesaler}`);
      if (sig?.signal) counts[sig.signal] = (counts[sig.signal] ?? 0) + 1;
    }
    return counts;
  }, [allItems, signalMap]);

  // Signal order for display
  const signalOrder = ['BUY_NOW', 'GOOD_BUY', 'HOLD', 'WAIT', 'DEFER'];

  // ---- Render helpers ----
  const renderRow = (item: WatchlistItem) => {
    const key = `${item.product_name}|${item.wholesaler}`;
    const sig = signalMap.get(key);
    const qty = qtys[key] ?? { cases: 0, units: 0 };
    const hasSavings = sig && sig.total_savings_per_case > 0;
    const effectivePrice = sig?.effective_case_price ?? 0;
    const frontlinePrice = sig?.frontline_case_price ?? 0;
    const unitPrice = sig?.frontline_unit_price ?? 0;

    // Parse RIP tier info
    const ripTier = sig?.has_rip ? parseRipTier(sig.unit_qty) : null;
    // Count discount tiers (approximate from data)
    const tierCount = sig?.has_discount ? (sig.has_rip ? 3 : 1) : 0;
    const minCases = ripTier?.minCases ?? 5;

    return (
      <tr key={key}
          data-ctx=""
          data-ctx-product={item.product_name}
          data-ctx-wholesaler={item.wholesaler}
          data-ctx-upc={item.upc}
          data-ctx-volume={item.unit_volume}>
        {/* 1. Favorite */}
        <td>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
            <FavoriteButton productName={item.product_name} wholesaler={item.wholesaler}
              upc={item.upc} unitVolume={item.unit_volume} />
            <RowMenuButton product={{ product_name: item.product_name, wholesaler: item.wholesaler, upc: item.upc, unit_volume: item.unit_volume }} />
          </span>
        </td>

        {/* 2. Code + Distributor */}
        <td>
          <div className="cell-stacked">
            <span className="cell-code">
              {item.upc ?? '--'}
              {abgSku(item.wholesaler, item.abg_sku) && <span style={{ marginLeft: 6, color: 'var(--text-muted)' }}>{skuLabel(item.wholesaler)} {item.abg_sku}</span>}
            </span>
            <DistributorBadge code={item.wholesaler} />
          </div>
        </td>

        {/* 3. Description + Signal + Reasons */}
        <td>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <ProductThumb src={item.image_url ?? sig?.image_url} alt={item.product_name} size={64} />
            <div className="cell-stacked">
              <span style={{ fontWeight: 600, fontSize: 13 }}>{item.product_name}</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <SignalBadge signal={sig?.signal} />
                {sig?.reason && (
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    {sig.reason.split(';').slice(0, 2).join(' · ')}
                  </span>
                )}
              </div>
            </div>
          </div>
        </td>

        {/* 4. Brand */}
        <td className="hide-sm">
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{sig?.brand ?? '--'}</span>
        </td>

        {/* 5. Size */}
        <td>
          <span style={{ fontSize: 12 }}>
            {item.unit_volume ?? '--'}
            {sig?.unit_qty ? ` / ${sig.unit_qty}` : ''}
          </span>
        </td>

        {/* 6. Case cost + Trend */}
        <td>
          <div className="cell-stacked">
            <span style={{ fontSize: 15, fontWeight: 600 }}>
              ${frontlinePrice.toFixed(2)}
            </span>
            {sig && (
              <PriceTrendIndicator
                currentPrice={frontlinePrice}
                previousPrice={sig.case_delta_pct !== 0 ? frontlinePrice / (1 + sig.case_delta_pct / 100) : undefined}
              />
            )}
          </div>
        </td>

        {/* 7. Bottle cost */}
        <td className="hide-md">
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            ${unitPrice.toFixed(2)}
          </span>
        </td>

        {/* 8. RIP Save */}
        <td>
          {hasSavings ? (
            <div className="cell-stacked">
              <span style={{ color: 'var(--green)', fontWeight: 700, fontSize: 14 }}>
                -${sig.total_savings_per_case.toFixed(2)}
              </span>
              <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                {minCases}CS min{tierCount > 0 ? ` · ${tierCount} tiers` : ''}
              </span>
            </div>
          ) : (
            <span style={{ color: 'var(--text-muted)' }}>&mdash;</span>
          )}
        </td>

        {/* 8b. Incentive Tiers (DISCOUNT + RIP) */}
        <td>
          <IncentiveTierCell
            wholesaler={item.wholesaler}
            productName={item.product_name}
            currentCases={qty.cases}
          />
        </td>

        {/* 9. Effective price */}
        <td>
          {hasSavings ? (
            <span style={{ color: 'var(--green)', fontWeight: 700, fontSize: 14 }}>
              ${effectivePrice.toFixed(2)}
            </span>
          ) : (
            <span style={{ fontSize: 13 }}>${frontlinePrice.toFixed(2)}</span>
          )}
        </td>

        {/* 10. Quantity stepper + RIP progress */}
        <td>
          <div className="cell-stacked" style={{ minWidth: 130 }}>
            <QtyStepper label="Btl" value={qty.units} onChange={v => updateQty(key, 'units', v)} />
            <QtyStepper label="Case" value={qty.cases} onChange={v => updateQty(key, 'cases', v)} />
            {sig?.has_rip && ripTier && (
              <RipProgress currentCases={qty.cases} tierCases={ripTier.minCases} tierLabel={ripTier.label} />
            )}
          </div>
        </td>

        {/* 11. Notes */}
        <td>
          <InlineEdit value={item.notes ?? ''} onSave={v => notesMut.mutate({ id: item.id, notes: v })}
            placeholder="Add note..." />
        </td>

        {/* 12. Target price */}
        <td className="hide-md">
          <InlineEdit value={item.target_price != null ? String(item.target_price) : ''}
            onSave={v => { const n = parseFloat(v); if (!isNaN(n)) priceMut.mutate({ id: item.id, price: n }); }}
            placeholder="$0.00" type="number" align="right" prefix="$" />
        </td>

        {/* 13. Add to cart */}
        <td>
          <AddToCartButton productName={item.product_name} wholesaler={item.wholesaler}
            upc={item.upc ?? undefined} unitVolume={item.unit_volume ?? undefined}
            qtyCases={qty.cases} qtyUnits={qty.units} />
        </td>
      </tr>
    );
  };

  const renderTableHeader = () => (
    <thead>
      <tr>
        <th style={{ width: 36 }}></th>
        <th>Code</th>
        <th>Description</th>
        <th className="hide-sm">Brand</th>
        <th>Size</th>
        <th>Case $</th>
        <th className="hide-md">Btl $</th>
        <th>Save</th>
        <th>Incentive Tiers</th>
        <th>Eff. $</th>
        <th>Qty</th>
        <th>Notes</th>
        <th className="hide-md">Target</th>
        <th style={{ width: 36 }}></th>
      </tr>
    </thead>
  );

  const renderGrouped = () => {
    const groups: Record<string, WatchlistItem[]> = {};
    for (const item of filteredItems) {
      const sig = signalMap.get(`${item.product_name}|${item.wholesaler}`);
      const cat = sig?.product_type ?? 'Uncategorized';
      (groups[cat] ??= []).push(item);
    }

    return Object.entries(groups).sort(([a], [b]) => a.localeCompare(b)).map(([category, groupItems]) => (
      <div key={category} style={{ marginBottom: 20 }}>
        <h4 className="group-header">
          {category} <span className="group-count">({groupItems.length})</span>
        </h4>
        <div className="table-container">
          <table className="tracker-table">
            {renderTableHeader()}
            <tbody>{groupItems.map(renderRow)}</tbody>
          </table>
        </div>
      </div>
    ));
  };

  return (
    <div className="page">
      {/* ---- Header ---- */}
      <div className="tracker-header">
        <div>
          <h2 style={{ marginBottom: 2 }}>My Favorites</h2>
          <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
            {allItems.length} saved product{allItems.length !== 1 ? 's' : ''} · set quantities and use the + to add to your cart
          </span>
        </div>
        <div className="page-actions">
          <button className="btn btn-secondary" onClick={() => exportCSV(allItems, signals ?? [], qtys)}
            disabled={allItems.length === 0}>
            <Download size={16} /> Export CSV
          </button>
        </div>
      </div>

      {/* ---- Buy Signal Summary Bar ---- */}
      {Object.keys(signalCounts).length > 0 && (
        <div className="signal-summary-bar">
          {signalOrder.filter(s => signalCounts[s] > 0).map(signal => (
            <SignalPill key={signal} signal={signal} count={signalCounts[signal]} />
          ))}
        </div>
      )}

      {/* ---- Filters Bar ---- */}
      <div className="filter-bar">
        <input
          type="text"
          placeholder="Search products..."
          value={searchTerm}
          onChange={e => setSearchTerm(e.target.value)}
          style={{ padding: '8px 12px', background: 'var(--surface)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius)', color: 'var(--text)', fontSize: 13, width: 240 }}
        />
        <select
          value={categoryFilter}
          onChange={e => setCategoryFilter(e.target.value)}
          className="row-limit-select"
          style={{ minWidth: 140 }}
        >
          <option value="">All Categories</option>
          {categories.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <label className="tracked-toggle" onClick={() => setGroupByCategory(!groupByCategory)}>
          <Layers size={14} />
          <input type="checkbox" checked={groupByCategory} onChange={() => {}} />
          Group by category
        </label>
        <RowLimitSelect value={limit} onChange={setLimit} />
        <span style={{ color: 'var(--text-muted)', fontSize: 12, marginLeft: 'auto' }}>
          {filteredItems.length} item{filteredItems.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* ---- Table ---- */}
      {isError ? (
        <ErrorState retry={() => refetch()} />
      ) : isLoading ? (
        <DataLoading label="Loading your favorites…" />
      ) : allItems.length === 0 ? (
        <EmptyState title="Your watchlist is empty">Add products to your watchlist from any product page to track their prices here.</EmptyState>
      ) : groupByCategory ? renderGrouped() : (
        <div className="table-container">
          <table className="tracker-table">
            {renderTableHeader()}
            <tbody>
              {filteredItems.length > 0 ? filteredItems.map(renderRow) : (
                <tr><td colSpan={14} className="empty">No favorites yet. Star items from the catalog to add them here.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
