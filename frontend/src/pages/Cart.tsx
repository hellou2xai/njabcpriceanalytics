import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Trash2, Clock, Send, ShoppingCart, Plus, Search, ArrowUpFromLine, Eraser, Sparkles } from 'lucide-react';
import { cart as cartApi, salesReps as repsApi, catalog, type CartItem, type Product, type SavingsRec } from '../lib/api';
import ProductThumb from '../components/ProductThumb';
import SavingsAnalysis from '../components/SavingsAnalysis';
import DealSparkline from '../components/DealSparkline';
import DealTimingSticker, { everyDayFromTiers } from '../components/DealTimingSticker';
import { windowBadge, fmtDateRange } from '../lib/dealDates';
import { useProductQuickView } from '../components/ProductQuickView';
import { useDialog } from '../components/Dialog';
import { shortUnit } from '../components/CatalogTable';
import { distributorName, abgSku, skuLabel, priceUnit, perUnitAbbr, isKegUnit } from '../lib/distributors';
import { ErrorState, EmptyState } from '../components/DataState';
import DataLoading from '../components/DataLoading';

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
    <span data-tour="cart-combo" title={`Part of combo #${code}, priced as a bundle while all items are in the cart`} style={{
      fontSize: 10, fontWeight: 700, padding: '1px 8px', borderRadius: 10, whiteSpace: 'nowrap',
      background: `hsl(${h} 75% 93%)`, color: `hsl(${h} 70% 32%)`, border: `1px solid hsl(${h} 60% 80%)`,
    }}>🎁 Combo #{code}</span>
  );
}

// Same hue scheme for RIP rebates, so a rip_code is recognisable at a glance
// on both the cart and the product detail. The product detail uses ripHue from
// ProductQuickView with an identical hash.
function ripHueLocal(code: string): number {
  let h = 0;
  for (let i = 0; i < code.length; i++) h = (h * 31 + code.charCodeAt(i)) % 360;
  return h;
}
function RipBadge({ code }: { code: string }) {
  const h = ripHueLocal(code);
  return (
    <span className="cart-rip-group-badge" title={`RIP rebate ${code} — buy these together to qualify`} style={{
      background: `hsl(${h} 75% 93%)`, color: `hsl(${h} 65% 28%)`, borderColor: `hsl(${h} 60% 78%)`,
    }}>🔗 RIP {code}</span>
  );
}

// Normalise a tier unit label ("Case(s)" -> "case", "Btl"/"Bottle" -> "btl").
function normUnit(u?: string | null): 'case' | 'btl' {
  const s = String(u ?? '').toLowerCase().trim();
  if (s === 'b' || s.startsWith('btl') || s.startsWith('bottle')) return 'btl';
  return 'case';
}

interface RipTier { qty: number; unit: 'case' | 'btl'; amt: number; }

/** Reduce a RIP cluster of cart lines to its rebate ladder + a progress
 *  message ("4 cases towards $250 · 1 more for $400 rebate"). Each cart
 *  line already carries its server-attached `tiers`, so we just dedupe by
 *  (qty, normalised unit), keep the highest amount per slot, then compare
 *  the buyer's current cart quantity against those thresholds. */
