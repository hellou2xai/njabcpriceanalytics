import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, ShoppingCart, Pencil, ClipboardList, Sparkles } from 'lucide-react';
import { lists as listsApi, cart as cartApi, type ListItem } from '../lib/api';
import SavingsAnalysis from '../components/SavingsAnalysis';
import DealTimingSticker from '../components/DealTimingSticker';
import { ContextMenuProvider } from '../components/ContextMenu';
import { useProductQuickView } from '../components/ProductQuickView';
import ProductThumb from '../components/ProductThumb';
import DealSparkline from '../components/DealSparkline';
import { distributorName, abgSku, skuLabel, isKegUnit, priceUnit, perUnitAbbr } from '../lib/distributors';
import { DistributorPicker } from '../components/DistributorPicker';
import { QtyStepper } from '../components/QtyStepper';
import { RipPicker } from '../components/RipPicker';
import { normTierUnit } from '../lib/ripPrograms';
import { useDialog } from '../components/Dialog';
import { ErrorState, EmptyState } from '../components/DataState';
import DataLoading from '../components/DataLoading';

const LIST_RIP_GROUP_KEY = 'celr_lists_group_by_rip';
const money = (v?: number | null) => (v == null ? '–' : `$${v.toFixed(2)}`);

// Shared column header so the flat table and every RIP-bucket table align the
// same way (Product | Code | Distributor | Size | Pack | $Case | $Btl |
// trend | Best buy at the END — it's the deepest-tier illustration).
function ListHead({ check }: { check?: ReactNode }) {
  return (
    <thead>
      <tr>
        <th style={{ width: 28 }}>{check ?? null}</th>
        <th>Product</th>
        <th>Code</th>
        <th>Distributor</th>
        <th>Size</th>
        <th>Pack</th>
        <th title="Planned quantity. Sets the eligible RIP rebate (money back later) at the quantity you intend to buy.">Qty</th>
        <th title="The RIP program this line earns. An item can sit under several programs (they don't stack) — pick the best; ★ flags a richer one.">RIP</th>
        <th style={{ textAlign: 'right' }}
          title="What you'd pay NOW for 1 case: list price minus any quantity discount a single case already earns. The list price shows beneath when a QD applies.">$ Case</th>
        <th style={{ textAlign: 'right' }}
          title="What you'd pay NOW per bottle at 1 case.">$ Bottle</th>
        <th>Price trend</th>
        <th style={{ textAlign: 'right' }}
          title="Illustration only: the deepest possible net after EVERY QD + RIP tier — per case / per bottle.">$ Best buy</th>
        <th style={{ width: 40 }}></th>
      </tr>
    </thead>
  );
}
function ripHueLocal(code: string): number {
  let h = 0;
  for (let i = 0; i < code.length; i++) h = (h * 31 + code.charCodeAt(i)) % 360;
  return h;
}

