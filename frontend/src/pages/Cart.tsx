import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Trash2, Clock, Send, ShoppingCart, Plus, Search } from 'lucide-react';
import { cart as cartApi, salesReps as repsApi, catalog, type CartItem, type Product } from '../lib/api';
import ProductThumb from '../components/ProductThumb';
import { shortUnit } from '../components/CatalogTable';
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

const money = (v?: number | null) => (v == null ? '$0.00' : `$${v.toFixed(2)}`);

// The price actually used per case/bottle (combo price when intact, else the
// individual effective/list price). Drives line totals and the group/cart totals.
function unitPrices(it: CartItem) {
  const perCase = it.effective_case_price ?? it.frontline_case_price ?? 0;
  const perBtl = it.effective_unit_price ?? it.frontline_unit_price ?? 0;
  return { perCase, perBtl };
}
function lineTotal(it: CartItem): number {
  const { perCase, perBtl } = unitPrices(it);
  return (it.qty_cases || 0) * perCase + (it.qty_units || 0) * perBtl;
}

// A unique-but-stable colour per combo id, so lines from the same bundle share a
// sticker and different bundles are easy to tell apart at a glance.
function comboHue(code: string): number {
  let h = 0;
  for (let i = 0; i < code.length; i++) h = (h * 31 + code.charCodeAt(i)) % 360;
  return h;
}
function ComboBadge({ code }: { code: string }) {
  const h = comboHue(code);
  return (
    <span title={`Part of combo #${code} — priced as a bundle while all items are in the cart`} style={{
      fontSize: 10, fontWeight: 700, padding: '1px 8px', borderRadius: 10, whiteSpace: 'nowrap',
      background: `hsl(${h} 75% 93%)`, color: `hsl(${h} 70% 32%)`, border: `1px solid hsl(${h} 60% 80%)`,
    }}>🎁 Combo #{code}</span>
  );
}

