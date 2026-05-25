import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { orders, catalog, salesReps } from '../lib/api';
import type { OrderLine, OrderRipTier, Product, SubmitResult } from '../lib/api';
import { useProductQuickView } from '../components/ProductQuickView';
import { distributorName, DISTRIBUTOR_NAMES } from '../lib/distributors';
import { trackAction } from '../lib/activityTracker';

// ---- Constants ----

const DIVISIONS = ['L', 'S', 'D', 'GS', 'FB', 'JD', 'IV'] as const;

const DIVISION_COLORS: Record<string, string> = {
  L: '#8b5cf6',   // violet
  S: '#0ea5e9',   // sky
  D: '#f59e0b',   // amber
  GS: '#10b981',  // emerald
  FB: '#f43f5e',  // rose
  JD: '#f97316',  // orange
  IV: '#6366f1',  // indigo
};

function statusBadgeClass(status: string): string {
  switch (status.toLowerCase()) {
    case 'draft': return 'tag tag-gray';
    case 'submitted': return 'tag tag-blue';
    case 'completed': return 'tag tag-green';
    default: return 'tag tag-gray';
  }
}

function fmt(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return '$0.00';
  return '$' + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function parseNum(v: string | number | null | undefined): number {
  if (v == null) return 0;
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return isNaN(n) ? 0 : n;
}

// ---- Recommendation type ----
interface Recommendation {
  type: 'closeout' | 'defer' | 'rip_optimizer';
  message: string;
  priority: 'high' | 'medium' | 'low';
  lineId?: number;
}

function generateRecommendations(lines: OrderLine[]): Recommendation[] {
  const recs: Recommendation[] = [];
  for (const line of lines) {
    // Closeout
    if (line.is_closeout) {
      recs.push({
        type: 'closeout',
        message: `${line.description || line.product_name} — Closeout item, buy before discontinued`,
        priority: 'high',
        lineId: line.id,
      });
    }
    // Tier optimizer
    if (line.rip_tiers && line.rip_tiers.length > 0) {
      const sorted = [...line.rip_tiers].sort((a, b) => b.tier_cases - a.tier_cases);
      for (const tier of sorted) {
        const qty = line.qty_cases || 0;
        if (qty > 0 && qty < tier.tier_cases) {
          const diff = tier.tier_cases - qty;
          const save = parseNum(tier.save_amount);
          if (save > 0) {
            recs.push({
              type: 'rip_optimizer',
              message: `${line.description || line.product_name} — Add ${diff} more case${diff > 1 ? 's' : ''} to reach ${tier.tier} tier, save ${fmt(save * tier.tier_cases)} more`,
              priority: 'low',
              lineId: line.id,
            });
          }
          break; // only suggest the next unmet tier
        }
      }
    }
  }
  return recs;
}

function getLineRecommendations(line: OrderLine): Recommendation[] {
  const recs: Recommendation[] = [];
  if (line.is_closeout) {
    recs.push({ type: 'closeout', message: 'Closeout item', priority: 'high', lineId: line.id });
  }
  if (line.rip_tiers && line.rip_tiers.length > 0) {
    const sorted = [...line.rip_tiers].sort((a, b) => b.tier_cases - a.tier_cases);
    for (const tier of sorted) {
      const qty = line.qty_cases || 0;
      if (qty > 0 && qty < tier.tier_cases) {
        const diff = tier.tier_cases - qty;
        recs.push({
          type: 'rip_optimizer',
          message: `Add ${diff} more to reach ${tier.tier}`,
          priority: 'low',
          lineId: line.id,
        });
        break;
      }
    }
  }
  return recs;
}

function recBadgeLabel(type: string): string {
  switch (type) {
    case 'closeout': return 'CLO';
    case 'defer': return 'WAIT';
    case 'rip_optimizer': return 'RIP';
    default: return type.toUpperCase();
  }
}

function recBadgeClass(type: string): string {
  switch (type) {
    case 'closeout': return 'rec-badge rec-closeout';
    case 'defer': return 'rec-badge rec-defer';
    case 'rip_optimizer': return 'rec-badge rec-rip';
    default: return 'rec-badge';
  }
}

// Compute line financials client-side
function computeLineCost(line: OrderLine): number {
  return parseNum(line.case_cost) * (line.qty_cases || 0);
}

function getBestSave(line: OrderLine): number {
  if (!line.rip_tiers || line.rip_tiers.length === 0) return 0;
  const qty = line.qty_cases || 0;
  let bestSave = 0;
  for (const tier of line.rip_tiers) {
    if (qty >= tier.tier_cases) {
      const s = parseNum(tier.save_amount);
      if (s > bestSave) bestSave = s;
    }
  }
  return bestSave;
}

function computeLineRebate(line: OrderLine): number {
  if (line.line_rip_rebate != null) return parseNum(line.line_rip_rebate);
  return getBestSave(line) * (line.qty_cases || 0);
}

function computeLineInvoice(line: OrderLine): number {
  if (line.line_invoice != null) return parseNum(line.line_invoice);
  return computeLineCost(line);
}

function computeLineEffective(line: OrderLine): number {
  if (line.line_effective != null) return parseNum(line.line_effective);
  return computeLineInvoice(line) - computeLineRebate(line);
}

// ---- Quantity Stepper ----
function QtyStepper({
  label, value, onChange, min = 0,
}: {
  label: string; value: number; onChange: (v: number) => void; min?: number;
}) {
  return (
    <div className="qty-stepper">
      <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, minWidth: 22 }}>{label}</span>
      <button
        disabled={value <= min}
        onClick={() => onChange(Math.max(min, value - 1))}
        type="button"
      >-</button>
      <span style={{ width: 32, textAlign: 'center', fontFamily: 'monospace', fontSize: 13, color: 'var(--text)' }}>{value}</span>
      <button
        onClick={() => onChange(value + 1)}
        type="button"
      >+</button>
    </div>
  );
}