export default function Lists() {
  const qc = useQueryClient();
  const { confirm, promptText } = useDialog();
  const { open } = useProductQuickView();
  const { data: lists, isLoading, isError, refetch } = useQuery({ queryKey: ['lists'], queryFn: listsApi.list });
  const [activeId, setActiveId] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());

  // Default to the first list once loaded.
  useEffect(() => {
    if (activeId == null && lists && lists.length) setActiveId(lists[0].id);
  }, [lists, activeId]);

  const { data: detail } = useQuery({
    queryKey: ['list', activeId],
    queryFn: () => listsApi.get(activeId as number),
    enabled: activeId != null,
  });

  useEffect(() => { setSelected(new Set()); setShowSavings(false); }, [activeId]);

  // Analyze this list for savings (same engine as the cart). A list has no
  // quantities, so the result reads as "what you could save if you order these".
  const [showSavings, setShowSavings] = useState(false);
  const { data: savings, isFetching: savingsBusy } = useQuery({
    queryKey: ['list-analyze', activeId], queryFn: () => listsApi.analyze(activeId as number),
    enabled: showSavings && activeId != null,
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['lists'] });
    qc.invalidateQueries({ queryKey: ['list', activeId] });
  };

  const createList = useMutation({
    mutationFn: (name: string) => listsApi.create(name),
    onSuccess: (l) => { qc.invalidateQueries({ queryKey: ['lists'] }); setActiveId(l.id); },
  });
  const renameList = useMutation({
    mutationFn: (v: { id: number; name: string }) => listsApi.rename(v.id, v.name),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['lists'] }),
  });
  const deleteList = useMutation({
    mutationFn: (id: number) => listsApi.remove(id),
    onSuccess: () => { setActiveId(null); qc.invalidateQueries({ queryKey: ['lists'] }); },
  });
  const removeItems = useMutation({
    mutationFn: (ids: number[]) => listsApi.removeItems(activeId as number, ids),
    onSuccess: () => { setSelected(new Set()); refresh(); },
  });
  const moveToCart = useMutation({
    mutationFn: (ids: number[]) => cartApi.fromList(activeId as number, ids.length ? ids : undefined),
    onSuccess: () => { setSelected(new Set()); qc.invalidateQueries({ queryKey: ['cart'] }); },
  });

  const items = detail?.items ?? [];
  const allChecked = items.length > 0 && selected.size === items.length;
  const toggle = (id: number) => setSelected(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleAll = () => setSelected(allChecked ? new Set() : new Set(items.map(i => i.id)));
  const selIds = [...selected];

  // Auto-on Group by RIP the first time the list contains a RIP-tied item,
  // mirroring the cart behaviour. The user can still uncheck to flatten.
  const [groupByRip, setGroupByRip] = useState<boolean>(() => localStorage.getItem(LIST_RIP_GROUP_KEY) === '1');
  const toggleGroupByRip = (on: boolean) => {
    setGroupByRip(on);
    if (on) localStorage.setItem(LIST_RIP_GROUP_KEY, '1');
    else localStorage.removeItem(LIST_RIP_GROUP_KEY);
  };
  const hasRipItem = useMemo(
    () => items.some(i => i.rip_code && String(i.rip_code).trim()),
    [items],
  );
  useEffect(() => {
    if (hasRipItem && !groupByRip && localStorage.getItem(LIST_RIP_GROUP_KEY) === null) {
      setGroupByRip(true);
    }
  }, [hasRipItem, groupByRip]);

  // Bucket items by rip_code when grouping is on.
  const buckets = useMemo(() => {
    if (!groupByRip) return null;
    const m = new Map<string, ListItem[]>();
    const unrebated: ListItem[] = [];
    for (const it of items) {
      const rc = it.rip_code && String(it.rip_code).trim();
      if (!rc) { unrebated.push(it); continue; }
      if (!m.has(rc)) m.set(rc, []);
      m.get(rc)!.push(it);
    }
    return {
      groups: [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])),
      unrebated,
    };
  }, [items, groupByRip]);

  return (
    <div className="page">
      <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}><ClipboardList size={22} /> Lists</h2>
      <p style={{ color: 'var(--text-muted)', marginTop: 0 }}>
        Reusable product lists. Select items and move them to your cart, or delete them.
      </p>

      {isError ? <ErrorState retry={() => refetch()} /> : isLoading ? <DataLoading label="Loading your lists…" /> : (
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        {/* List selector */}
        <div className="panel" data-tour="lists-panel" style={{ padding: 10, minWidth: 200 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <strong>My lists</strong>
            <button className="btn btn-secondary btn-sm" data-tour="lists-new" title="New list"
              onClick={async () => { const n = await promptText({ title: 'New list', placeholder: 'List name', confirmText: 'Create' }); if (n) createList.mutate(n); }}><Plus size={14} /></button>
          </div>
          {(lists ?? []).map(l => (
            <div key={l.id}
              onClick={() => setActiveId(l.id)}
              className={`nav-link ${l.id === activeId ? 'active' : ''}`}
              style={{ cursor: 'pointer', justifyContent: 'space-between' }}>
              <span>{l.name}</span>
              <span className="text-muted" style={{ fontSize: 11 }}>{l.item_count}</span>
            </div>
          ))}
          {(lists ?? []).length === 0 && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>No lists yet.</div>}
        </div>

        {/* Selected list */}
        <div className="panel" data-tour="lists-detail" style={{ padding: 12, flex: 1, minWidth: 320 }}>
          {activeId == null ? (
            (lists ?? []).length === 0
              ? <EmptyState title="No lists yet">Create a list to group products you want to track or order together.</EmptyState>
              : <p style={{ color: 'var(--text-muted)' }}>Create or pick a list.</p>
          ) : (
            <>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
                <strong>{detail?.name}</strong>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button className="btn btn-secondary btn-sm" title="Rename"
                    onClick={async () => { const n = await promptText({ title: 'Rename list', defaultValue: detail?.name, confirmText: 'Rename' }); if (n) renameList.mutate({ id: activeId, name: n }); }}><Pencil size={14} /></button>
                  <button className="btn btn-secondary btn-sm" title="Delete list"
                    onClick={async () => { if (await confirm({ title: 'Delete this list?', message: 'The list and its saved items will be removed.', confirmText: 'Delete', danger: true })) deleteList.mutate(activeId); }}><Trash2 size={14} /></button>
                </div>
              </div>

              <div style={{ display: 'flex', gap: 8, margin: '10px 0', alignItems: 'center', flexWrap: 'wrap' }} data-tour="lists-move">
                <button className="btn btn-primary btn-sm" disabled={items.length === 0}
                  onClick={() => moveToCart.mutate(selIds)}>
                  <ShoppingCart size={14} /> Move {selIds.length || 'all'} to cart
                </button>
                <button className="btn btn-secondary btn-sm" disabled={selIds.length === 0}
                  onClick={() => removeItems.mutate(selIds)}>
                  <Trash2 size={14} /> Delete selected
                </button>
                <button className="btn btn-secondary btn-sm" disabled={items.length === 0}
                  title="Find tier-gap, case-mix and price-rise savings on this list"
                  onClick={() => setShowSavings(s => !s)}>
                  <Sparkles size={14} /> {showSavings ? 'Hide Savings' : 'Analyze for Savings'}
                </button>
                <label style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}
                  title="Sub-group list items that share a RIP rebate code, with a colour band per RIP">
                  <input type="checkbox" checked={groupByRip} onChange={e => toggleGroupByRip(e.target.checked)} />
                  Group by RIP
                </label>
              </div>

              {showSavings && (
                <SavingsAnalysis data={savings} loading={savingsBusy && !savings} context="list" />
              )}

              <ContextMenuProvider onView={open}>
                {buckets ? (
                  <>
                    {buckets.groups.map(([rc, lines]) => {
                      const hue = ripHueLocal(rc);
                      const allBucketIds = lines.map(l => l.id);
                      const bucketChecked = lines.every(l => selected.has(l.id));
                      const toggleBucket = () => {
                        setSelected(prev => {
                          const next = new Set(prev);
                          if (bucketChecked) allBucketIds.forEach(id => next.delete(id));
                          else allBucketIds.forEach(id => next.add(id));
                          return next;
                        });
                      };
                      return (
                        <div key={`list-rip-${rc}`} className="cart-rip-group" style={{
                          borderLeftColor: `hsl(${hue} 65% 55%)`,
                          background: `linear-gradient(180deg, hsl(${hue} 75% 97%) 0%, var(--surface) 16px)`,
                          marginBottom: 10,
                        }}>
                          <div className="cart-rip-group-header">
                            <input type="checkbox" checked={bucketChecked} onChange={toggleBucket} title="Select every line in this RIP group" />
                            <span className="cart-rip-group-badge" style={{
                              background: `hsl(${hue} 75% 93%)`, color: `hsl(${hue} 65% 28%)`, borderColor: `hsl(${hue} 60% 78%)`,
                            }}>🔗 RIP {rc}</span>
                            <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>
                              {lines.length} line{lines.length === 1 ? '' : 's'}
                            </span>
                            <button
                              className="btn btn-primary btn-sm"
                              title={`Move every line under RIP ${rc} to the cart`}
                              onClick={() => moveToCart.mutate(allBucketIds)}
                            >
                              <ShoppingCart size={13} /> Move all to cart
                            </button>
                          </div>
                          <table className="catalog-table">
                            <ListHead />
                            <tbody>
                              {lines.map(it => <ListRow key={it.id} it={it} selected={selected} toggle={toggle} onRemove={() => removeItems.mutate([it.id])} />)}
                            </tbody>
                          </table>
                        </div>
                      );
                    })}
                    {buckets.unrebated.length > 0 && (
                      <div className="cart-rip-group" style={{ borderLeftColor: 'var(--border)' }}>
                        <div className="cart-rip-group-header">
                          <span style={{ fontWeight: 600 }}>No RIP rebate</span>
                          <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>
                            {buckets.unrebated.length} line{buckets.unrebated.length === 1 ? '' : 's'}
                          </span>
                        </div>
                        <table className="catalog-table">
                          <ListHead />
                          <tbody>
                            {buckets.unrebated.map(it => <ListRow key={it.id} it={it} selected={selected} toggle={toggle} onRemove={() => removeItems.mutate([it.id])} />)}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </>
                ) : (
                  <table className="catalog-table" data-tour="lists-items">
                    <ListHead check={<input type="checkbox" checked={allChecked} onChange={toggleAll} />} />
                    <tbody>
                      {items.map(it => <ListRow key={it.id} it={it} selected={selected} toggle={toggle} onRemove={() => removeItems.mutate([it.id])} />)}
                      {items.length === 0 && <tr><td colSpan={13} className="empty">No items. Add products from anywhere with right-click → Add to List.</td></tr>}
                    </tbody>
                  </table>
                )}
              </ContextMenuProvider>
            </>
          )}
        </div>
      </div>
      )}
    </div>
  );
}

function ListRow({ it, selected, toggle, onRemove }: {
  it: ListItem;
  selected: Set<number>;
  toggle: (id: number) => void;
  onRemove: () => void;
}) {
  const { open } = useProductQuickView();
  const qc = useQueryClient();
  const pickRip = useMutation({
    mutationFn: (code: string | null) => listsApi.updateItem(it.list_id, it.id, { rip_choice: code }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['list', it.list_id] }),
  });
  const switchDist = useMutation({
    mutationFn: (ws: string) => listsApi.switchDistributor(it.list_id, it.id, ws),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['list', it.list_id] });
      qc.invalidateQueries({ queryKey: ['list-analyze', it.list_id] });
    },
  });
  const setQty = useMutation({
    mutationFn: (v: { cases?: number; units?: number }) =>
      listsApi.updateItem(it.list_id, it.id, { qty_cases: v.cases, qty_units: v.units }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['list', it.list_id] }),
  });
  const keg = isKegUnit(it.unit_volume, it.unit_type);
  const pack = (() => { const n = Number(it.unit_qty); return Number.isFinite(n) && n > 0 ? Math.round(n) : null; })();
  const effCase = it.effective_case_price ?? null;
  const effBtl = it.effective_unit_price ?? null;
  // PAY-NOW at 1 case: any quantity discount a single case already earns.
  let qd1 = 0;
  for (const t of it.tiers ?? []) {
    if (t.source !== 'discount' || normTierUnit(t.unit) === 'btl') continue;
    if (t.qty <= 1 && (t.save_per_case ?? 0) > qd1) qd1 = t.save_per_case ?? 0;
  }
  const payCase = it.frontline_case_price != null
    ? Math.max(it.frontline_case_price - qd1, 0) : null;
  const payBtl = payCase != null && pack ? payCase / pack
    : (it.frontline_unit_price ?? null);
  return (
    <tr data-ctx="" data-ctx-product={it.product_name} data-ctx-wholesaler={it.wholesaler}
        data-ctx-upc={it.upc ?? ''} data-ctx-volume={it.unit_volume ?? ''}>
      <td style={{ width: 28 }} onClick={e => e.stopPropagation()}>
        <input type="checkbox" checked={selected.has(it.id)} onChange={() => toggle(it.id)} />
      </td>
      <td>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <ProductThumb src={it.image_url} alt={it.product_name} size={56} />
          <div>
            <div
              className="product-name-link"
              style={{ fontWeight: 600 }}
              title="View price detail"
              onClick={e => { e.stopPropagation(); open(it.product_name, it.wholesaler, undefined, {
                upc: it.upc ?? undefined, unitVolume: it.unit_volume ?? undefined }); }}
            >
              {it.product_name}
              {(() => {
                // Vintage is part of the SKU identity (a shared barcode can be a
                // '23 and a '24), so show which year is on the line.
                const v = it.vintage == null ? '' : String(it.vintage).trim();
                return v && !['0', 'nv', 'none', 'nan'].includes(v.toLowerCase())
                  ? <span className="tag tag-blue" style={{ fontSize: 10, fontWeight: 700, marginLeft: 6 }}>Vintage {v}</span>
                  : null;
              })()}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{it.upc}</div>
            {(it.rip_gaps?.length ?? 0) > 0 && (
              <div style={{ marginTop: 4 }} onClick={e => e.stopPropagation()}>
                <DealTimingSticker deals={[]} gaps={it.rip_gaps} />
              </div>
            )}
          </div>
        </div>
      </td>
      <td className="cart-cell-code" title={abgSku(it.wholesaler, it.abg_sku) ? `${skuLabel(it.wholesaler)} item number` : undefined}>
        {abgSku(it.wholesaler, it.abg_sku) ? it.abg_sku : '–'}
      </td>
      <td onClick={e => e.stopPropagation()}>
        <DistributorPicker wholesaler={it.wholesaler} comparison={it.comparison} altStatus={it.alt_status}
          onSwitch={ws => switchDist.mutate(ws)} busy={switchDist.isPending} />
      </td>
      <td>{it.unit_volume}</td>
      <td title="Bottles per case">{pack ? `${pack}/cs` : '–'}</td>
      {/* Planned quantity. A RIP rebate is the tier's TOTAL at its case
          threshold, not a per-case rate that scales with qty, so we don't show a
          "qty × per-case" rebate line here (it was misleading). */}
      <td onClick={e => e.stopPropagation()}>
        <QtyStepper value={it.qty_cases ?? 0}
          onChange={n => setQty.mutate({ cases: n })} disabled={setQty.isPending} />
      </td>
      {/* Which RIP the line earns — editable when several programs apply. */}
      <td onClick={e => e.stopPropagation()}>
        <RipPicker line={it} qtyCases={it.qty_cases ?? 0}
          onChoose={code => pickRip.mutate(code)} busy={pickRip.isPending} />
      </td>
      {/* PAY-NOW at 1 case: list minus any QD a single case already earns
          (RIP rebates come later — they live in Best buy at the end). */}
      <td className="cart-cell-num">
        <span style={{ fontWeight: 600 }}>{payCase != null ? money(payCase) : '–'}</span>
        {qd1 > 0.005 && it.frontline_case_price != null && (
          <span className="cart-list-sub" title="List price per case, before any quantity discount">List {money(it.frontline_case_price)}</span>
        )}
      </td>
      <td className="cart-cell-num">
        {!keg && payBtl != null ? (
          <>
            <span style={{ fontWeight: 600 }}>{money(payBtl)}</span>
            {qd1 > 0.005 && it.frontline_unit_price != null && (
              <span className="cart-list-sub" title="List price per bottle, before any quantity discount">List {money(it.frontline_unit_price)}</span>
            )}
          </>
        ) : '–'}
      </td>
      <td onClick={e => e.stopPropagation()}>
        <DealSparkline
          interactive
          wholesaler={it.wholesaler}
          productName={it.product_name}
          upc={it.upc ?? undefined}
          unitVolume={it.unit_volume ?? undefined}
          width={130}
          height={32}
        />
      </td>
      <td className="cart-cell-num cart-bestbuy"
        title={effCase != null
          ? `Illustration only — the deepest net after EVERY QD + RIP tier per ${priceUnit(it.unit_volume, it.unit_type)}${keg ? '' : ` / per ${perUnitAbbr(it.unit_volume, it.unit_type)}`}${it.total_savings_per_case ? `. Saves ${money(it.total_savings_per_case)}/${priceUnit(it.unit_volume, it.unit_type)} vs list.` : ''}`
          : undefined}>
        {effCase != null ? `${money(effCase)}${!keg && effBtl != null ? ` / ${money(effBtl)}` : ''}` : '–'}
      </td>
      <td style={{ width: 40 }} onClick={e => e.stopPropagation()}>
        <button className="btn btn-secondary btn-sm" title="Remove from list" aria-label="Remove from list" onClick={onRemove}><Trash2 size={14} /></button>
      </td>
    </tr>
  );
}