// Search box that adds any catalogue product straight into the cart.
function AddToCartSearch({ onAdd, adding }: { onAdd: (p: Product) => void; adding: boolean }) {
  const [q, setQ] = useState('');
  const { data } = useQuery({
    queryKey: ['cart-add-search', q],
    queryFn: () => catalog.search({ q, limit: 8 }),
    enabled: q.trim().length >= 2,
  });
  const results = data?.items ?? [];
  return (
    <div className="panel" style={{ padding: 12, marginTop: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <Search size={16} /><strong>Add a product to the cart</strong>
      </div>
      <input value={q} onChange={e => setQ(e.target.value)}
        placeholder="Search by product name or barcode, then add..."
        style={{ width: '100%', maxWidth: 520, padding: '6px 10px', fontSize: 13 }} />
      {q.trim().length >= 2 && (
        <div style={{ marginTop: 8, border: '1px solid var(--border)', borderRadius: 'var(--radius)', maxWidth: 640, overflow: 'hidden' }}>
          {results.length === 0 && <div style={{ padding: 10, fontSize: 13, color: 'var(--text-muted)' }}>No matches.</div>}
          {results.map((p, i) => {
            const price = p.effective_case_price ?? p.frontline_case_price;
            return (
              <div key={`${p.product_name}|${p.wholesaler}|${i}`}
                style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px', borderTop: i ? '1px solid var(--border)' : undefined }}>
                <ProductThumb src={p.image_url} alt={p.product_name} size={36} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{p.product_name}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    {distributorName(p.wholesaler)}{p.unit_volume ? ` · ${p.unit_volume}` : ''} · Case {money(price)}
                  </div>
                </div>
                <button className="btn btn-secondary btn-sm" disabled={adding}
                  onClick={() => onAdd(p)}><Plus size={14} /> Add</button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function Cart() {
  const qc = useQueryClient();
  const [result, setResult] = useState<string | null>(null);
  const { data } = useQuery({ queryKey: ['cart'], queryFn: cartApi.get });
  const { data: reps } = useQuery({ queryKey: ['sales-reps'], queryFn: repsApi.list });
  const items = data?.items ?? [];
  const groupNotes = data?.group_notes ?? {};
  const active = items.filter(i => !i.saved_for_later);
  const saved = items.filter(i => i.saved_for_later);

  const invalidate = () => qc.invalidateQueries({ queryKey: ['cart'] });
  const upd = useMutation({
    mutationFn: (v: { id: number; patch: Parameters<typeof cartApi.update>[1] }) => cartApi.update(v.id, v.patch),
    onSuccess: invalidate,
  });
  const del = useMutation({ mutationFn: (id: number) => cartApi.remove(id), onSuccess: invalidate });
  const add = useMutation({
    mutationFn: (p: Product) => cartApi.add({
      product_name: p.product_name, wholesaler: p.wholesaler,
      upc: p.upc ?? undefined, unit_volume: p.unit_volume ?? undefined, qty_cases: 1, qty_units: 0,
    }),
    onSuccess: invalidate,
  });
  const assign = useMutation({
    mutationFn: (v: { wholesaler: string; repId: number | null }) => cartApi.assignRep(v.wholesaler, v.repId),
    onSuccess: invalidate,
  });
  const groupNote = useMutation({
    mutationFn: (v: { wholesaler: string; note: string }) => cartApi.groupNote(v.wholesaler, v.note),
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

  const groups = useMemo(() => {
    const m = new Map<string, CartItem[]>();
    for (const it of active) {
      if (!m.has(it.wholesaler)) m.set(it.wholesaler, []);
      m.get(it.wholesaler)!.push(it);
    }
    return [...m.entries()];
  }, [active]);

  const cartTotal = useMemo(() => active.reduce((s, it) => s + lineTotal(it), 0), [active]);

  const repsFor = (w: string) => (reps ?? []).filter(r => r.distributor === w);
  const anyUnassigned = active.some(i => !i.sales_rep_id);

  const renderItem = (it: CartItem, saving = false) => {
    const tiers = it.tiers ?? [];
    const { perCase } = unitPrices(it);
    const showCombo = !!it.combo_code && !!it.combo_intact;
    return (
      <div key={it.id} style={{ padding: '10px 0', borderTop: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <ProductThumb src={it.image_url} alt={it.product_name} size={56} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              {it.product_name}
              {showCombo && <ComboBadge code={it.combo_code!} />}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              {distributorName(it.wholesaler)}{it.unit_volume ? ` · ${it.unit_volume}` : ''}{it.upc ? ` · ${it.upc}` : ''}
            </div>
            {it.frontline_case_price != null && (
              <div style={{ fontSize: 12, marginTop: 2 }}>
                Case {money(it.frontline_case_price)}
                {it.frontline_unit_price != null && <> · Btl {money(it.frontline_unit_price)}</>}
                {' · '}{showCombo ? 'Combo' : 'Eff'} <span className="text-green">{money(perCase)}/cs</span>
                {it.total_savings_per_case ? <> · Save <span className="text-green">{money(it.total_savings_per_case)}/cs</span></> : null}
              </div>
            )}
          </div>
          {!saving && (
            <>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <Stepper label="Case" value={it.qty_cases} onChange={n => upd.mutate({ id: it.id, patch: { qty_cases: n } })} />
                <Stepper label="Btl" value={it.qty_units} onChange={n => upd.mutate({ id: it.id, patch: { qty_units: n } })} />
              </div>
              <div style={{ minWidth: 78, textAlign: 'right', fontWeight: 700 }} title="Line total">
                {money(lineTotal(it))}
              </div>
              <button className="btn btn-secondary btn-sm"
                onClick={() => upd.mutate({ id: it.id, patch: { saved_for_later: true } })}><Clock size={13} /> Save for later</button>
            </>
          )}
          {saving && (
            <button className="btn btn-secondary btn-sm"
              onClick={() => upd.mutate({ id: it.id, patch: { saved_for_later: false } })}>Move to cart</button>
          )}
          <button className="btn btn-secondary btn-sm" title="Remove" onClick={() => del.mutate(it.id)}><Trash2 size={14} /></button>
        </div>

        {/* Deal tiers — same info as the catalogue, to tweak qty last minute. Combo
            lines hide these (the bundle is the deal). */}
        {tiers.length > 0 && (
          <div style={{ marginLeft: 68, marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: '4px 8px' }}>
            {tiers.map((t, i) => (
              <span key={i} className={`source-badge source-${t.source}`} style={{ fontSize: 11 }}
                title={t.description || undefined}>
                {t.source === 'discount' ? 'DISC' : 'RIP'} · Buy {t.qty} {shortUnit(t.unit)} = <strong>${t.amount.toFixed(2)}</strong>
                {t.save_per_case != null ? ` (save $${t.save_per_case.toFixed(2)}/cs)` : ''}
              </span>
            ))}
          </div>
        )}

        <input
          defaultValue={it.notes ?? ''}
          placeholder="Add a note (goes on this order line)"
          onBlur={e => { if (e.target.value !== (it.notes ?? '')) upd.mutate({ id: it.id, patch: { notes: e.target.value } }); }}
          style={{ marginLeft: 68, marginTop: 6, width: 'calc(100% - 68px)', maxWidth: 420, fontSize: 12, padding: '3px 6px' }}
        />
      </div>
    );
  };

  return (
    <div className="page">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}><ShoppingCart size={22} /> Cart</h2>
        <button className="btn btn-primary" disabled={active.length === 0 || send.isPending}
          onClick={() => { setResult(null); send.mutate(); }}>
          <Send size={16} /> {send.isPending ? 'Sending...' : 'Send All Orders to Reps'}
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

      {/* Cart total bar */}
      {active.length > 0 && (
        <div className="panel" style={{ padding: '10px 14px', marginTop: 10, display: 'flex',
          alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, borderColor: 'var(--accent)' }}>
          <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
            {active.length} item{active.length === 1 ? '' : 's'} across {groups.length} sales rep group{groups.length === 1 ? '' : 's'}
          </span>
          <span style={{ fontSize: 16 }}>Cart total: <strong className="text-green">{money(cartTotal)}</strong></span>
        </div>
      )}

      <AddToCartSearch onAdd={p => add.mutate(p)} adding={add.isPending} />

      {active.length === 0 && saved.length === 0 && (
        <p style={{ color: 'var(--text-muted)', marginTop: 16 }}>Your cart is empty. Search above, or use the + button / right-click anywhere.</p>
      )}

      {groups.map(([wholesaler, groupItems]) => {
        const repId = groupItems.find(i => i.sales_rep_id)?.sales_rep_id ?? '';
        const options = repsFor(wholesaler);
        const selRep = options.find(r => r.id === Number(repId));
        const contact = selRep ? [selRep.phone, selRep.email].filter(Boolean).join(' · ') : '';
        const groupTotal = groupItems.reduce((s, it) => s + lineTotal(it), 0);
        return (
          <div key={wholesaler} className="panel" style={{ padding: 12, marginTop: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
              <strong>{distributorName(wholesaler)}</strong>
              <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13 }}>Group total: <strong className="text-green">{money(groupTotal)}</strong></span>
                <label style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
                  Sales rep:
                  <select value={repId}
                    onChange={e => assign.mutate({ wholesaler, repId: e.target.value ? Number(e.target.value) : null })}>
                    <option value="">— select rep —</option>
                    {options.map(r => <option key={r.id} value={r.id}>{r.name}{r.division ? ` (${r.division})` : ''}</option>)}
                  </select>
                </label>
              </div>
            </div>
            {contact && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{contact}</div>}
            <input
              defaultValue={groupNotes[wholesaler] ?? ''}
              placeholder="Order note for this rep (header note on their order)"
              onBlur={e => { if (e.target.value !== (groupNotes[wholesaler] ?? '')) groupNote.mutate({ wholesaler, note: e.target.value }); }}
              style={{ marginTop: 8, width: '100%', maxWidth: 480, fontSize: 12, padding: '4px 8px' }}
            />
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
