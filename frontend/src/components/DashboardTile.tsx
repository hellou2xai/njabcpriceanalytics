import { useState, useEffect, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { X, Maximize2, ArrowUpRight } from 'lucide-react';
import type { FilterState } from '../hooks/useTableFilters';
import { distributorName } from '../lib/distributors';

interface TileProps {
  id?: string;            // when set, a nav link to /#tile=<id> opens this modal
  title: string;
  subtitle?: string;
  count?: number | string;
  countLabel?: string;
  accent?: string;
  preview?: ReactNode;
  // When `to` is set the tile is a LINK to that real page (e.g. a Promotions
  // page) — clicking navigates there instead of opening an in-dashboard modal.
  // The tile still shows the count + summary. `modalContent` is then optional.
  to?: string;
  modalContent?: (close: () => void) => ReactNode;
}

export function DashboardTile({
  id, title, subtitle, count, countLabel, accent, preview, to, modalContent,
}: TileProps) {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const isLink = !!to;

  const close = () => {
    setOpen(false);
    if (id && location.hash === `#tile=${id}`) {
      navigate(location.pathname + location.search, { replace: true });
    }
  };

  // A nav shortcut ("/#tile=<id>") opens this tile's modal directly — works both
  // when arriving from another page and when already on the dashboard. Skipped
  // for link tiles, which navigate to a real page instead of opening a modal.
  useEffect(() => {
    if (!isLink && id && location.hash === `#tile=${id}`) setOpen(true);
  }, [isLink, id, location.hash]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <>
      <button
        type="button"
        className="dashboard-tile"
        onClick={() => (isLink ? navigate(to!) : setOpen(true))}
        title={isLink ? `Open ${title}` : undefined}
        style={accent ? { borderLeftColor: accent } : undefined}
      >
        <div className="dashboard-tile-head">
          <span className="dashboard-tile-title">{title}</span>
          {isLink
            ? <ArrowUpRight size={14} className="dashboard-tile-zoom" />
            : <Maximize2 size={14} className="dashboard-tile-zoom" />}
        </div>
        {count !== undefined && (
          <div className="dashboard-tile-count" style={accent ? { color: accent } : undefined}>
            {count}
            {countLabel && <span className="dashboard-tile-count-label">{countLabel}</span>}
          </div>
        )}
        {subtitle && <div className="dashboard-tile-subtitle">{subtitle}</div>}
        {preview && <div className="dashboard-tile-preview">{preview}</div>}
      </button>
      {open && modalContent && (
        <div className="modal-overlay" onClick={close}>
          <div className="modal dashboard-tile-modal" onClick={e => e.stopPropagation()}>
            <button className="modal-close" onClick={close} aria-label="Close">
              <X size={18} />
            </button>
            <h3 style={{ margin: 0, marginBottom: 12 }}>{title}</h3>
            {modalContent(close)}
          </div>
        </div>
      )}
    </>
  );
}

interface FilterBarProps {
  state: FilterState;
  set: (patch: Partial<FilterState>) => void;
  productTypes: string[];
  distributors?: string[];   // when provided, render a Distributor dropdown
  showPrice?: boolean;
  showDeals?: { discount?: boolean; rip?: boolean; closeout?: boolean };
  rightSlot?: ReactNode;
}

export function TileFilterBar({
  state, set, productTypes, distributors, showPrice, showDeals, rightSlot,
}: FilterBarProps) {
  const dealOpts = showDeals;
  return (
    <div className="tile-filter-bar">
      <input
        type="text"
        className="tile-filter-search"
        placeholder="Search product name or UPC..."
        value={state.search}
        onChange={e => set({ search: e.target.value })}
      />
      <select
        className="tile-filter-select"
        value={state.productType}
        onChange={e => set({ productType: e.target.value })}
      >
        <option value="">All categories</option>
        {productTypes.map(pt => (
          <option key={pt} value={pt}>{pt}</option>
        ))}
      </select>
      {distributors && distributors.length > 0 && (
        <select
          className="tile-filter-select"
          value={state.distributor}
          onChange={e => set({ distributor: e.target.value })}
        >
          <option value="">All distributors</option>
          {distributors.map(d => (
            <option key={d} value={d}>{distributorName(d)}</option>
          ))}
        </select>
      )}
      {showPrice && (
        <div className="tile-filter-range">
          <input
            type="number" className="tile-filter-num" placeholder="Min $"
            value={state.priceMin} onChange={e => set({ priceMin: e.target.value })}
          />
          <span className="tile-filter-dash">–</span>
          <input
            type="number" className="tile-filter-num" placeholder="Max $"
            value={state.priceMax} onChange={e => set({ priceMax: e.target.value })}
          />
        </div>
      )}
      {dealOpts && (dealOpts.discount || dealOpts.rip || dealOpts.closeout) && (
        <select
          className="tile-filter-select"
          value={state.deal}
          onChange={e => set({ deal: e.target.value as FilterState['deal'] })}
        >
          <option value="all">Any deal</option>
          {dealOpts.discount && <option value="discount">Has discount</option>}
          {dealOpts.rip && <option value="rip">Has RIP</option>}
          {dealOpts.closeout && <option value="closeout">Closeout</option>}
        </select>
      )}
      {(state.search || state.productType || state.distributor || state.priceMin || state.priceMax || state.deal !== 'all') && (
        <button type="button" className="tile-filter-clear"
          onClick={() => set({ search: '', productType: '', distributor: '', priceMin: '', priceMax: '', deal: 'all' })}>
          Clear
        </button>
      )}
      <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
        {rightSlot}
      </div>
    </div>
  );
}
