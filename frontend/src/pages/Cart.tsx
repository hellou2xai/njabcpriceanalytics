import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Trash2, Clock, Send, ShoppingCart } from 'lucide-react';
import { cart as cartApi, salesReps as repsApi, type CartItem } from '../lib/api';
import ProductThumb from '../components/ProductThumb';
import { distributorName } from '../lib/distributors';

function Stepper({ label, value, onChange }: { label: string; value: number; onChange: (n: number) => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      <span style={{ fontSize: 10, color: 'var(--text-muted)', width: 28 }}>{label}</span>
      <button type="button" className="btn btn-secondary btn-sm" disabled={value <= 0}
        onClick={() => onChange(Math.max(0, value - 1))}>-</button>
      <input type="number" min={0} value={value === 0 ? '' : value} placeholder="0"
        style={{ width: 52, textAlign: 'center' }}
        onChange={e => onChange(Math.max(0, parseInt(e.target.value.replace(/[^0-9]/g, '') || '0', 10)))} />
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => onChange(value + 1)}>+</button>
    </div>
  );
}

export default function Cart() {
  const qc = useQueryClient();
  const [result, setResult] = useState<string | null>(null);
  const { data } = useQuery({ queryKey: ['cart'], queryFn: cartApi.get });
  const { data: reps } = useQuery({ queryKey: ['sales-reps'], queryFn: repsApi.list });
  const items = data?.items ?? [];
  const active = items.filter(i => !i.saved_for_later);
  const saved = items.filter(i => i.saved_for_later);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['cart'] });
  };
  const upd = useMutation({
    mutationFn: (v: { id: number; patch: Parameters<typeof cartApi.update>[1] }) => cartApi.update(v.id, v.patch),
    onSuccess: invalidate,
  });
  const del = useMutation({ mutationFn: (id: number) => cartApi.remove(id), onSuccess: invalidate });
  const assign = useMutation({
    mutationFn: (v: { wholesaler: string; repId: number | null }) => cartApi.assignRep(v.wholesaler, v.repId),
    onSuccess: invalidate,
  });
  const send = useMutation({
    mutationFn: () => cartApi.send(),
    onSuccess: (r) => {
      invalidate();
      qc.invalidateQueries({ queryKey: ['orders'] });
      const parts = [`Sent ${r.sent} order${r.sent === 1 ? '' : 's'}`];
      if (r.skipped_no_rep) parts.push(`${r.skipped_no_rep} item(s) skipped — assign a rep and resend`);
      setResult(parts.join('. '));
    },
  });

  // Group active items by distributor.
  const groups = useMemo(() => {
    const m = new Map<string, CartItem[]>();
    for (const it of active) {
      if (!m.has(it.wholesaler)) m.set(it.wholesaler, []);
      m.get(it.wholesaler)!.push(it);
    }
    return [...m.entries()];
  }, [active]);

  const repsFor = (w: string) => (reps ?? []).filter(r => r.distributor === w);
  const anyUnassigned = active.some(i => !i.sales_rep_id);

  const renderItem = (it: CartItem, saving = false) => (
    <div key={it.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0', borderTop: '1px solid var(--border)' }}>
      <ProductThumb src={it.image_url} alt={it.product_name} size={56} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600 }}>{it.product_name}</div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          {distributorName(it.wholesaler)}{it.unit_volume ? ` · ${it.unit_volume}` : ''}{it.upc ? ` · ${it.upc}` : ''}
        </div>
        <input
          defaultValue={it.notes ?? ''}
          placeholder="Add a note (goes on this order line)"
          onBlur={e => { if (e.target.value !== (it.notes ?? '')) upd.mutate({ id: it.id, patch: { notes: e.target.value } }); }}
          style={{ marginTop: 4, width: '100%', maxWidth: 380, fontSize: 12, padding: '3px 6px' }}
        />
      </div>
      {!saving && (
        <>
          <Stepper label="Case" value={it.qty_cases} onChange={n => upd.mutate({ id: it.id, patch: { qty_cases: n } })} />
          <Stepper label="Btl" value={it.qty_units} onChange={n => upd.mutate({ id: it.id, patch: { qty_units: n } })} />
          <button className="btn btn-secondary btn-sm" title="Save for later"
            onClick={() => upd.mutate({ id: it.id, patch: { saved_for_later: true } })}><Clock size={14} /></button>
        </>
      )}
      {saving && (
        <button className="btn btn-secondary btn-sm"
          onClick={() => upd.mutate({ id: it.id, patch: { saved_for_later: false } })}>Move to cart</button>
      )}
      <button className="btn btn-secondary btn-sm" title="Remove" onClick={() => del.mutate(it.id)}><Trash2 size={14} /></button>
    </div>
  );

  return (
    <div className="page">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}><ShoppingCart size={22} /> Cart</h2>
        <button className="btn btn-primary" disabled={active.length === 0 || send.isPending}
          onClick={() => { setResult(null); send.mutate(); }}>
          <Send size={16} /> {send.isPending ? 'Sending...' : 'Send to all reps'}
        </button>
      </div>

      {active.length > 0 && (
        <p style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 4 }}>
          Please follow up with your sales rep after you send the order.
        </p>
      )}

      {result && <div className="panel" style={{ padding: 10, marginTop: 8, borderColor: 'var(--green)' }}>{result}</div>}
      {anyUnassigned && active.length > 0 && (
        <div className="panel" style={{ padding: 10, marginTop: 8 }}>
          <span style={{ color: 'var(--text-muted)' }}>Some items have no sales rep. Pick a rep per distributor below so they can be sent.</span>
        </div>
      )}

      {active.length === 0 && saved.length === 0 && (
        <p style={{ color: 'var(--text-muted)', marginTop: 16 }}>Your cart is empty. Add products with the + button or right-click anywhere.</p>
      )}

      {groups.map(([wholesaler, groupItems]) => {
        const repId = groupItems.find(i => i.sales_rep_id)?.sales_rep_id ?? '';
        const options = repsFor(wholesaler);
        const selRep = options.find(r => r.id === Number(repId));
        const contact = selRep ? [selRep.phone, selRep.email].filter(Boolean).join(' · ') : '';
        return (
          <div key={wholesaler} className="panel" style={{ padding: 12, marginTop: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
              <strong>{distributorName(wholesaler)}</strong>
              <label style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
                Sales rep:
                <select value={repId}
                  onChange={e => assign.mutate({ wholesaler, repId: e.target.value ? Number(e.target.value) : null })}>
                  <option value="">— select rep —</option>
                  {options.map(r => <option key={r.id} value={r.id}>{r.name}{r.division ? ` (${r.division})` : ''}</option>)}
                </select>
              </label>
            </div>
            {contact && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{contact}</div>}
            {options.length === 0 && (
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                No reps for this distributor yet — add one under Sales Reps.
              </div>
            )}
            {groupItems.map(it => renderItem(it))}
          </div>
        );
      })}

      {saved.length > 0 && (
        <div className="panel" style={{ padding: 12, marginTop: 20 }}>
          <h3 style={{ margin: '0 0 4px', display: 'flex', alignItems: 'center', gap: 8 }}><Clock size={18} /> Saved for later</h3>
          {saved.map(it => renderItem(it, true))}
        </div>
      )}
    </div>
  );
}
