import { useCallback, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useOrderAnalysis } from '../contexts/OrderAnalysisContext';
import { useTableFilters } from '../hooks/useTableFilters';
import { TileFilterBar } from '../components/DashboardTile';
import CatalogTable, { loadCart, saveCart, type CartState } from '../components/CatalogTable';
import { useProductQuickView } from '../components/ProductQuickView';
import { orders, type Product } from '../lib/api';
import { distributorName } from '../lib/distributors';
import { ClipboardList, Info } from 'lucide-react';

export default function OrderAnalysis() {
  const oa = useOrderAnalysis();
  const { open } = useProductQuickView();

  // Shared cart with the Catalog screen (same localStorage key).
  const [cart, setCartState] = useState<CartState>(loadCart);
  const setCart = useCallback((update: CartState | ((p: CartState) => CartState)) => {
    setCartState(prev => {
      const next = typeof update === 'function' ? update(prev) : update;
      saveCart(next);
      return next;
    });
  }, []);
  const updateQty = useCallback((key: string, field: 'cases' | 'units', value: number) => {
    setCart(prev => ({
      ...prev,
      [key]: { cases: prev[key]?.cases ?? 0, units: prev[key]?.units ?? 0, [field]: value },
    }));
  }, [setCart]);

  const qc = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  // Turn the analysis into real draft orders, one per distributor (respecting
  // the one-open-order-per-distributor rule), using the cart quantities.
  const createOrdersFromAnalysis = useCallback(async () => {
    setSaving(true);
    try {
      const byWs = new Map<string, typeof oa.items>();
      for (const it of oa.items) {
        const arr = byWs.get(it.wholesaler) ?? [];
        arr.push(it);
        byWs.set(it.wholesaler, arr);
      }
      let orderCount = 0, lineCount = 0;
      for (const [ws, list] of byWs) {
        const res = await orders.create({ name: `${distributorName(ws)} order`, distributor: ws });
        orderCount += 1;
        for (const it of list) {
          const q = cart[`${it.product_name}|${ws}`];
          const cases = q?.cases ?? 0;
          const units = q?.units ?? 0;
          await orders.addLine(res.id, {
            product_name: it.product_name, wholesaler: ws, upc: it.upc, unit_volume: it.unit_volume,
            qty_cases: cases || (units ? 0 : 1), qty_units: units,
          });
          lineCount += 1;
        }
      }
      qc.invalidateQueries({ queryKey: ['orders'] });
      setFlash(`Saved ${lineCount} item(s) into ${orderCount} order(s), grouped by distributor.`);
      setTimeout(() => setFlash(null), 5000);
    } finally {
      setSaving(false);
    }
  }, [oa.items, cart, qc]);

  // Build catalog-shaped rows from the saved snapshots (enriched with tiers),
  // carrying combo_code so combo bundle items are identifiable + linkable.
  const rows: Product[] = useMemo(() => oa.items.map(it => ({
    product_type: '', frontline_case_price: 0, effective_case_price: 0,
    has_discount: false, has_rip: false, tiers: [],
    ...(it.product ?? {}),
    product_name: it.product?.product_name ?? it.product_name,
    wholesaler: it.product?.wholesaler ?? it.wholesaler,
    upc: it.product?.upc ?? it.upc,
    unit_volume: it.product?.unit_volume ?? it.unit_volume,
    combo_code: it.combo_code,
    combo_label: it.combo_label,
  } as unknown as Product)), [oa.items]);

  const comboLink = useCallback((item: Product) => {
    const code = (item as unknown as { combo_code?: string }).combo_code;
    return code ? `/combos?code=${encodeURIComponent(code)}` : null;
  }, []);

  const productTypes = useMemo(
    () => [...new Set(rows.map(r => r.product_type).filter(Boolean))].sort() as string[],
    [rows],
  );
  const { filtered, state, set } = useTableFilters(rows, {
    nameKeys: ['product_name'], upcKeys: ['upc'], productTypeKey: 'product_type',
    priceKey: 'frontline_case_price', discountKey: 'has_discount', ripKey: 'has_rip',
  });

  return (
    <div className="page">
      <div className="dashboard-hero">
        <div>
          <h2 className="dashboard-hero-title" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <ClipboardList size={24} /> Order Analysis
          </h2>
          <p className="dashboard-hero-sub">
            Products you've set aside while browsing — same view as the Catalog, including discount &amp; RIP tiers.
            Right-click any product anywhere and choose <strong>Add to Order Analysis</strong>; right-click here to remove.
          </p>
        </div>
        {oa.count > 0 && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {flash && <span className="add-order-flash">{flash}</span>}
            <button className="btn" onClick={createOrdersFromAnalysis} disabled={saving}>
              {saving ? 'Saving...' : 'Save as order(s)'}
            </button>
            <button className="btn btn-secondary" onClick={oa.clear}>Clear all ({oa.count})</button>
          </div>
        )}
      </div>

      {oa.count === 0 ? (
        <div className="oa-empty">
          <Info size={28} />
          <p>No products under analysis yet.</p>
          <p className="text-muted">
            As you browse the Catalog, Deals, Analytics or any screen, <strong>right-click a product</strong> (or use the
            ⋯ button) and pick <em>Add to Order Analysis</em> to collect it here for a closer look.
          </p>
        </div>
      ) : (
        <>
          <TileFilterBar
            state={state} set={set} productTypes={productTypes} showPrice
            showDeals={{ discount: true, rip: true }}
            rightSlot={<span className="text-muted" style={{ fontSize: 12 }}>{filtered.length} of {oa.count}</span>}
          />
          <CatalogTable items={filtered} open={open} cart={cart} updateQty={updateQty} comboLink={comboLink} />
        </>
      )}
    </div>
  );
}