function ripBucketSummary(lines: CartItem[]): {
  tiers: RipTier[];
  progressUnit: 'case' | 'btl';
  cartCases: number;
  cartBottles: number;
  progress: { text: string; tone: 'gap' | 'pending' | 'reached' } | null;
} {
  const map = new Map<string, RipTier>();
  let votes = { case: 0, btl: 0 };
  for (const it of lines) {
    for (const t of (it.tiers ?? [])) {
      if (t.source !== 'rip') continue;
      const u = normUnit(t.unit);
      votes[u]++;
      const k = `${t.qty}|${u}`;
      const prev = map.get(k);
      if (!prev || t.amount > prev.amt) {
        map.set(k, { qty: t.qty, unit: u, amt: t.amount });
      }
    }
  }
  const tiers = [...map.values()].sort((a, b) => a.qty - b.qty);
  const progressUnit: 'case' | 'btl' = votes.btl > votes.case ? 'btl' : 'case';
  const cartCases = lines.reduce((s, it) => s + (it.qty_cases || 0), 0);
  const cartBottles = lines.reduce((s, it) => s + (it.qty_units || 0), 0);
  const have = progressUnit === 'case' ? cartCases : cartBottles;
  const unitWord = progressUnit === 'case' ? 'case' : 'bottle';
  let progress: { text: string; tone: 'gap' | 'pending' | 'reached' } | null = null;
  if (tiers.length > 0) {
    const reached = tiers.filter(t => have >= t.qty);
    const ahead = tiers.filter(t => have < t.qty);
    if (reached.length && ahead.length === 0) {
      const top = reached[reached.length - 1];
      progress = {
        text: `✓ Top tier reached: ${have} ${unitWord}${have === 1 ? '' : 's'} · $${top.amt.toFixed(2)} rebate locked`,
        tone: 'reached',
      };
    } else if (reached.length) {
      const top = reached[reached.length - 1];
      const next = ahead[0];
      const need = next.qty - have;
      progress = {
        text: `${have} ${unitWord}${have === 1 ? '' : 's'} in cart · $${top.amt.toFixed(2)} earned · ${need} more for $${next.amt.toFixed(2)}`,
        tone: 'pending',
      };
    } else {
      const next = ahead[0];
      const need = next.qty - have;
      if (have === 0) {
        progress = {
          text: `Buy ${next.qty} ${unitWord}${next.qty === 1 ? '' : 's'} to unlock $${next.amt.toFixed(2)} rebate`,
          tone: 'gap',
        };
      } else {
        progress = {
          text: `${have} ${unitWord}${have === 1 ? '' : 's'} in cart · ${need} more for $${next.amt.toFixed(2)} rebate`,
          tone: 'gap',
        };
      }
    }
  }
  return { tiers, progressUnit, cartCases, cartBottles, progress };
}

