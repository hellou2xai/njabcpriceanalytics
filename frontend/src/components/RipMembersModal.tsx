import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { catalog } from '../lib/api';
import { packLabel } from '../lib/distributors';
import { useModalFocus } from './useModalFocus';

/**
 * Popup that lists every product included in a single RIP code, opened by
 * clicking a RIP chip on a row (RIP Products page or Catalog table). Reuses
 * /api/catalog/rip-siblings without `exclude_upc` so the modal shows the
 * full member list, not just the "other" siblings.
 *
 * Lives in `components/` so both the RIP Products page and the Catalog table
 * mount the same modal, kept in sync.
 */
export default function RipMembersModal({
  wholesaler, ripCode, edition, onClose,
}: { wholesaler: string; ripCode: string; edition?: string; onClose: () => void }) {
  const { data, isLoading } = useQuery({
    // RIP codes are recycled month-to-month, so scope to the card's edition —
    // otherwise code 10954 shows June's product when opened from a May card.
    queryKey: ['rip-siblings-modal', wholesaler, ripCode, edition ?? ''],
    queryFn: () => catalog.ripSiblings(wholesaler, ripCode, edition ? { edition } : undefined),
  });
  const boxRef = useRef<HTMLDivElement>(null);
  useModalFocus(boxRef, true);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const items = data?.items ?? [];
  const tiers = data?.tiers ?? [];
  const fmtWindow = (f: string | null, t: string | null) =>
    f && t ? `${f.slice(5)} to ${t.slice(5)}` : 'all month';
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal rip-members-modal" role="dialog" aria-modal="true" ref={boxRef} tabIndex={-1} onClick={e => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="Close">
          <X size={18} />
        </button>
        <h3 style={{ marginTop: 0, marginBottom: 4 }}>
          <span className="rip-code-badge">🔗 RIP {ripCode}</span>
          <span style={{ fontSize: 13, color: 'var(--text-muted)', marginLeft: 10, fontWeight: 400 }}>
            ({wholesaler})
          </span>
        </h3>

        {/* the RIP's tier ladder, shown first so the buyer sees the deal terms */}
        {tiers.length > 0 && (
          <div className="rip-tier-box">
            <div className="rip-tier-title">RIP tiers</div>
            <table className="rip-tier-table">
              <thead><tr><th>Buy</th><th>You get back</th><th>When</th></tr></thead>
              <tbody>
                {tiers.map((t, i) => (
                  <tr key={i}>
                    <td>{t.qty != null ? `${t.qty} ${t.unit || 'unit(s)'}` : (t.unit || '-')}</td>
                    <td className="text-green font-bold">${t.amount.toFixed(2)}{t.unit?.toLowerCase().startsWith('case') ? '/case' : ''}</td>
                    <td className="text-muted">{fmtWindow(t.from_date, t.to_date)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {tiers[0]?.description && <div className="rip-tier-desc">{tiers[0].description}</div>}
          </div>
        )}

        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 0 }}>
          {isLoading
            ? 'Loading…'
            : `${items.length} product${items.length === 1 ? '' : 's'} (any mix of these UPCs, including different vintages or names on the same UPC) count toward this RIP.`}
        </p>
        {!isLoading && items.length === 0 && (
          <p className="text-muted" style={{ marginTop: 12 }}>No products listed under this RIP.</p>
        )}
        <div className="rip-members-list">
          {items.map((p, idx) => {
            const eff = p.effective_case_price ?? p.frontline_case_price ?? null;
            const list = p.frontline_case_price ?? null;
            const save = p.total_savings_per_case ?? null;
            return (
              <div key={`${p.upc}|${idx}`} className="rip-member-row">
                <span className="rip-member-meta">
                  <strong>{p.product_name}</strong>
                  <span className="rip-member-sub">
                    {[p.unit_volume, packLabel(p.unit_volume, p.unit_qty, p.unit_type), p.upc]
                      .filter(Boolean).join(' · ')}
                  </span>
                </span>
                <span className="rip-member-price">
                  {eff != null && (
                    <span className="text-green font-bold">${eff.toFixed(2)}/cs</span>
                  )}
                  {list != null && eff != null && eff < list - 0.005 && (
                    <span className="text-muted" style={{ textDecoration: 'line-through', marginLeft: 6, fontWeight: 400 }}>
                      ${list.toFixed(2)}
                    </span>
                  )}
                  {save != null && save > 0 && (
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>save ${save.toFixed(2)}/cs</div>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