// ---- Main component ----
export default function OrderDetail() {
  const { id } = useParams<{ id: string }>();
  const orderId = Number(id);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { open: openQuickView } = useProductQuickView();

  // Local state
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState('');
  const nameRef = useRef<HTMLInputElement>(null);

  const [notes, setNotes] = useState<string | null>(null);
  const [editingNotes, setEditingNotes] = useState(false);

  const [divisionFilter, setDivisionFilter] = useState<string | null>(null);
  const [recsOpen, setRecsOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);

  const [addProductError, setAddProductError] = useState('');
  const [savedFlash, setSavedFlash] = useState(false);

  // Submit + PDF preview
  const [submitConfirm, setSubmitConfirm] = useState(false);
  const [submitResult, setSubmitResult] = useState<SubmitResult | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState('');
  // Revision controls (shown in the submit dialog when re-submitting)
  const [revisionInput, setRevisionInput] = useState<number>(1);
  const [sendCancellation, setSendCancellation] = useState(true);

  // ---- queries ----
  const { data, isLoading, isError } = useQuery({
    queryKey: ['order', orderId],
    queryFn: () => orders.detail(orderId),
    enabled: !!orderId,
  });

  // ---- mutations ----
  const invalidateOrder = useCallback(() => {
    qc.invalidateQueries({ queryKey: ['order', orderId] });
  }, [qc, orderId]);

  const submitMut = useMutation({
    mutationFn: (vars: { revision: number; send_cancellation: boolean }) =>
      orders.submit(orderId, vars),
    onSuccess: (res) => {
      setSubmitConfirm(false);
      setSubmitResult(res);
      trackAction(res.is_revision ? 'Order re-submitted' : 'Order submitted',
        { orderId, revision: res.revision, emailed: res.emailed });
      invalidateOrder();
    },
  });

  const reopenMut = useMutation({
    mutationFn: () => orders.reopen(orderId),
    onSuccess: invalidateOrder,
  });

  const cloneMut = useMutation({
    mutationFn: () => orders.clone(orderId),
    onSuccess: (res) => navigate(`/orders/${res.id}`),
  });

  const copyWatchlistMut = useMutation({
    mutationFn: () => orders.copyWatchlist(orderId),
    onSuccess: invalidateOrder,
  });

  const deleteMut = useMutation({
    mutationFn: () => orders.delete(orderId),
    onSuccess: () => navigate('/orders'),
  });

  const updateNameMut = useMutation({
    mutationFn: (name: string) => orders.update(orderId, { name }),
    onSuccess: invalidateOrder,
  });

  const updateNotesMut = useMutation({
    mutationFn: (notesVal: string) => orders.update(orderId, { notes: notesVal }),
    onSuccess: invalidateOrder,
  });

  const updateAssocMut = useMutation({
    mutationFn: (patch: { distributor?: string | null; sales_rep_id?: number | null }) =>
      orders.update(orderId, patch),
    onSuccess: invalidateOrder,
  });

  const removeLineMut = useMutation({
    mutationFn: (lineId: number) => orders.removeLine(orderId, lineId),
    onSuccess: invalidateOrder,
  });

  const updateLineMut = useMutation({
    mutationFn: ({ lineId, data: lineData }: { lineId: number; data: Partial<OrderLine> }) =>
      orders.updateLine(orderId, lineId, lineData),
    onSuccess: invalidateOrder,
  });

  const addLineMut = useMutation({
    mutationFn: (line: Partial<OrderLine>) => orders.addLine(orderId, line),
    onSuccess: () => {
      invalidateOrder();
      setAddProductError('');
    },
    onError: (err) => {
      setAddProductError(err instanceof Error ? err.message : 'Product could not be added to this order.');
    },
  });

  const { data: reps } = useQuery({ queryKey: ['sales-reps'], queryFn: salesReps.list });

  // ---- derived state ----
  const order = data?.order;
  const rep = order?.sales_rep_id ? reps?.find(r => r.id === order.sales_rep_id) : undefined;
  const repName = rep?.name ?? null;
  const repEmail = rep?.email ?? null;
  const repsForDist = (reps ?? []).filter(r => !order?.distributor || r.distributor === order.distributor);
  const allLines = data?.lines ?? [];
  const isDraft = order?.status === 'draft';
  const revision = order?.revision ?? 0;
  const isRevision = revision >= 1;          // submitted at least once before
  const defaultRevision = revision + 1;      // the next revision to send
  const displayNotes = notes !== null ? notes : (order?.notes ?? '');

  // Division filter
  const filteredLines = useMemo(() => {
    if (!divisionFilter) return allLines;
    return allLines.filter(l => {
      const divs = l.divisions ?? '';
      return divs.split(/\s+/).includes(divisionFilter);
    });
  }, [allLines, divisionFilter]);

  // Payment analysis
  const payment = useMemo(() => {
    const invoice = filteredLines.reduce((s, l) => s + computeLineInvoice(l), 0);
    const rebate = filteredLines.reduce((s, l) => s + computeLineRebate(l), 0);
    const effective = invoice - rebate;
    const ripPct = invoice > 0 ? (rebate / invoice) * 100 : 0;
    return { invoice, rebate, effective, ripPct };
  }, [filteredLines]);

  // Category breakdown
  const categoryBreakdown = useMemo(() => {
    const map = new Map<string, { items: number; invoice: number; rebate: number; effective: number }>();
    for (const l of filteredLines) {
      const cat = l.category || l.brand || 'Other';
      const cur = map.get(cat) || { items: 0, invoice: 0, rebate: 0, effective: 0 };
      cur.items += 1;
      cur.invoice += computeLineInvoice(l);
      cur.rebate += computeLineRebate(l);
      cur.effective += computeLineEffective(l);
      map.set(cat, cur);
    }
    return Array.from(map.entries()).map(([category, data]) => ({ category, ...data }));
  }, [filteredLines]);

  // Recommendations
  const recommendations = useMemo(() => generateRecommendations(filteredLines), [filteredLines]);

  // Summary
  const summary = useMemo(() => ({
    items: filteredLines.length,
    cases: filteredLines.reduce((s, l) => s + (l.qty_cases || 0), 0),
    bottles: filteredLines.reduce((s, l) => s + (l.qty_units || 0), 0),
  }), [filteredLines]);

  // ---- effects ----
  useEffect(() => {
    if (editingName && nameRef.current) {
      nameRef.current.focus();
      nameRef.current.select();
    }
  }, [editingName]);

  // ---- handlers ----
  function startEditName() {
    if (!order) return;
    setNameValue(order.name);
    setEditingName(true);
  }

  function saveName() {
    setEditingName(false);
    if (nameValue && nameValue !== order?.name) {
      updateNameMut.mutate(nameValue);
    }
  }

  function handleNameKey(e: React.KeyboardEvent) {
    if (e.key === 'Enter') saveName();
    if (e.key === 'Escape') setEditingName(false);
  }

  function handleQtyChange(line: OrderLine, field: 'qty_cases' | 'qty_units', value: number) {
    updateLineMut.mutate({
      lineId: line.id,
      data: { [field]: value },
    });
  }

  function handleNoteBlur(line: OrderLine, value: string) {
    if (value !== (line.notes ?? '')) {
      updateLineMut.mutate({ lineId: line.id, data: { notes: value } as Partial<OrderLine> });
    }
  }

  function handleNotesBlur() {
    setEditingNotes(false);
    const v = notes ?? '';
    if (v !== (order?.notes ?? '')) {
      updateNotesMut.mutate(v);
    }
  }

  function handleDelete() {
    setDeleteConfirm(false);
    deleteMut.mutate();
  }

  function openSubmit() {
    setRevisionInput(defaultRevision);
    setSendCancellation(true);
    setSubmitConfirm(true);
  }

  async function openPreview(rev?: number) {
    setPreviewError('');
    setPreviewLoading(true);
    try {
      const blob = await orders.pdfBlob(orderId, rev);
      setPreviewUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return URL.createObjectURL(blob);
      });
    } catch (e) {
      setPreviewError(e instanceof Error ? e.message : 'Could not load the PDF preview.');
    } finally {
      setPreviewLoading(false);
    }
  }

  function closePreview() {
    setPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
  }

  // Release the object URL when leaving the page.
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  // Edits autosave on change/blur; this gives an explicit confirmation and
  // re-syncs the order from the server.
  function handleSaveOrder() {
    invalidateOrder();
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 1800);
  }

  // ---- loading / error ----
  if (isLoading) return <div className="page"><p style={{ color: 'var(--text-muted)' }}>Loading order...</p></div>;
  if (isError || !order) return <div className="page"><p style={{ color: 'var(--red)' }}>Order not found.</p></div>;

  return (
    <div className="page">
      {/* ---- Header Bar (B9) ---- */}
      <div className="order-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <button className="btn btn-secondary" onClick={() => navigate('/orders')} style={{ padding: '6px 12px' }}>
            &larr; Orders
          </button>

          {/* Inline editable name (B10) */}
          {editingName ? (
            <input
              ref={nameRef}
              className="order-title-edit"
              value={nameValue}
              onChange={e => setNameValue(e.target.value)}
              onBlur={saveName}
              onKeyDown={handleNameKey}
            />
          ) : (
            <h2
              className="order-title-edit"
              style={{ cursor: 'pointer', margin: 0 }}
              onClick={startEditName}
              title="Click to edit"
            >
              {order.name}
            </h2>
          )}

          {/* Division badge */}
          {order.division && (
            <span
              className="division-badge"
              style={{ background: DIVISION_COLORS[order.division] ?? 'var(--text-muted)', color: '#fff' }}
            >
              {order.division}
            </span>
          )}

          {/* Status badge */}
          <span className={statusBadgeClass(order.status)}>{order.status.toUpperCase()}</span>

          {/* Revision badge (once submitted at least once) */}
          {isRevision && (
            <span className="tag tag-gray" title="Purchase order revision">Rev {revision}</span>
          )}
        </div>

        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
          Created {order.created_at?.slice(0, 10) ?? '—'}
          {order.updated_at && <> &middot; Updated {order.updated_at.slice(0, 10)}</>}
        </div>

        {(isDraft || order.distributor || repName) && (
          <div className="order-assoc">
            <span className="order-assoc-item">
              <span className="order-assoc-label">Distributor</span>
              {isDraft ? (
                <select className="assoc-select" value={order.distributor ?? ''}
                  onChange={e => updateAssocMut.mutate({ distributor: e.target.value || null, sales_rep_id: null })}>
                  <option value="">Select...</option>
                  {Object.keys(DISTRIBUTOR_NAMES).map(d => <option key={d} value={d}>{distributorName(d)}</option>)}
                </select>
              ) : <span>{order.distributor ? distributorName(order.distributor) : '—'}</span>}
            </span>
            <span className="order-assoc-item">
              <span className="order-assoc-label">Sales rep</span>
              {isDraft ? (
                <select className="assoc-select" value={order.sales_rep_id ?? ''} disabled={!order.distributor}
                  onChange={e => updateAssocMut.mutate({ sales_rep_id: e.target.value ? Number(e.target.value) : null })}>
                  <option value="">None</option>
                  {repsForDist.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              ) : <span>{repName ?? '—'}</span>}
            </span>
          </div>
        )}

        <div className="page-actions" style={{ marginTop: 8 }}>
          <button className="btn btn-secondary" onClick={() => copyWatchlistMut.mutate()} disabled={copyWatchlistMut.isPending}>
            {copyWatchlistMut.isPending ? 'Copying...' : 'Copy from Tracked'}
          </button>
          <button className="btn btn-secondary" onClick={() => cloneMut.mutate()} disabled={cloneMut.isPending}>
            {cloneMut.isPending ? 'Cloning...' : 'Clone Order'}
          </button>
          <button className="btn btn-secondary" onClick={() => openPreview()} disabled={previewLoading}
            title="See the purchase order PDF that gets sent to your rep">
            {previewLoading ? 'Loading PDF...' : 'Preview PDF'}
          </button>
          {isDraft && (
            <button className="btn btn-secondary" onClick={handleSaveOrder}
              title="Save changes (edits also save automatically)"
              style={savedFlash ? { color: 'var(--green)', borderColor: 'var(--green)' } : undefined}>
              {savedFlash ? 'Saved ✓' : 'Save'}
            </button>
          )}
          {isDraft && (
            <button className="btn" onClick={openSubmit} disabled={submitMut.isPending}>
              {submitMut.isPending ? 'Submitting...' : (isRevision ? `Re-submit (Rev ${defaultRevision})` : 'Submit Order')}
            </button>
          )}
          {!isDraft && (
            <button className="btn" onClick={() => reopenMut.mutate()} disabled={reopenMut.isPending}
              title="Bring this order back to draft so you can change items, the rep, and re-submit a new revision">
              {reopenMut.isPending ? 'Reopening...' : 'Reopen to revise'}
            </button>
          )}
          {isDraft && (
            <button className="btn btn-secondary" style={{ color: 'var(--red)', borderColor: 'var(--red)' }} onClick={() => setDeleteConfirm(true)}>
              Delete
            </button>
          )}
        </div>
      </div>

      {/* Delete confirmation */}
      {deleteConfirm && (
        <div className="modal-overlay" onClick={() => setDeleteConfirm(false)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 400 }}>
            <h3>Delete Order</h3>
            <p style={{ margin: '12px 0', fontSize: 14 }}>
              Are you sure you want to delete &quot;{order.name}&quot;? This cannot be undone.
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-secondary" onClick={() => setDeleteConfirm(false)}>Cancel</button>
              <button className="btn" style={{ background: 'var(--red)', borderColor: 'var(--red)' }} onClick={handleDelete} disabled={deleteMut.isPending}>
                {deleteMut.isPending ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {previewError && (
        <p style={{ color: 'var(--red)', fontSize: 12, marginTop: -4, marginBottom: 8 }}>{previewError}</p>
      )}

      {/* Submit confirmation */}
      {submitConfirm && (
        <div className="modal-overlay" onClick={() => setSubmitConfirm(false)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 480 }}>
            <h3>{isRevision ? 'Re-submit order' : 'Submit order'}</h3>
            <p style={{ margin: '12px 0', fontSize: 14 }}>
              {isRevision
                ? 'Submitting sends a revised purchase order to your sales rep and locks the order again.'
                : 'Submitting locks this order and emails the purchase order PDF to your sales rep.'}
            </p>
            {repEmail ? (
              <p style={{ fontSize: 14, margin: '0 0 12px' }}>
                We&apos;ll email <strong>{repName}</strong> at <strong>{repEmail}</strong>. Your email is set as
                reply-to, so the rep can answer you directly.
              </p>
            ) : repName ? (
              <p style={{ fontSize: 13, margin: '0 0 12px', color: '#b45309' }}>
                {repName} has no email on file. The order will be marked submitted but not emailed. Add an
                email under Configuration &rarr; Sales Reps, or use Preview PDF to send it yourself.
              </p>
            ) : (
              <p style={{ fontSize: 13, margin: '0 0 12px', color: '#b45309' }}>
                No sales rep is set for this order. It will be marked submitted but not emailed. Pick a
                distributor and rep above first.
              </p>
            )}

            {isRevision && (
              <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '10px 12px', marginBottom: 12 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13.5 }}>
                  <span style={{ fontWeight: 600 }}>Revision number</span>
                  <input
                    type="number" min={1}
                    value={revisionInput}
                    onChange={e => setRevisionInput(Math.max(1, Number(e.target.value) || 1))}
                    style={{ width: 70, padding: '5px 8px', border: '1px solid var(--border)', borderRadius: 6,
                      background: 'var(--bg)', color: 'var(--text)', fontSize: 14 }}
                  />
                  <span className="text-muted" style={{ fontSize: 12 }}>was Rev {revision}</span>
                </label>
                {repEmail && (
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginTop: 10 }}>
                    <input type="checkbox" checked={sendCancellation} onChange={e => setSendCancellation(e.target.checked)} />
                    Email the rep a cancellation of Rev {revision} first
                  </label>
                )}
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
              <button className="btn btn-secondary" onClick={() => openPreview(isRevision ? revisionInput : undefined)} disabled={previewLoading}>
                {previewLoading ? 'Loading...' : 'Preview PDF'}
              </button>
              <button className="btn btn-secondary" onClick={() => setSubmitConfirm(false)}>Cancel</button>
              <button className="btn"
                onClick={() => submitMut.mutate({ revision: isRevision ? revisionInput : defaultRevision, send_cancellation: sendCancellation })}
                disabled={submitMut.isPending}>
                {submitMut.isPending ? 'Submitting...' : (repEmail ? (isRevision ? 'Re-submit & send' : 'Submit & send') : 'Submit anyway')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Submit result */}
      {submitResult && (
        <div className="modal-overlay" onClick={() => setSubmitResult(null)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 440 }}>
            <h3>{submitResult.is_revision ? `Revision ${submitResult.revision} submitted` : 'Order submitted'}</h3>
            {submitResult.emailed ? (
              <p style={{ fontSize: 14, margin: '12px 0' }}>
                {submitResult.cancelled && (
                  <>The previous revision was cancelled and the </>
                )}
                {submitResult.cancelled ? 'revised ' : 'The '}purchase order
                {submitResult.is_revision ? ` (Revision ${submitResult.revision})` : ''} was emailed to{' '}
                <strong>{submitResult.rep_name}</strong> at <strong>{submitResult.to}</strong>.
              </p>
            ) : submitResult.reason === 'no_rep_email' ? (
              <p style={{ fontSize: 14, margin: '12px 0', color: '#b45309' }}>
                The order is submitted, but it wasn&apos;t emailed: the sales rep has no email on file. Use
                Preview PDF to download and send it yourself.
              </p>
            ) : submitResult.reason === 'email_disabled' ? (
              <p style={{ fontSize: 14, margin: '12px 0', color: '#b45309' }}>
                The order is submitted. Email delivery isn&apos;t enabled on this account, so nothing was sent.
                Use Preview PDF to download and send it.
              </p>
            ) : (
              <p style={{ fontSize: 14, margin: '12px 0', color: '#b45309' }}>
                The order is submitted, but the email could not be delivered. Use Preview PDF to download and
                send it.
              </p>
            )}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-secondary" onClick={() => { setSubmitResult(null); openPreview(); }}>
                Preview PDF
              </button>
              <button className="btn" onClick={() => setSubmitResult(null)}>Done</button>
            </div>
          </div>
        </div>
      )}

      {/* PDF preview */}
      {previewUrl && (
        <div className="modal-overlay" onClick={closePreview}>
          <div className="modal" onClick={e => e.stopPropagation()}
            style={{ maxWidth: 920, width: '92vw', height: '90vh', display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 8, flexWrap: 'wrap' }}>
              <h3 style={{ margin: 0 }}>Purchase order preview</h3>
              <div style={{ display: 'flex', gap: 8 }}>
                <a className="btn btn-secondary" href={previewUrl} target="_blank" rel="noopener noreferrer">Open in new tab</a>
                <a className="btn btn-secondary" href={previewUrl} download={`PO-${orderId}.pdf`}>Download</a>
                <button className="btn" onClick={closePreview}>Close</button>
              </div>
            </div>
            <iframe title="Purchase order preview" src={previewUrl}
              style={{ flex: 1, width: '100%', border: '1px solid var(--border)', borderRadius: 'var(--radius)' }} />
          </div>
        </div>
      )}

      {/* ---- Notes ---- */}
      <div style={{ marginBottom: 16 }}>
        {editingNotes ? (
          <textarea
            autoFocus
            value={displayNotes}
            onChange={e => setNotes(e.target.value)}
            onBlur={handleNotesBlur}
            rows={2}
            style={{
              width: '100%', maxWidth: 600, padding: '8px 12px',
              background: 'var(--surface)', border: '1px solid var(--accent)',
              borderRadius: 'var(--radius)', color: 'var(--text)', fontSize: 13,
              resize: 'vertical',
            }}
          />
        ) : (
          <p
            onClick={() => setEditingNotes(true)}
            style={{
              color: displayNotes ? 'var(--text)' : 'var(--text-muted)',
              fontSize: 13, cursor: 'text', maxWidth: 600, padding: '6px 0',
            }}
          >
            {displayNotes || 'Click to add notes...'}
          </p>
        )}
      </div>

      {/* ---- Division Selector (B8) ---- */}
      <div className="division-pills">
        <button
          className={`div-pill${!divisionFilter ? ' active' : ''}`}
          onClick={() => setDivisionFilter(null)}
        >
          All
        </button>
        {DIVISIONS.map(d => (
          <button
            key={d}
            className={`div-pill${divisionFilter === d ? ' active' : ''}`}
            onClick={() => setDivisionFilter(divisionFilter === d ? null : d)}
          >
            {d}
          </button>
        ))}
      </div>

      {/* ---- Payment Analysis Panel (B5) ---- */}
      <div className="payment-cards">
        <div className="payment-card payment-invoice">
          <div className="payment-card-label">Payment Needed Now</div>
          <div className="payment-card-value">{fmt(payment.invoice)}</div>
        </div>
        <div className="payment-card payment-rebate">
          <div className="payment-card-label">RIP Rebate</div>
          <div className="payment-card-value">{fmt(payment.rebate)}</div>
        </div>
        <div className="payment-card payment-effective">
          <div className="payment-card-label">Effective Cost</div>
          <div className="payment-card-value">{fmt(payment.effective)}</div>
        </div>
      </div>
      {payment.ripPct > 0 && (
        <p style={{ fontSize: 13, color: '#b45309', marginBottom: 12 }}>
          RIP as % of order: {payment.ripPct.toFixed(1)}%
        </p>
      )}

      {/* ---- By Category Breakdown (B6) ---- */}
      {categoryBreakdown.length > 0 && (
        <div className="table-container" style={{ marginBottom: 16 }}>
          <table>
            <thead>
              <tr>
                <th>Category</th>
                <th style={{ textAlign: 'right' }}>Items</th>
                <th style={{ textAlign: 'right' }}>Invoice</th>
                <th style={{ textAlign: 'right' }}>Rebate</th>
                <th style={{ textAlign: 'right' }}>Effective</th>
              </tr>
            </thead>
            <tbody>
              {categoryBreakdown.map(c => (
                <tr key={c.category}>
                  <td>{c.category}</td>
                  <td style={{ textAlign: 'right' }}>{c.items}</td>
                  <td style={{ textAlign: 'right', fontFamily: 'monospace' }}>{fmt(c.invoice)}</td>
                  <td style={{ textAlign: 'right', fontFamily: 'monospace', color: '#b45309' }}>{fmt(c.rebate)}</td>
                  <td style={{ textAlign: 'right', fontFamily: 'monospace', color: 'var(--green)', fontWeight: 700 }}>{fmt(c.effective)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ---- Recommendations Banner (B7) ---- */}
      {recommendations.length > 0 && (
        <div className="recs-banner">
          <div className="recs-header" onClick={() => setRecsOpen(!recsOpen)}>
            <span style={{ fontWeight: 600, fontSize: 14 }}>
              Recommendations ({recommendations.length})
            </span>
            <span style={{ transform: recsOpen ? 'rotate(90deg)' : 'none', transition: 'transform 0.2s', display: 'inline-block' }}>
              &#9656;
            </span>
          </div>
          {recsOpen && recommendations.map((rec, i) => (
            <div key={i} className="rec-item">
              <span className={recBadgeClass(rec.type)}>{recBadgeLabel(rec.type)}</span>
              <span style={{ fontSize: 13, flex: 1 }}>{rec.message}</span>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{rec.priority}</span>
            </div>
          ))}
        </div>
      )}

      {/* ---- Product Table (B3, B4) ---- */}
      <div className="table-container" style={{ marginBottom: 16 }}>
        <table>
          <thead>
            <tr>
              <th>Product</th>
              <th className="hide-md">Brand</th>
              <th className="hide-lg">Category</th>
              <th className="hide-lg">Div</th>
              <th style={{ textAlign: 'right' }}>Case Cost</th>
              <th>RIP by Case</th>
              <th style={{ textAlign: 'right' }}>After RIP</th>
              <th style={{ textAlign: 'center' }}>Qty Cases</th>
              <th className="hide-sm" style={{ textAlign: 'center' }}>Qty Btls</th>
              <th className="hide-md" style={{ textAlign: 'right' }}>Line Invoice</th>
              <th className="hide-md" style={{ textAlign: 'right' }}>Line RIP</th>
              <th style={{ textAlign: 'right' }}>Line Effective</th>
              <th className="hide-md" style={{ textAlign: 'right' }}>Retail/btl</th>
              <th className="hide-md" style={{ textAlign: 'right' }}>GP% (deal / list)</th>
              <th className="hide-lg">Notes</th>
              <th>Recs</th>
            </tr>
          </thead>
          <tbody>
            {filteredLines.length === 0 && (
              <tr><td colSpan={16} className="empty">No line items. Add products or copy from your tracked list.</td></tr>
            )}
            {filteredLines.map(line => {
              const caseCost = parseNum(line.case_cost) || 0;
              const known = line.case_cost != null;  // matched a current product
              const bestSave = getBestSave(line);
              const afterRip = caseCost - bestSave;
              const lineInv = computeLineInvoice(line);
              const lineReb = computeLineRebate(line);
              const lineEff = computeLineEffective(line);
              const lineRecs = getLineRecommendations(line);

              return (
                <tr key={line.id}>
                  {/* Product name (clickable) + subtitle */}
                  <td>
                    <span
                      style={{ color: 'var(--accent)', cursor: 'pointer', fontWeight: 500 }}
                      onClick={() => openQuickView(line.product_name, line.wholesaler)}
                    >
                      {line.description || line.product_name}
                    </span>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                      {line.size || line.unit_volume || ''}{line.pack ? ` / ${line.pack}pk` : ''}{line.upc ? ` \u00b7 ${line.upc}` : ''}
                    </div>
                    {line.combo_code && (
                      <span className="combo-line-badge" title="Part of a combo bundle">\ud83c\udf81 Combo #{line.combo_code}</span>
                    )}
                  </td>

                  {/* Brand */}
                  <td className="hide-md" style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    {line.brand || '—'}
                  </td>

                  {/* Category */}
                  <td className="hide-lg" style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    {line.category || '—'}
                  </td>

                  {/* Divisions */}
                  <td className="hide-lg" style={{ fontSize: 11, fontFamily: 'monospace', color: 'var(--text-muted)' }}>
                    {line.divisions || '—'}
                  </td>

                  {/* Case Cost (with per-bottle) */}
                  <td style={{ textAlign: 'right', fontFamily: 'monospace' }}>
                    {known ? (
                      <div style={{ lineHeight: 1.25 }}>
                        <div>{fmt(caseCost)}</div>
                        {line.pack && line.pack > 1 && (
                          <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{fmt(caseCost / line.pack)}/btl</div>
                        )}
                      </div>
                    ) : '—'}
                  </td>

                  {/* RIP by Case (B4) - all tiers listed */}
                  <td>
                    <RipTierCell tiers={line.rip_tiers} qtyCases={line.qty_cases || 0} />
                  </td>

                  {/* After RIP (with per-bottle) */}
                  <td style={{ textAlign: 'right', fontFamily: 'monospace', color: bestSave > 0 ? 'var(--green)' : undefined }}>
                    {known ? (
                      <div style={{ lineHeight: 1.25 }}>
                        <div>{fmt(afterRip)}</div>
                        {line.pack && line.pack > 1 && (
                          <div style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 400 }}>{fmt(afterRip / line.pack)}/btl</div>
                        )}
                      </div>
                    ) : '—'}
                  </td>

                  {/* Qty Cases */}
                  <td style={{ textAlign: 'center' }}>
                    <QtyStepper
                      label="CS"
                      value={line.qty_cases || 0}
                      onChange={v => handleQtyChange(line, 'qty_cases', v)}
                    />
                  </td>

                  {/* Qty Bottles */}
                  <td className="hide-sm" style={{ textAlign: 'center' }}>
                    <QtyStepper
                      label="Btl"
                      value={line.qty_units || 0}
                      onChange={v => handleQtyChange(line, 'qty_units', v)}
                    />
                  </td>

                  {/* Line Invoice */}
                  <td className="hide-md" style={{ textAlign: 'right', fontFamily: 'monospace' }}>
                    {known ? fmt(lineInv) : '—'}
                  </td>

                  {/* Line RIP */}
                  <td className="hide-md" style={{ textAlign: 'right', fontFamily: 'monospace', color: '#b45309', fontWeight: lineReb > 0 ? 700 : 400 }}>
                    {known ? fmt(lineReb) : '—'}
                  </td>

                  {/* Line Effective */}
                  <td style={{ textAlign: 'right', fontFamily: 'monospace', color: 'var(--green)', fontWeight: 700 }}>
                    {known ? fmt(lineEff) : '—'}
                  </td>

                  {/* Retail / btl (editable shelf price; persists) */}
                  <td className="hide-md" style={{ textAlign: 'right' }}>
                    <RetailInput
                      value={line.retail_price ?? null}
                      onSave={(v) => updateLineMut.mutate({ lineId: line.id, data: { retail_price: v } as Partial<OrderLine> })}
                    />
                  </td>

                  {/* GP% at list (full) cost vs deal (effective, after RIP/discount) cost */}
                  <td className="hide-md" style={{ textAlign: 'right', fontFamily: 'monospace' }}>
                    {(() => {
                      const pack = line.pack || 0;
                      const retail = line.retail_price ?? 0;
                      if (!known || !retail || retail <= 0 || pack <= 0) return <span className="text-muted" title="Enter your retail $/btl in the Retail/btl column to see gross-profit %">— set retail</span>;
                      const fullGp = ((retail - caseCost / pack) / retail) * 100;
                      const dealGp = ((retail - afterRip / pack) / retail) * 100;
                      const tone = (g: number) => g >= 25 ? 'var(--green)' : g >= 15 ? 'var(--yellow)' : 'var(--red)';
                      return (
                        <div style={{ lineHeight: 1.25 }}>
                          <div style={{ color: tone(dealGp), fontWeight: 700 }}>{dealGp.toFixed(1)}% <span style={{ fontSize: 9, color: 'var(--text-muted)', fontWeight: 400 }}>deal</span></div>
                          <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{fullGp.toFixed(1)}% list</div>
                        </div>
                      );
                    })()}
                  </td>

                  {/* Notes */}
                  <td className="hide-lg">
                    <InlineNote
                      value={line.notes ?? ''}
                      onSave={(v) => handleNoteBlur(line, v)}
                    />
                  </td>

                  {/* Recs + Remove */}
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                      {lineRecs.map((r, i) => (
                        <span key={i} className={recBadgeClass(r.type)} title={r.message}>
                          {recBadgeLabel(r.type)}
                        </span>
                      ))}
                      {isDraft && (
                        <button
                          className="btn-icon"
                          title="Remove line"
                          onClick={() => removeLineMut.mutate(line.id)}
                          style={{ color: 'var(--red)', fontSize: 16, padding: '2px 6px' }}
                        >
                          &#128465;
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* ---- Add Product (smart search, draft only) ---- */}
      {isDraft && (
        <SmartAddProduct
          pending={addLineMut.isPending}
          wholesaler={order.distributor ?? undefined}
          onAdd={(p) => addLineMut.mutate({
            product_name: p.product_name,
            wholesaler: p.wholesaler,
            upc: p.upc,
            unit_volume: p.unit_volume,
          } as Partial<OrderLine>)}
        />
      )}
      {addProductError && (
        <p style={{ color: 'var(--red)', fontSize: 12, marginTop: 4 }}>{addProductError}</p>
      )}

      {/* ---- Summary Footer (B13) ---- */}
      <div className="order-footer">
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, textTransform: 'uppercase', color: 'var(--text-muted)' }}>
            Items: <strong style={{ color: 'var(--text)' }}>{summary.items}</strong>
          </span>
          <span style={{ fontSize: 12, textTransform: 'uppercase', color: 'var(--text-muted)' }}>
            Cases: <strong style={{ color: 'var(--text)' }}>{summary.cases}</strong>
          </span>
          <span style={{ fontSize: 12, textTransform: 'uppercase', color: 'var(--text-muted)' }}>
            Bottles: <strong style={{ color: 'var(--text)' }}>{summary.bottles}</strong>
          </span>
        </div>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontFamily: 'monospace' }}>
          <span style={{ fontSize: 13 }}>
            Invoice: <strong>{fmt(payment.invoice)}</strong>
          </span>
          <span style={{ fontSize: 13, color: '#b45309' }}>
            RIP Rebate: <strong>{fmt(payment.rebate)}</strong>
          </span>
          <span style={{ fontSize: 13, color: 'var(--green)', fontWeight: 700 }}>
            Effective: {fmt(payment.effective)}
          </span>
        </div>
      </div>
    </div>
  );
}

// ---- RIP Tier Cell (B4) ----
function RipTierCell({ tiers, qtyCases }: { tiers?: OrderRipTier[]; qtyCases: number }) {
  if (!tiers || tiers.length === 0) {
    return <span style={{ color: 'var(--text-muted)' }}>&mdash;</span>;
  }

  // Find best unmet tier
  const sorted = [...tiers].sort((a, b) => b.tier_cases - a.tier_cases);
  const bestUnmet = sorted.find(t => qtyCases < t.tier_cases);

  return (
    <div className="rip-tier-cell">
      {tiers.map((tier, i) => {
        const met = qtyCases >= tier.tier_cases;
        const isBest = !met && tier === bestUnmet;
        const save = parseNum(tier.save_amount);
        const rowClass = met ? 'rip-tier-row rip-tier-met' : isBest ? 'rip-tier-row rip-tier-best' : 'rip-tier-row';
        // Three clearly distinct states: green = unlocked at your qty,
        // blue = the best tier you haven't reached yet, grey = other tiers.
        const badgeBg = met ? 'color-mix(in srgb, var(--green) 18%, transparent)'
          : isBest ? 'color-mix(in srgb, var(--accent) 16%, transparent)'
          : 'color-mix(in srgb, var(--text-muted) 14%, transparent)';
        const tone = met ? 'var(--green)' : isBest ? 'var(--accent)' : 'var(--text-muted)';

        return (
          <div key={i} className={rowClass}>
            <span className="rip-tier-badge" style={{ background: badgeBg, color: tone }}>
              {tier.tier}
            </span>
            <span style={{ fontSize: 12, fontFamily: 'monospace', color: met ? 'var(--green)' : isBest ? 'var(--accent)' : 'var(--text)' }}>
              save {fmt(save)}/cs
            </span>
            {met && <span style={{ color: 'var(--green)', fontWeight: 700, fontSize: 10 }} title="Unlocked at your current quantity">&#10003; UNLOCKED</span>}
            {isBest && <span style={{ color: 'var(--accent)', fontSize: 10, fontWeight: 700 }} title="Best value tier you haven't reached yet">BEST VALUE</span>}
          </div>
        );
      })}
    </div>
  );
}

// ---- Smart add-to-order search (typeahead by name + size + code) ----
function SmartAddProduct({ onAdd, pending, wholesaler }: { onAdd: (p: Product) => void; pending: boolean; wholesaler?: string }) {
  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');
  const [open, setOpen] = useState(false);
  useEffect(() => { const t = setTimeout(() => setDq(q.trim()), 250); return () => clearTimeout(t); }, [q]);
  const { data, isFetching } = useQuery({
    queryKey: ['order-add-search', dq, wholesaler],
    // Scoped to the order's distributor so you can only add matching products.
    queryFn: () => catalog.search({ q: dq, limit: 8, wholesaler: wholesaler || undefined }),
    enabled: dq.length >= 2,
  });
  const results = data?.items ?? [];
  return (
    <div className="add-product-panel" style={{ position: 'relative', display: 'block' }}>
      <input
        type="text"
        className="add-search-input"
        placeholder="Search a product to add (e.g. glenlivet 12 375ml, or a UPC)"
        value={q}
        onChange={e => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => { if (q.trim().length >= 2) setOpen(true); }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        disabled={pending}
      />
      {open && dq.length >= 2 && (
        <ul className="add-suggest">
          {results.length === 0 ? (
            <li className="add-suggest-empty">{isFetching ? 'Searching...' : 'No matches. Try a different name or size.'}</li>
          ) : results.map((p, i) => (
            <li key={`${p.wholesaler}-${p.upc}-${i}`} onMouseDown={() => { onAdd(p); setQ(''); setDq(''); setOpen(false); }}>
              <div className="add-suggest-main">
                <strong>{p.product_name}</strong>
                <small>
                  {distributorName(p.wholesaler)}
                  {p.unit_volume ? ` · ${p.unit_qty ? `${p.unit_qty}×` : ''}${p.unit_volume}` : ''}
                  {p.product_type ? ` · ${p.product_type}` : ''}
                  {p.upc ? ` · ${p.upc}` : ''}
                </small>
              </div>
              <span className="add-suggest-price num">${Number(p.frontline_case_price).toFixed(2)}/cs</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---- Retail price input (per bottle) — powers the GP% column ----
function RetailInput({ value, onSave }: { value: number | null; onSave: (v: number | null) => void }) {
  const [text, setText] = useState(value != null ? String(value) : '');
  useEffect(() => { setText(value != null ? String(value) : ''); }, [value]);
  function commit() {
    const t = text.trim();
    const n = t === '' ? null : parseFloat(t);
    const norm = (n != null && !isNaN(n)) ? n : null;
    if (norm !== value) onSave(norm);
  }
  return (
    <input
      className="retail-input"
      inputMode="decimal"
      placeholder="$/btl"
      value={text}
      onChange={e => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
    />
  );
}

// ---- Inline Note ----
function InlineNote({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(value);

  useEffect(() => { setText(value); }, [value]);

  function handleBlur() {
    setEditing(false);
    if (text !== value) onSave(text);
  }

  if (editing) {
    return (
      <input
        className="inline-edit-input"
        autoFocus
        value={text}
        onChange={e => setText(e.target.value)}
        onBlur={handleBlur}
        onKeyDown={e => { if (e.key === 'Enter') handleBlur(); if (e.key === 'Escape') { setText(value); setEditing(false); } }}
      />
    );
  }

  return (
    <span
      className="inline-edit-input"
      style={{ cursor: 'text', color: value ? 'var(--text)' : 'var(--text-muted)', fontStyle: value ? 'normal' : 'italic' }}
      onClick={() => setEditing(true)}
    >
      {value || 'Add note...'}
    </span>
  );
}