// Search box that adds any catalogue product straight into the cart.
function AddToCartSearch({ onAdd, adding }: { onAdd: (p: Product) => void; adding: boolean }) {
  const [q, setQ] = useState('');
  const { data } = useQuery({
    queryKey: ['cart-add-search', q],
    queryFn: () => catalog.search({ q, limit: 50 }),
    enabled: q.trim().length >= 2,
  });
  const results = data?.items ?? [];
  return (
    <div className="panel" data-tour="cart-add" style={{ padding: 12, marginTop: 12 }}>
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

const RIP_GROUP_KEY = 'celr_cart_group_by_rip';

export default function Cart() {
  const qc = useQueryClient();
  const { confirm } = useDialog();
  const [result, setResult] = useState<string | null>(null);
  // Two view modes:
  //   default ('batch') - cluster lines by the SEND BATCH they came in on, so
  //     a Catalog Case Mix sent now and the AI's Case Mix sent later stay as
  //     SEPARATE cards. Items added one-by-one ungrouped fall into "Loose".
  //   'rip' - merge across batches by rip_code so the user can see total
  //     exposure per rebate. Toggling is presentation only; batch_id stays in
  //     the DB, so flipping back to 'batch' always restores the original sends.
  const [groupByRip, setGroupByRip] = useState<boolean>(() => localStorage.getItem(RIP_GROUP_KEY) === '1');
  const toggleGroupByRip = (on: boolean) => {
    setGroupByRip(on);
    if (on) localStorage.setItem(RIP_GROUP_KEY, '1');
    else localStorage.removeItem(RIP_GROUP_KEY);
  };
  const { data, isLoading, isError, refetch } = useQuery({ queryKey: ['cart'], queryFn: cartApi.get });
  const { data: reps } = useQuery({ queryKey: ['sales-reps'], queryFn: repsApi.list });
  const items = data?.items ?? [];
  const groupNotes = data?.group_notes ?? {};
  const active = items.filter(i => !i.saved_for_later);
  const saved = items.filter(i => i.saved_for_later);

  // (Removed) auto-enable of "Group by RIP" on cart load. The default view
  // now clusters lines by SEND BATCH so RIP sends already arrive grouped; the
  // rip-merge toggle is opt-in for cross-batch exposure.

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['cart'] });
    qc.invalidateQueries({ queryKey: ['cart-analyze'] });   // keep savings live
  };
  // Analyze for Savings — live panel (refetches whenever the cart changes).
  const [showSavings, setShowSavings] = useState(false);
  const { data: savings, isFetching: savingsBusy } = useQuery({
    queryKey: ['cart-analyze'], queryFn: cartApi.analyze, enabled: showSavings,
  });
  const swap = useMutation({
    mutationFn: (rec: SavingsRec) => cartApi.swapDistributor({
      from_distributor: rec.from_wholesaler!, to_distributor: rec.to_wholesaler!,
      upcs: rec.upc ? [String(rec.upc)] : undefined,
    }),
    onSuccess: invalidate,
  });
  const upd = useMutation({
    mutationFn: (v: { id: number; patch: Parameters<typeof cartApi.update>[1] }) => cartApi.update(v.id, v.patch),
    onSuccess: invalidate,
  });
  const del = useMutation({ mutationFn: (id: number) => cartApi.remove(id), onSuccess: invalidate });
  const { open } = useProductQuickView();  // product-name → price-detail modal
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
      if (r.skipped_no_rep) parts.push(`${r.skipped_no_rep} item(s) skipped. Assign a rep and resend`);
      setResult(parts.join('. '));
    },
  });
  // Bulk save-for-later (Save-all/Move-all from a RIP group header).
  const bulkSave = useMutation({
    mutationFn: (v: { ids: number[]; saved: boolean }) => cartApi.bulkSaveForLater(v.ids, v.saved),
    onSuccess: invalidate,
  });
  // Wipe the active cart in one call (the explicit "Clear all cart" button).
  // Saved-for-later items are preserved; the user has to clear them separately.
  const clearActive = useMutation({
    mutationFn: () => cartApi.clear('active'),
    onSuccess: invalidate,
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
      <div key={it.id} data-tour="cart-line" style={{ padding: '10px 0', borderTop: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <ProductThumb src={it.image_url} alt={it.product_name} size={56} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span
                className="product-name-link"
                title="View price detail"
                onClick={() => open(it.product_name, it.wholesaler, undefined, {
                  upc: it.upc ?? undefined,
                  unitVolume: it.unit_volume ?? undefined,
                  unitQty: it.unit_qty != null ? String(it.unit_qty) : undefined,
                })}
              >
                {it.product_name}
              </span>
              {showCombo && <ComboBadge code={it.combo_code!} />}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              {distributorName(it.wholesaler)}{it.unit_volume ? ` · ${it.unit_volume}` : ''}{it.upc ? ` · ${it.upc}` : ''}{abgSku(it.wholesaler, it.abg_sku) ? ` · ${skuLabel(it.wholesaler)} ${it.abg_sku}` : ''}
            </div>
            {it.frontline_case_price != null && (
              <div style={{ fontSize: 12, marginTop: 2 }}>
                Case {money(it.frontline_case_price)}
                {it.frontline_unit_price != null && !isKegUnit(it.unit_volume, it.unit_type) && <> · {perUnitAbbr(it.unit_volume, it.unit_type)} {money(it.frontline_unit_price)}</>}
                {' · '}{showCombo ? 'Combo' : 'Eff'} <span className="text-green">{money(perCase)}/{priceUnit(it.unit_volume, it.unit_type)}</span>
                {it.total_savings_per_case ? <> · Save <span className="text-green">{money(it.total_savings_per_case)}/{priceUnit(it.unit_volume, it.unit_type)}</span></> : null}
              </div>
            )}
            {/* Price-history sparkline (effective vs frontline across editions);
                interactive → click opens the 3-month price popover. */}
            <div style={{ marginTop: 4 }}>
              <DealSparkline
                interactive
                wholesaler={it.wholesaler}
                productName={it.product_name}
                upc={it.upc ?? undefined}
                unitVolume={it.unit_volume ?? undefined}
                unitQty={it.unit_qty != null ? String(it.unit_qty) : undefined}
                width={130}
                height={32}
              />
            </div>
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

        {/* Buy-timing trap / dated-deal explainer (clickable). */}
        {((it.deal_windows?.length ?? 0) > 0 || (it.rip_gaps?.length ?? 0) > 0) && (
          <div style={{ marginLeft: 68, marginTop: 4 }}>
            <DealTimingSticker deals={it.deal_windows ?? []} gaps={it.rip_gaps}
              everyDay={everyDayFromTiers(it.tiers, it.frontline_case_price)} />
          </div>
        )}

        {/* Deal tiers, same info as the catalogue, to tweak qty last minute. Combo
            lines hide these (the bundle is the deal). */}
        {tiers.length > 0 && (
          <div style={{ marginLeft: 68, marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: '4px 8px' }}>
            {tiers.map((t, i) => (
              <span key={i} className={`source-badge source-${t.source}`} style={{ fontSize: 11 }}
                title={t.description || undefined}>
                {t.source === 'discount' ? 'DISC' : 'RIP'} · Buy {t.qty} {shortUnit(t.unit)} = <strong>${t.amount.toFixed(2)}</strong>
                {t.save_per_case != null ? ` (save $${t.save_per_case.toFixed(2)}/cs)` : ''}
                {(() => {
                  const wb = windowBadge(t);
                  if (!t.is_time_sensitive && !wb) return null;
                  const range = fmtDateRange(t.from_date, t.to_date);
                  const cls = t.is_time_sensitive ? (wb?.urgent ? 'win-partial urgent' : 'win-partial') : (wb?.cls ?? 'win-partial');
                  return (
                    <span className={`win-badge ${cls}`}
                      style={{ marginLeft: 5 }} title={`Partial-month — only valid ${range || 'limited dates'}`}>
                      {t.is_time_sensitive ? `⏱ Partial · ${range || 'limited'}` : wb?.label}{t.is_time_sensitive && wb ? ` · ${wb.label}` : ''}
                    </span>
                  );
                })()}
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <button
            className="btn btn-secondary"
            disabled={active.length === 0 || clearActive.isPending}
            title="Remove every item in the cart. Saved-for-later items stay put."
            onClick={async () => {
              const n = active.length;
              const ok = await confirm({
                title: `Clear all ${n} item${n === 1 ? '' : 's'} from the cart?`,
                message: "This cannot be undone. Items you've Saved for later will remain.",
                confirmText: 'Clear cart', danger: true,
              });
              if (ok) {
                setResult(null);
                clearActive.mutate();
              }
            }}
          >
            <Eraser size={16} /> {clearActive.isPending ? 'Clearing...' : 'Clear All Cart'}
          </button>
          <button className="btn btn-secondary" disabled={active.length === 0}
            title="Find tier-gap, case-mix, price-rise and distributor-swap savings on this cart"
            onClick={() => setShowSavings(s => !s)}>
            <Sparkles size={16} /> {showSavings ? 'Hide Savings' : 'Analyze for Savings'}
          </button>
          <button className="btn btn-primary" data-tour="cart-send" disabled={active.length === 0 || send.isPending}
            onClick={() => { setResult(null); send.mutate(); }}>
            <Send size={16} /> {send.isPending ? 'Sending...' : 'Send All Orders to Reps'}
          </button>
        </div>
      </div>

      {showSavings && active.length > 0 && (
        <SavingsAnalysis data={savings} loading={savingsBusy && !savings} context="cart"
          busy={upd.isPending || swap.isPending}
          onSetQty={(id, cases) => upd.mutate({ id, patch: { qty_cases: cases } })}
          onSwap={(rec) => swap.mutate(rec)} />
      )}

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
        <div className="panel" data-tour="cart-total" style={{ padding: '10px 14px', marginTop: 10, display: 'flex',
          alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, borderColor: 'var(--accent)' }}>
          <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
            {active.length} item{active.length === 1 ? '' : 's'} across {groups.length} sales rep group{groups.length === 1 ? '' : 's'}
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}
              title="OFF (default) shows each send batch as its own card. ON merges across batches by RIP code so you can see total exposure per rebate.">
              <input type="checkbox" checked={groupByRip} onChange={e => toggleGroupByRip(e.target.checked)} />
              Merge batches by RIP
            </label>
            <span style={{ fontSize: 16 }}>Cart total: <strong className="text-green">{money(cartTotal)}</strong></span>
          </span>
        </div>
      )}

      <AddToCartSearch onAdd={p => add.mutate(p)} adding={add.isPending} />

      {isLoading && <DataLoading label="Loading your cart…" />}
      {isError && <ErrorState retry={() => refetch()} />}
      {!isLoading && !isError && active.length === 0 && saved.length === 0 && (
        <EmptyState title="Your cart is empty">Add products from the Catalog or any price page. You can also search above, use the + button, or right-click anywhere.</EmptyState>
      )}

      {groups.map(([wholesaler, groupItems]) => {
        const repId = groupItems.find(i => i.sales_rep_id)?.sales_rep_id ?? '';
        const options = repsFor(wholesaler);
        const selRep = options.find(r => r.id === Number(repId));
        const contact = selRep ? [selRep.phone, selRep.email].filter(Boolean).join(' · ') : '';
        const groupTotal = groupItems.reduce((s, it) => s + lineTotal(it), 0);
        return (
          <div key={wholesaler} className="panel" data-tour="cart-group" style={{ padding: 12, marginTop: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
              <strong>{distributorName(wholesaler)}</strong>
              <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13 }}>Group total: <strong className="text-green">{money(groupTotal)}</strong></span>
                <label data-tour="cart-rep" style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
                  Sales rep:
                  <select value={repId}
                    onChange={e => assign.mutate({ wholesaler, repId: e.target.value ? Number(e.target.value) : null })}>
                    <option value="">Select a rep</option>
                    {options.map(r => <option key={r.id} value={r.id}>{r.name}{r.division ? ` (${r.division})` : ''}</option>)}
                  </select>
                </label>
              </div>
            </div>
            {contact && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{contact}</div>}
            <input
              data-tour="cart-note"
              defaultValue={groupNotes[wholesaler] ?? ''}
              placeholder="Order note for this rep (header note on their order)"
              onBlur={e => { if (e.target.value !== (groupNotes[wholesaler] ?? '')) groupNote.mutate({ wholesaler, note: e.target.value }); }}
              style={{ marginTop: 8, width: '100%', maxWidth: 480, fontSize: 12, padding: '4px 8px' }}
            />
            {(() => {
              if (!groupByRip) {
                // Default: group by SEND BATCH so a Catalog Case Mix sent
                // earlier and an AI Case Mix sent later stay as two separate
                // cards. Items with NULL batch_id (single-product adds, older
                // pre-batch items) collect into a "Loose items" card so they
                // still render the per-line UI.
                const batchMap = new Map<string, typeof groupItems>();
                const loose: typeof groupItems = [];
                for (const it of groupItems) {
                  const bid = it.batch_id && String(it.batch_id).trim();
                  if (!bid) { loose.push(it); continue; }
                  if (!batchMap.has(bid)) batchMap.set(bid, []);
                  batchMap.get(bid)!.push(it);
                }
                // Preserve original add order via created_at on the first line.
                const batches = [...batchMap.entries()].sort((a, b) =>
                  ((a[1][0] as unknown as { created_at?: string }).created_at ?? '')
                    .localeCompare((b[1][0] as unknown as { created_at?: string }).created_at ?? '')
                );
                return (
                  <>
                    {batches.map(([bid, lines]) => {
                      const label = lines[0]?.batch_label || `Batch ${bid.slice(0, 8)}`;
                      const ids = lines.map(l => l.id);
                      const subtotal = lines.reduce((s, it) => s + lineTotal(it), 0);
                      const totalCases = lines.reduce((s, it) => s + (it.qty_cases || 0), 0);
                      // Use the RIP hue palette so a batch_label that includes
                      // a RIP code (catalog_rip / ai_rip) is recognisable.
                      const hue = ripHueLocal(bid);
                      return (
                        <div key={`batch-${bid}`} className="cart-rip-group" style={{
                          borderLeftColor: `hsl(${hue} 65% 55%)`,
                          background: `linear-gradient(180deg, hsl(${hue} 75% 97%) 0%, var(--surface) 16px)`,
                        }}>
                          <div className="cart-rip-group-header">
                            <span className="cart-rip-group-badge" style={{
                              background: `hsl(${hue} 75% 93%)`, color: `hsl(${hue} 65% 28%)`, borderColor: `hsl(${hue} 60% 78%)`,
                            }} title="A batch is one send. Two sends of the same RIP stay as two batches here. Use 'Merge by RIP' above to see total exposure.">
                              📦 {label}
                            </span>
                            <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>
                              {lines.length} line{lines.length === 1 ? '' : 's'} · {totalCases} case{totalCases === 1 ? '' : 's'}
                            </span>
                            <button
                              className="btn btn-secondary btn-sm"
                              title={`Move all ${lines.length} line${lines.length === 1 ? '' : 's'} in this batch to Saved for later`}
                              disabled={bulkSave.isPending}
                              onClick={() => bulkSave.mutate({ ids, saved: true })}
                            >
                              <Clock size={13} /> Save all for later
                            </button>
                            <span style={{ marginLeft: 'auto', fontWeight: 600 }}>
                              Subtotal: <span className="text-green">{money(subtotal)}</span>
                            </span>
                          </div>
                          {lines.map(it => renderItem(it))}
                        </div>
                      );
                    })}
                    {loose.length > 0 && (
                      <div className="cart-rip-group" style={{ borderLeftColor: 'var(--border)' }}>
                        <div className="cart-rip-group-header">
                          <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>
                            Loose items · {loose.length} line{loose.length === 1 ? '' : 's'}
                          </span>
                        </div>
                        {loose.map(it => renderItem(it))}
                      </div>
                    )}
                  </>
                );
              }
              // Three-way sub-grouping. Combos take priority because they're
              // hard requirements (lose any line and the bundle breaks); RIPs
              // are thresholds that earn the buyer money; everything else
              // falls into "No deal grouping".
              const comboMap = new Map<string, typeof groupItems>();
              const ripMap = new Map<string, typeof groupItems>();
              const unrebated: typeof groupItems = [];
              for (const it of groupItems) {
                const cc = it.combo_code && String(it.combo_code).trim();
                if (cc) {
                  if (!comboMap.has(cc)) comboMap.set(cc, []);
                  comboMap.get(cc)!.push(it);
                  continue;
                }
                const rc = it.rip_code && String(it.rip_code).trim();
                if (!rc) { unrebated.push(it); continue; }
                if (!ripMap.has(rc)) ripMap.set(rc, []);
                ripMap.get(rc)!.push(it);
              }
              const comboBuckets = [...comboMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
              const buckets = [...ripMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
              return (
                <>
                  {comboBuckets.map(([cc, lines]) => {
                    const hue = comboHue(cc);
                    const lineCount = lines.length;
                    const subtotal = lines.reduce((s, it) => s + lineTotal(it), 0);
                    const totalCases = lines.reduce((s, it) => s + (it.qty_cases || 0), 0);
                    const ids = lines.map(l => l.id);
                    return (
                      <div key={`combo-${cc}`} className="cart-rip-group" style={{
                        borderLeftColor: `hsl(${hue} 65% 55%)`,
                        background: `linear-gradient(180deg, hsl(${hue} 75% 97%) 0%, var(--surface) 16px)`,
                      }}>
                        <div className="cart-rip-group-header">
                          <ComboBadge code={cc} />
                          <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>
                            {lineCount} line{lineCount === 1 ? '' : 's'} · {totalCases} case{totalCases === 1 ? '' : 's'} · bundle priced together
                          </span>
                          <button
                            className="btn btn-secondary btn-sm"
                            title={`Move all ${lineCount} line${lineCount === 1 ? '' : 's'} of combo #${cc} to Saved for later`}
                            disabled={bulkSave.isPending}
                            onClick={() => bulkSave.mutate({ ids, saved: true })}
                          >
                            <Clock size={13} /> Save all for later
                          </button>
                          <span style={{ marginLeft: 'auto', fontWeight: 600 }}>
                            Subtotal: <span className="text-green">{money(subtotal)}</span>
                          </span>
                        </div>
                        {lines.map(it => renderItem(it))}
                      </div>
                    );
                  })}
                  {buckets.map(([rc, lines]) => {
                    const hue = ripHueLocal(rc);
                    const lineCount = lines.length;
                    const subtotal = lines.reduce((s, it) => s + lineTotal(it), 0);
                    const ids = lines.map(l => l.id);
                    const summary = ripBucketSummary(lines);
                    return (
                      <div key={`rip-${rc}`} className="cart-rip-group" style={{
                        borderLeftColor: `hsl(${hue} 65% 55%)`,
                        background: `linear-gradient(180deg, hsl(${hue} 75% 97%) 0%, var(--surface) 16px)`,
                      }}>
                        <div className="cart-rip-group-header">
                          <RipBadge code={rc} />
                          <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>
                            {lineCount} line{lineCount === 1 ? '' : 's'}
                          </span>
                          <button
                            className="btn btn-secondary btn-sm"
                            title={`Move all ${lineCount} line${lineCount === 1 ? '' : 's'} under RIP ${rc} to Saved for later`}
                            disabled={bulkSave.isPending}
                            onClick={() => bulkSave.mutate({ ids, saved: true })}
                          >
                            <Clock size={13} /> Save all for later
                          </button>
                          <span style={{ marginLeft: 'auto', fontWeight: 600 }}>
                            Subtotal: <span className="text-green">{money(subtotal)}</span>
                          </span>
                        </div>
                        {(summary.tiers.length > 0 || summary.progress) && (
                          <div className="cart-rip-ladder">
                            {summary.tiers.length > 0 && (
                              <div className="cart-rip-tiers">
                                {summary.tiers.map((t, i) => {
                                  const reached = (t.unit === 'case' ? summary.cartCases : summary.cartBottles) >= t.qty;
                                  return (
                                    <span key={i} className={`cart-rip-tier ${reached ? 'reached' : 'pending'}`}>
                                      Buy {t.qty} {t.unit === 'case' ? 'cs' : 'btl'} = <strong>${t.amt.toFixed(2)}</strong>
                                    </span>
                                  );
                                })}
                              </div>
                            )}
                            {summary.progress && (
                              <div className={`cart-rip-progress tone-${summary.progress.tone}`}>
                                {summary.progress.text}
                              </div>
                            )}
                          </div>
                        )}
                        {lines.map(it => renderItem(it))}
                      </div>
                    );
                  })}
                  {unrebated.length > 0 && (
                    <div className="cart-rip-group" style={{ borderLeftColor: 'var(--border)' }}>
                      <div className="cart-rip-group-header">
                        <span style={{ fontWeight: 600 }}>No deal grouping</span>
                        <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>
                          {unrebated.length} line{unrebated.length === 1 ? '' : 's'}
                        </span>
                      </div>
                      {unrebated.map(it => renderItem(it))}
                    </div>
                  )}
                </>
              );
            })()}
          </div>
        );
      })}

      {saved.length > 0 && (
        <div className="panel" data-tour="cart-saved" style={{ padding: 12, marginTop: 20 }}>
          <h3 style={{ margin: '0 0 4px', display: 'flex', alignItems: 'center', gap: 8 }}><Clock size={18} /> Saved for later</h3>
          {(() => {
            if (!groupByRip) {
              // Mirror the active-cart default: group saved lines by send
              // batch so a "save all" from a batch keeps its identity, and
              // "move all back to cart" restores the original send.
              const batchMap = new Map<string, typeof saved>();
              const loose: typeof saved = [];
              for (const it of saved) {
                const bid = it.batch_id && String(it.batch_id).trim();
                if (!bid) { loose.push(it); continue; }
                if (!batchMap.has(bid)) batchMap.set(bid, []);
                batchMap.get(bid)!.push(it);
              }
              const batches = [...batchMap.entries()].sort((a, b) =>
                ((a[1][0] as unknown as { created_at?: string }).created_at ?? '')
                  .localeCompare((b[1][0] as unknown as { created_at?: string }).created_at ?? '')
              );
              return (
                <>
                  {batches.map(([bid, lines]) => {
                    const label = lines[0]?.batch_label || `Batch ${bid.slice(0, 8)}`;
                    const ids = lines.map(l => l.id);
                    const hue = ripHueLocal(bid);
                    return (
                      <div key={`saved-batch-${bid}`} className="cart-rip-group" style={{
                        borderLeftColor: `hsl(${hue} 65% 55%)`,
                        background: `linear-gradient(180deg, hsl(${hue} 75% 97%) 0%, var(--surface) 16px)`,
                      }}>
                        <div className="cart-rip-group-header">
                          <span className="cart-rip-group-badge" style={{
                            background: `hsl(${hue} 75% 93%)`, color: `hsl(${hue} 65% 28%)`, borderColor: `hsl(${hue} 60% 78%)`,
                          }}>📦 {label}</span>
                          <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>
                            {lines.length} line{lines.length === 1 ? '' : 's'} saved
                          </span>
                          <button
                            className="btn btn-secondary btn-sm"
                            title={`Move all ${lines.length} line${lines.length === 1 ? '' : 's'} from this batch back into the active cart`}
                            disabled={bulkSave.isPending}
                            onClick={() => bulkSave.mutate({ ids, saved: false })}
                          >
                            <ArrowUpFromLine size={13} /> Move all to cart
                          </button>
                        </div>
                        {lines.map(it => renderItem(it, true))}
                      </div>
                    );
                  })}
                  {loose.length > 0 && (
                    <div className="cart-rip-group" style={{ borderLeftColor: 'var(--border)' }}>
                      <div className="cart-rip-group-header">
                        <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>
                          Loose items · {loose.length} line{loose.length === 1 ? '' : 's'}
                        </span>
                      </div>
                      {loose.map(it => renderItem(it, true))}
                    </div>
                  )}
                </>
              );
            }
            // Mirror the active-cart layout: combos first (priority), then RIPs,
            // then everything else. Each cluster header carries a "Move all back
            // to cart" action.
            const comboMap = new Map<string, typeof saved>();
            const ripMap = new Map<string, typeof saved>();
            const unrebated: typeof saved = [];
            for (const it of saved) {
              const cc = it.combo_code && String(it.combo_code).trim();
              if (cc) {
                if (!comboMap.has(cc)) comboMap.set(cc, []);
                comboMap.get(cc)!.push(it);
                continue;
              }
              const rc = it.rip_code && String(it.rip_code).trim();
              if (!rc) { unrebated.push(it); continue; }
              if (!ripMap.has(rc)) ripMap.set(rc, []);
              ripMap.get(rc)!.push(it);
            }
            const comboBuckets = [...comboMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
            const buckets = [...ripMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
            return (
              <>
                {comboBuckets.map(([cc, lines]) => {
                  const hue = comboHue(cc);
                  const lineCount = lines.length;
                  const ids = lines.map(l => l.id);
                  return (
                    <div key={`saved-combo-${cc}`} className="cart-rip-group" style={{
                      borderLeftColor: `hsl(${hue} 65% 55%)`,
                      background: `linear-gradient(180deg, hsl(${hue} 75% 97%) 0%, var(--surface) 16px)`,
                    }}>
                      <div className="cart-rip-group-header">
                        <ComboBadge code={cc} />
                        <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>
                          {lineCount} line{lineCount === 1 ? '' : 's'} saved
                        </span>
                        <button
                          className="btn btn-secondary btn-sm"
                          title={`Move all ${lineCount} line${lineCount === 1 ? '' : 's'} of combo #${cc} back into the active cart`}
                          disabled={bulkSave.isPending}
                          onClick={() => bulkSave.mutate({ ids, saved: false })}
                        >
                          <ArrowUpFromLine size={13} /> Move all to cart
                        </button>
                      </div>
                      {lines.map(it => renderItem(it, true))}
                    </div>
                  );
                })}
                {buckets.map(([rc, lines]) => {
                  const hue = ripHueLocal(rc);
                  const lineCount = lines.length;
                  const ids = lines.map(l => l.id);
                  return (
                    <div key={`saved-rip-${rc}`} className="cart-rip-group" style={{
                      borderLeftColor: `hsl(${hue} 65% 55%)`,
                      background: `linear-gradient(180deg, hsl(${hue} 75% 97%) 0%, var(--surface) 16px)`,
                    }}>
                      <div className="cart-rip-group-header">
                        <RipBadge code={rc} />
                        <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>
                          {lineCount} line{lineCount === 1 ? '' : 's'} saved
                        </span>
                        <button
                          className="btn btn-secondary btn-sm"
                          title={`Move all ${lineCount} line${lineCount === 1 ? '' : 's'} under RIP ${rc} back into the active cart`}
                          disabled={bulkSave.isPending}
                          onClick={() => bulkSave.mutate({ ids, saved: false })}
                        >
                          <ArrowUpFromLine size={13} /> Move all to cart
                        </button>
                      </div>
                      {lines.map(it => renderItem(it, true))}
                    </div>
                  );
                })}
                {unrebated.length > 0 && (
                  <div className="cart-rip-group" style={{ borderLeftColor: 'var(--border)' }}>
                    <div className="cart-rip-group-header">
                      <span style={{ fontWeight: 600 }}>No deal grouping</span>
                      <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>
                        {unrebated.length} line{unrebated.length === 1 ? '' : 's'}
                      </span>
                    </div>
                    {unrebated.map(it => renderItem(it, true))}
                  </div>
                )}
              </>
            );
          })()}
        </div>
      )}
    </div>
  );
}
