import { Fragment, useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { deals, catalog, cart as cartApi } from '../lib/api';
import { Plus, Check } from 'lucide-react';
import FavoriteButton from '../components/FavoriteButton';
import ProductThumb from '../components/ProductThumb';
import { RowMenuButton } from '../components/ContextMenu';
import RowLimitSelect from '../components/RowLimitSelect';
import FilterSidebar, { type FilterSection } from '../components/FilterSidebar';
import { useProductQuickView } from '../components/ProductQuickView';
import DataLoading from '../components/DataLoading';
import AddToCartButton from '../components/AddToCartButton';
import AddToListButton from '../components/AddToListButton';
import { QtyStepper, loadCart, saveCart, buildRipPaletteMap, type CartState } from '../components/CatalogTable';
import { distributorName, ALL_DISTRIBUTORS } from '../lib/distributors';

function tierLabel(unit?: string | null): string {
  if (!unit) return '';
  const u = unit.toLowerCase();
  if (u === 'c' || u.startsWith('case')) return 'cs';
  if (u === 'b' || u.startsWith('btl') || u.startsWith('bottle')) return 'btl';
  return unit;
}

function fmtPrice(v: number | null | undefined): string {
  return v == null ? '-' : `$${v.toFixed(2)}`;
}

function fmtSave(v: number | null | undefined): string {
  return v == null ? '-' : `$${v.toFixed(2)}`;
}

// Case price with the per-bottle price beneath it (same as the Catalog cells).
function priceWithBtl(caseP: number | null | undefined, btlP: number | null | undefined) {
  return (
    <>
      {fmtPrice(caseP)}
      {btlP != null && (
        <div style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 400 }}>{fmtPrice(btlP)}/btl</div>
      )}
    </>
  );
}

function fmtPct(v: number | null | undefined): string {
  return v == null ? '-' : `${v.toFixed(1)}%`;
}

function gpClass(v: number | null | undefined): string {
  if (v == null) return 'text-muted';
  if (v >= 15) return 'text-green';
  if (v >= 8) return 'text-yellow';
  return '';
}

function shortMonth(edition: string | null | undefined): string {
  if (!edition) return '';
  const [, mm] = edition.split('-');
  const names = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const idx = parseInt(mm, 10) - 1;
  return idx >= 0 && idx < 12 ? names[idx] : edition;
}

function betterMonth(curr?: number | null, next?: number | null): { label: string; variant: 'this' | 'next' | 'same' } | null {
  const c = curr ?? 0, n = next ?? 0;
  if (c <= 0 && n <= 0) return null;
  if (c > 0 && n <= 0) return { label: 'Ends', variant: 'this' };
  if (c <= 0 && n > 0) return { label: 'New Next', variant: 'next' };
  if (Math.abs(c - n) < 0.005) return { label: 'Same', variant: 'same' };
  return c > n ? { label: 'This Month', variant: 'this' } : { label: 'Next Month', variant: 'next' };
}

export default function RipProducts() {
  const [q, setQ] = useState('');
  const [ripCode, setRipCode] = useState('');
  const [wholesaler, setWholesaler] = useState('');
  const [productType, setProductType] = useState('');
  const [source, setSource] = useState('');
  const [minSave, setMinSave] = useState('');
  const [minGp, setMinGp] = useState('');
  const [tierUnit, setTierUnit] = useState('');
  const [newNext, setNewNext] = useState(false);
  const [sort, setSort] = useState('rip_save_per_case');
  const [order, setOrder] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(0);
  const [limit, setLimit] = useState(50);
  // Group-by-RIP toggle: when on, the loaded page is re-ordered client-side
  // so products sharing a rip_number cluster together and each row wears a
  // colour band keyed off the rip code (matches Catalog and the cart). The
  // existing per-product tier grouping (consecutive tier rows under one
  // product header) is preserved.
  const [groupByRip, setGroupByRip] = useState<boolean>(() =>
    localStorage.getItem('rip_products_group_by_rip') === '1'
  );
  const toggleGroupByRip = (v: boolean) => {
    setGroupByRip(v);
    if (v) localStorage.setItem('rip_products_group_by_rip', '1');
    else localStorage.removeItem('rip_products_group_by_rip');
  };
  const { open } = useProductQuickView();

  // Shared draft-cart quantities (same localStorage cart as the Catalog).
  const [cart, setCart] = useState<CartState>(loadCart);
  const updateQty = (key: string, field: 'cases' | 'units', value: number) => {
    setCart(prev => {
      const cur = prev[key] ?? { cases: 0, units: 0 };
      const next = { ...prev, [key]: { ...cur, [field]: value } };
      saveCart(next);
      return next;
    });
  };

  const { data, isLoading } = useQuery({
    queryKey: ['rip-products', q, ripCode, wholesaler, productType, source, minSave, minGp, tierUnit, newNext, sort, order, page, limit],
    queryFn: () => deals.ripProducts({
      q: q || undefined,
      rip_code: ripCode || undefined,
      wholesaler: wholesaler || undefined,
      product_type: productType || undefined,
      source: source || undefined,
      min_savings: minSave ? parseFloat(minSave) : undefined,
      min_gp: minGp ? parseFloat(minGp) : undefined,
      tier_unit: tierUnit || undefined,
      new_next: newNext || undefined,
      sort, order, limit,
      offset: page * limit,
    }),
  });

  const { data: categories } = useQuery({
    queryKey: ['categories', wholesaler],
    queryFn: () => catalog.categories({ wholesaler: wholesaler || undefined }),
  });

  const rawItems = data?.items ?? [];

  // Palette assignment by order of appearance so adjacent RIP clusters in
  // the table always render in visually distinct colours (no two-near-codes
  // hash collision).
  const ripPalette = useMemo(
    () => buildRipPaletteMap(rawItems.map(i => i.rip_number ?? null)),
    [rawItems],
  );

  // Live cart contents — drives the "X cases added · Y to next tier"
  // progress message in each group header. Refetched on a short interval
  // and on focus so adding to cart from another tab reflects here.
  const { data: cartData } = useQuery({
    queryKey: ['cart'],
    queryFn: cartApi.get,
    refetchOnWindowFocus: true,
    refetchInterval: 15000,
  });
  const qc = useQueryClient();
  const cartByKey = useMemo(() => {
    const m = new Map<string, { cases: number; units: number }>();
    for (const it of (cartData?.items ?? [])) {
      const upc = (it.upc ?? '').toString().replace(/^0+/, '');
      const k = `${it.wholesaler}|${upc}|${(it.unit_volume ?? '').toString()}`;
      const prev = m.get(k) ?? { cases: 0, units: 0 };
      m.set(k, { cases: prev.cases + (it.qty_cases || 0), units: prev.units + (it.qty_units || 0) });
    }
    return m;
  }, [cartData]);

  // Add-all-to-cart for an entire RIP group: one POST per unique product
  // in the group, starting at 1 case each. Buyer can then tune quantities
  // to hit the desired tier; the header progress message updates live.
  const addAllMut = useMutation({
    mutationFn: async (products: { product_name: string; wholesaler: string; upc?: string; unit_volume?: string }[]) => {
      let added = 0;
      for (const p of products) {
        try {
          await cartApi.add({ product_name: p.product_name, wholesaler: p.wholesaler,
            upc: p.upc, unit_volume: p.unit_volume, qty_cases: 1, qty_units: 0 });
          added++;
        } catch { /* keep going on partial failures */ }
      }
      return added;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['cart'] }); },
  });
  const [addedFlash, setAddedFlash] = useState<string | null>(null);

  // When Group by RIP is on, re-order the loaded page so products sharing a
  // rip_number cluster together. The existing per-product tier grouping
  // (multiple rows under one product header) is preserved: all tier rows of
  // a single (wholesaler, product_name, unit_volume) keep their adjacency.
  const items = useMemo(() => {
    if (!groupByRip) return rawItems;
    const groupKey = (i: typeof rawItems[number]) =>
      `${i.wholesaler}|${i.product_name}|${i.unit_volume ?? ''}`;
    const order = new Map<string, number>();
    rawItems.forEach((it, idx) => {
      const k = groupKey(it);
      if (!order.has(k)) order.set(k, idx);
    });
    const ripKey = (rc: string | null | undefined) => {
      const s = (rc ?? '').toString().trim();
      return s && s !== '0' ? s : '~';
    };
    const sorted = [...rawItems].sort((a, b) => {
      const ra = ripKey(a.rip_number);
      const rb = ripKey(b.rip_number);
      if (ra !== rb) return ra.localeCompare(rb);
      const ga = order.get(groupKey(a)) ?? 0;
      const gb = order.get(groupKey(b)) ?? 0;
      return ga - gb;
    });
    return sorted;
  }, [rawItems, groupByRip]);

  // For each contiguous run of items sharing a rip_number (when groupByRip
  // is on), pre-compute the metadata the group header needs: unique
  // products, distinct tier thresholds, and the cart-based progress label.
  // Indexed by the first-row position of each cluster so the render loop
  // can look it up in O(1).
  type GroupMeta = {
    code: string;
    paletteIdx: number;
    products: { product_name: string; wholesaler: string; upc?: string; unit_volume?: string; cartKey: string }[];
    // Distinct tier thresholds (qty, unit) with the best $ amount we've
    // seen at either curr or next edition.
    tiers: { qty: number; unit: string; amt: number; isCases: boolean }[];
    // Dominant unit decides whether we count cart cases or cart bottles.
    progressUnit: 'case' | 'btl';
    casesInCart: number;     // total across products in the group
    bottlesInCart: number;
  };
  const ripGroups = useMemo(() => {
    if (!groupByRip) return new Map<number, GroupMeta>();
    const norm = (s?: string | null) => {
      const x = String(s ?? '').toLowerCase();
      if (x === 'c' || x.startsWith('case')) return 'case';
      if (x === 'b' || x.startsWith('btl') || x.startsWith('bottle')) return 'btl';
      return 'case';
    };
    const out = new Map<number, GroupMeta>();
    let i = 0;
    while (i < items.length) {
      const code = String(items[i].rip_number ?? '').trim();
      if (!code || code === '0') { i++; continue; }
      // Walk forward to find the end of this rip_number cluster.
      let j = i;
      while (j < items.length && String(items[j].rip_number ?? '').trim() === code) j++;
      // Gather unique products + tier thresholds across [i, j).
      const productMap = new Map<string, GroupMeta['products'][number]>();
      const tierMap = new Map<string, GroupMeta['tiers'][number]>();
      let unitVotes = { case: 0, btl: 0 };
      for (let k = i; k < j; k++) {
        const it = items[k];
        const upc = (it.upc ?? '').toString().replace(/^0+/, '');
        const pKey = `${it.wholesaler}|${it.product_name}|${it.unit_volume ?? ''}`;
        if (!productMap.has(pKey)) {
          productMap.set(pKey, {
            product_name: it.product_name,
            wholesaler: it.wholesaler,
            upc: it.upc ?? undefined,
            unit_volume: it.unit_volume ?? undefined,
            cartKey: `${it.wholesaler}|${upc}|${(it.unit_volume ?? '').toString()}`,
          });
        }
        const u = norm(it.rip_unit);
        unitVotes[u]++;
        const tKey = `${it.rip_qty}|${u}`;
        // Banner reflects the CURRENT month's RIP only. Including next-month
        // tiers here (e.g., 5 cs = $500 that only kicks in next edition) mixes
        // two months' deals in one ladder and misleads the buyer into thinking
        // every threshold is live today.
        const curAmt = it.curr_rip_amt ?? 0;
        if (curAmt > 0) {
          const prev = tierMap.get(tKey);
          if (!prev || curAmt > prev.amt) {
            tierMap.set(tKey, { qty: it.rip_qty, unit: it.rip_unit ?? 'Case(s)', amt: curAmt, isCases: u === 'case' });
          }
        }
      }
      const progressUnit: 'case' | 'btl' = unitVotes.btl > unitVotes.case ? 'btl' : 'case';
      // Sum cart cases/bottles for all unique products.
      let casesInCart = 0, bottlesInCart = 0;
      for (const p of productMap.values()) {
        const cv = cartByKey.get(p.cartKey);
        if (cv) { casesInCart += cv.cases; bottlesInCart += cv.units; }
      }
      const tiers = [...tierMap.values()].sort((a, b) => a.qty - b.qty);
      out.set(i, {
        code,
        paletteIdx: 0,  // unused; we look colour up via ripPalette by code
        products: [...productMap.values()],
        tiers,
        progressUnit,
        casesInCart,
        bottlesInCart,
      });
      i = j;
    }
    return out;
  }, [groupByRip, items, cartByKey]);

  // Render a friendly progress line: "3 of 5 cases for $125 tier · 2 more
  // to qualify". Returns null when the group has no tiers.
  function groupProgress(meta: GroupMeta): { text: string; tone: 'pending' | 'reached' | 'gap' } | null {
    if (meta.tiers.length === 0) return null;
    const haveCases = meta.casesInCart;
    const haveBottles = meta.bottlesInCart;
    const have = meta.progressUnit === 'case' ? haveCases : haveBottles;
    const unitWord = meta.progressUnit === 'case' ? 'case' : 'bottle';
    const reached = meta.tiers.filter(t => have >= t.qty);
    const ahead = meta.tiers.filter(t => have < t.qty);
    if (reached.length > 0 && ahead.length === 0) {
      const top = reached[reached.length - 1];
      return { text: `✓ Top tier reached: ${have} ${unitWord}${have === 1 ? '' : 's'} · $${top.amt.toFixed(2)} rebate locked`, tone: 'reached' };
    }
    if (reached.length > 0) {
      const top = reached[reached.length - 1];
      const next = ahead[0];
      const need = next.qty - have;
      return {
        text: `${have} ${unitWord}${have === 1 ? '' : 's'} in cart · $${top.amt.toFixed(2)} earned · ${need} more for $${next.amt.toFixed(2)}`,
        tone: 'pending',
      };
    }
    const next = ahead[0];
    const need = next.qty - have;
    if (have === 0) {
      return { text: `Nothing in cart yet · buy ${next.qty} ${unitWord}${next.qty === 1 ? '' : 's'} for $${next.amt.toFixed(2)} rebate`, tone: 'gap' };
    }
    return {
      text: `${have} ${unitWord}${have === 1 ? '' : 's'} in cart · ${need} more for $${next.amt.toFixed(2)} rebate`,
      tone: 'gap',
    };
  }

  const stats = useMemo(() => {
    if (items.length === 0) return null;
    const saves = items.map(i => Math.max(i.curr_save_per_case ?? 0, i.next_save_per_case ?? 0));
    const avgSave = saves.reduce((s, v) => s + v, 0) / saves.length;
    const maxSave = saves.length ? Math.max(...saves) : 0;
    const onlyNext = items.filter(i => (i.next_save_per_case ?? 0) > 0 && (i.curr_save_per_case ?? 0) === 0).length;
    return { avgSave, maxSave, onlyNext };
  }, [items]);

  const headerEditions = useMemo(() => {
    const curr = items.find(i => i.curr_edition)?.curr_edition ?? null;
    const next = items.find(i => i.next_edition)?.next_edition ?? null;
    return { curr, next };
  }, [items]);

  const handleSort = (col: string) => {
    if (sort === col) {
      setOrder(o => o === 'asc' ? 'desc' : 'asc');
    } else {
      setSort(col);
      setOrder('desc');
    }
    setPage(0);
  };

  const sortIcon = (col: string) => {
    if (sort !== col) return '';
    return order === 'asc' ? ' ▲' : ' ▼';
  };

  const renderTierBadge = (
    qty: number,
    unit: string | null,
    amt: number | null,
    side: 'curr' | 'next'
  ) => {
    if (amt == null) return <span className="text-muted">-</span>;
    return (
      <span className={`rip-tier-badge rip-tier-${side}`}>
        {qty} {tierLabel(unit)} = <strong>${amt.toFixed(0)}</strong>
      </span>
    );
  };

  const filterSections: FilterSection[] = [
    {
      // Highlighted + pinned on the left so the user can't miss the toggle
      // that re-orders the table into rebate-stack groups (matches the
      // "bring it to the left, highlight it" ask).
      type: 'toggle',
      key: 'group_by_rip',
      title: 'Display',
      value: groupByRip,
      onChange: toggleGroupByRip,
      label: 'Group by Case Mix RIP',
      highlight: true,
    },
    {
      type: 'text',
      key: 'q',
      title: 'Search',
      placeholder: 'Product name or RIP code',
      value: q,
      onChange: v => { setQ(v); setPage(0); },
    },
    {
      type: 'text',
      key: 'rip_code',
      title: 'RIP #',
      placeholder: 'e.g. 10049',
      value: ripCode,
      onChange: v => { setRipCode(v); setPage(0); },
    },
    {
      type: 'pills',
      key: 'wholesaler',
      title: 'Distributor',
      options: ALL_DISTRIBUTORS,
      value: wholesaler,
      onChange: v => { setWholesaler(v); setPage(0); },
    },
    {
      type: 'pills',
      key: 'source',
      title: 'Incentive Type',
      options: [
        { value: '', label: 'All' },
        { value: 'discount', label: 'Discount' },
        { value: 'rip', label: 'RIP' },
      ],
      value: source,
      onChange: v => { setSource(v); setPage(0); },
    },
    {
      type: 'select',
      key: 'product_type',
      title: 'Category',
      placeholder: 'All Categories',
      options: (categories ?? []).map(c => ({
        value: c.product_type,
        label: c.product_type,
        count: c.count,
      })),
      value: productType,
      onChange: v => { setProductType(v); setPage(0); },
    },
    {
      type: 'text',
      key: 'min_save',
      title: 'Min Save / Case',
      placeholder: 'e.g. 50',
      value: minSave,
      onChange: v => { setMinSave(v); setPage(0); },
    },
    {
      type: 'text',
      key: 'min_gp',
      title: 'Min GP %',
      placeholder: 'e.g. 10',
      value: minGp,
      onChange: v => { setMinGp(v); setPage(0); },
    },
    {
      type: 'pills',
      key: 'tier_unit',
      title: 'Tier Unit',
      options: [
        { value: '', label: 'All' },
        { value: 'case', label: 'Cases' },
        { value: 'btl', label: 'Bottles' },
      ],
      value: tierUnit,
      onChange: v => { setTierUnit(v); setPage(0); },
    },
    {
      type: 'pills',
      key: 'new_next',
      title: 'Availability',
      options: [
        { value: '', label: 'All' },
        { value: '1', label: 'New next month' },
      ],
      value: newNext ? '1' : '',
      onChange: v => { setNewNext(v === '1'); setPage(0); },
    },
  ];

  const resetFilters = () => {
    setQ(''); setRipCode(''); setWholesaler(''); setProductType(''); setSource(''); setMinSave('');
    setMinGp(''); setTierUnit(''); setNewNext(false);
    setPage(0);
  };

  return (
    <FilterSidebar storageKey="rip-products" sections={filterSections} onReset={resetFilters}>
    <div className="page">
      <h2 style={{ marginBottom: 4 }}>Products with RIP</h2>
      <p className="text-muted" style={{ marginTop: 0, marginBottom: 12 }}>
        Each tier shown with current month and next month side by side
        {headerEditions.curr && headerEditions.next
          ? ` (${shortMonth(headerEditions.curr)} vs ${shortMonth(headerEditions.next)})`
          : ''}
      </p>

      <div className="rip-filter-bar">
        <RowLimitSelect value={limit} onChange={v => { setLimit(v); setPage(0); }} />
        <span className="search-count">{data?.total?.toLocaleString() ?? 0} tier lines</span>
      </div>

      {stats && (
        <div className="rip-summary-cards">
          <div className="rip-summary-card">
            <div className="rip-summary-value">{data?.total?.toLocaleString()}</div>
            <div className="rip-summary-label">RIP Tier Lines</div>
          </div>
          <div className="rip-summary-card">
            <div className="rip-summary-value text-green">${stats.avgSave.toFixed(2)}</div>
            <div className="rip-summary-label">Avg Save / Case</div>
          </div>
          <div className="rip-summary-card">
            <div className="rip-summary-value text-green">${stats.maxSave.toFixed(2)}</div>
            <div className="rip-summary-label">Max Save / Case</div>
          </div>
          <div className="rip-summary-card">
            <div className="rip-summary-value">{stats.onlyNext}</div>
            <div className="rip-summary-label">New Next Month</div>
          </div>
        </div>
      )}

      {isLoading ? <DataLoading /> : (
        <div className="rip-table-wrap">
          <table className="rip-products-table">
            <thead>
              <tr className="rip-group-header">
                <th colSpan={7} style={{ borderRight: '1px solid var(--border)' }}></th>
                <th colSpan={4} className="rip-group-curr" style={{ borderRight: '1px solid var(--border)' }}>
                  {headerEditions.curr ? `Current (${shortMonth(headerEditions.curr)})` : 'Current'}
                </th>
                <th colSpan={4} className="rip-group-next">
                  {headerEditions.next ? `Next (${shortMonth(headerEditions.next)})` : 'Next'}
                </th>
                <th></th>
              </tr>
              <tr>
                <th style={{ width: 36 }}></th>
                <th className="sortable" onClick={() => handleSort('product_name')}>
                  Product{sortIcon('product_name')}
                </th>
                <th>Distributor</th>
                <th>Type</th>
                <th>Size</th>
                <th>RIP#</th>
                <th style={{ borderRight: '1px solid var(--border)' }}>Source</th>

                <th className="sortable right" onClick={() => handleSort('curr_case_price')}>
                  Case{sortIcon('curr_case_price')}
                </th>
                <th>RIP</th>
                <th className="sortable right" onClick={() => handleSort('curr_save_per_case')}>
                  Save{sortIcon('curr_save_per_case')}
                </th>
                <th className="sortable right" onClick={() => handleSort('curr_effective_case_price')}
                    style={{ borderRight: '1px solid var(--border)' }}>
                  Effective{sortIcon('curr_effective_case_price')}
                </th>

                <th className="sortable right" onClick={() => handleSort('next_case_price')}>
                  Case{sortIcon('next_case_price')}
                </th>
                <th>RIP</th>
                <th className="sortable right" onClick={() => handleSort('next_save_per_case')}>
                  Save{sortIcon('next_save_per_case')}
                </th>
                <th className="sortable right" onClick={() => handleSort('next_effective_case_price')}>
                  Effective{sortIcon('next_effective_case_price')}
                </th>
                <th>Better</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item, idx) => {
                const prevItem = idx > 0 ? items[idx - 1] : null;
                const isFirstForProduct = !prevItem ||
                  prevItem.product_name !== item.product_name ||
                  prevItem.wholesaler !== item.wholesaler ||
                  prevItem.unit_volume !== item.unit_volume;

                const code = item.rip_number ?? '';

                // RIP-group header: render a sticky title row before the
                // first item of each cluster when Group by RIP is on. The
                // header shows the rip code in its palette colour, every
                // tier threshold available across the group, a live
                // "X cases added, Y to next tier" progress line, and an
                // Add-all-to-cart action that drops 1 case of each
                // unique product so the buyer can adjust from a starting
                // point.
                const groupMeta = groupByRip ? ripGroups.get(idx) : undefined;
                const groupPalette = groupMeta ? ripPalette.get(groupMeta.code) : null;
                const prog = groupMeta ? groupProgress(groupMeta) : null;

                // Coloured left band when Group by RIP is on. Palette is
                // assigned in order of appearance (see ripPalette above) so
                // adjacent clustered groups always read as visually distinct
                // colours.
                let ripBandStyle: React.CSSProperties | undefined;
                if (groupByRip && code) {
                  const col = ripPalette.get(code);
                  if (col) {
                    ripBandStyle = {
                      boxShadow: `inset 6px 0 0 ${col.stripe}`,
                      background: `linear-gradient(90deg, ${col.tint} 0, transparent 240px)`,
                    };
                  }
                }

                const rowKey = `${item.product_name}-${item.wholesaler}-${item.unit_volume}-${item.rip_qty}-${item.rip_unit}-${idx}`;
                return (
                <Fragment key={rowKey}>
                {groupMeta && (
                  <tr className="rip-group-banner"
                      style={groupPalette ? { background: groupPalette.tint } : undefined}>
                    <td colSpan={16} className="rip-group-banner-cell"
                        style={groupPalette ? { borderLeft: `5px solid ${groupPalette.stripe}` } : undefined}>
                      <div className="rip-group-banner-row">
                        <span className="rip-group-banner-code"
                              style={groupPalette
                                ? { background: groupPalette.stripe, color: '#fff' }
                                : undefined}>
                          {/* Inline-flex so the link glyph + "RIP" + the code
                              never break across lines: a regular space inside
                              the pill was wrapping when the banner row had
                              many tier lines stacked next to it. */}
                          <span aria-hidden>🔗</span>
                          <span>RIP&nbsp;{groupMeta.code}</span>
                        </span>
                        <span className="rip-group-banner-products">
                          {groupMeta.products.length} product{groupMeta.products.length === 1 ? '' : 's'}
                        </span>
                        {groupMeta.tiers.length > 0 && (
                          <span className="rip-group-banner-tiers">
                            {groupMeta.tiers.map((t, i) => (
                              <span key={i} className="rip-group-banner-tier"
                                    style={groupPalette ? { color: groupPalette.text } : undefined}>
                                Buy {t.qty} {t.isCases ? 'cs' : 'btl'} = <strong>${t.amt.toFixed(2)}</strong>
                              </span>
                            ))}
                          </span>
                        )}
                        {prog && (
                          <span className={`rip-group-banner-progress tone-${prog.tone}`}>
                            {prog.text}
                          </span>
                        )}
                        <button
                          className="btn btn-sm rip-group-banner-add"
                          disabled={addAllMut.isPending}
                          onClick={e => {
                            e.stopPropagation();
                            addAllMut.mutate(groupMeta.products);
                            setAddedFlash(groupMeta.code);
                            setTimeout(() => setAddedFlash(null), 1600);
                          }}
                          title={`Add 1 case of each of the ${groupMeta.products.length} products in this RIP group to your cart`}
                        >
                          {addedFlash === groupMeta.code
                            ? (<><Check size={13} /> Added</>)
                            : (<><Plus size={13} /> Add all to cart</>)}
                        </button>
                      </div>
                    </td>
                  </tr>
                )}
                <tr
                    className={`rip-row ${isFirstForProduct ? 'rip-row-first' : 'rip-row-sub'}${groupByRip && code ? ' has-rip-group' : ''}`}
                    style={ripBandStyle}
                    data-ctx=""
                    data-ctx-product={item.product_name}
                    data-ctx-wholesaler={item.wholesaler}
                    data-ctx-upc={item.upc}
                    data-ctx-volume={item.unit_volume}
                    onClick={() => open(item.product_name, item.wholesaler, undefined, { upc: item.upc, unitVolume: item.unit_volume })}
                  >
                    <td className="card-actions-cell" onClick={e => e.stopPropagation()}>
                      {isFirstForProduct && (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                          <FavoriteButton
                            productName={item.product_name}
                            wholesaler={item.wholesaler}
                            upc={item.upc}
                            unitVolume={item.unit_volume}
                          />
                          <RowMenuButton product={{ product_name: item.product_name, wholesaler: item.wholesaler, upc: item.upc, unit_volume: item.unit_volume }} />
                        </span>
                      )}
                    </td>
                    <td className="card-title-cell">
                      {isFirstForProduct ? (
                        <div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <ProductThumb src={item.image_url} alt={item.product_name} size={64} />
                            <div className="rip-cell-product">
                              <span className="rip-product-name">
                                {item.product_name}
                                {item.needs_rep_verify && (
                                  <span
                                    className="rip-needs-verify-pill"
                                    title="This product is on the RIP sheet but not on the current CPL. Confirm the case price with your sales rep before placing the order."
                                  >
                                    ⚠ Check with sales rep
                                  </span>
                                )}
                              </span>
                              {/* Identifier line that mirrors the Provi-style
                                  per-UPC header the user asked for: size,
                                  bottles per case, then the barcode so the
                                  same UPC reads the same on every screen. */}
                              <span className="rip-product-meta">
                                {item.unit_volume ?? '—'}
                                {item.unit_qty
                                  ? <> · {item.unit_qty} btl/cs</>
                                  : null}
                                {item.upc ? <> · UPC {item.upc}</> : null}
                              </span>
                              {/* "Better deal next month" identifier per
                                  UPC. Shown prominently right under the
                                  product name so the buyer can spot it
                                  without scanning the right-most column. */}
                              {(() => {
                                const bm = betterMonth(item.curr_save_per_case, item.next_save_per_case);
                                if (!bm || bm.variant !== 'next') return null;
                                return (
                                  <span className="rip-better-next-pill" title="The same SKU has a deeper rebate on next month's CPL">
                                    ⭐ Better deal next month
                                  </span>
                                );
                              })()}
                            </div>
                          </div>
                          {(() => {
                            const ckey = `${item.product_name}|${item.wholesaler}`;
                            const q = cart[ckey] ?? { cases: 0, units: 0 };
                            return (
                              <div className="catalog-order-inline" onClick={e => e.stopPropagation()}
                                style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                                  <QtyStepper label="Case" value={q.cases} onChange={v => updateQty(ckey, 'cases', v)} />
                                  <QtyStepper label="Btl" value={q.units} onChange={v => updateQty(ckey, 'units', v)} />
                                </div>
                                <AddToCartButton productName={item.product_name} wholesaler={item.wholesaler}
                                  upc={item.upc} unitVolume={item.unit_volume} qtyCases={q.cases} qtyUnits={q.units} />
                                <AddToListButton productName={item.product_name} wholesaler={item.wholesaler}
                                  upc={item.upc} unitVolume={item.unit_volume} />
                              </div>
                            );
                          })()}
                        </div>
                      ) : (
                        <span className="rip-sub-indicator">&nbsp;</span>
                      )}
                    </td>
                    <td data-label="Distributor">
                      {isFirstForProduct && (
                        <span className="cell-distributor-badge">
                          {distributorName(item.wholesaler)}
                        </span>
                      )}
                    </td>
                    <td data-label="Type">{isFirstForProduct ? item.product_type : ''}</td>
                    <td data-label="Size">{isFirstForProduct ? item.unit_volume : ''}</td>
                    <td data-label="RIP #">
                      {isFirstForProduct
                        ? (code ? <span className="rip-code-badge">{code}</span> : <span className="text-muted">—</span>)
                        : ''}
                    </td>
                    <td data-label="Incentive" style={{ borderRight: '1px solid var(--border)' }}>
                      <span className={`source-badge source-${item.source}`}>
                        {item.source === 'discount' ? 'Discount' : 'RIP'}
                      </span>
                    </td>

                    {/* Current month */}
                    <td className="right" data-label="Case (now)">
                      {isFirstForProduct ? priceWithBtl(item.curr_case_price, item.curr_btl_price) : ''}
                    </td>
                    <td data-label="Tier (now)">
                      {/* Always show the tier badge ("Buy 2 cs = $30") on
                          every row so a sub-row's bare "RIP" source tag is
                          never ambiguous: the user can read the threshold
                          and rebate straight from the row, not just the
                          banner. */}
                      {renderTierBadge(item.rip_qty, item.rip_unit, item.curr_rip_amt, 'curr')}
                    </td>
                    <td className="right" data-label="Save (now)">
                      {item.curr_save_per_case != null ? (
                        <>
                          <span className="text-green font-bold">{fmtSave(item.curr_save_per_case)}</span>
                          {item.curr_btl_price != null && item.curr_effective_btl_price != null && (
                            <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{fmtSave(item.curr_btl_price - item.curr_effective_btl_price)}/btl</div>
                          )}
                        </>
                      ) : <span className="text-muted">-</span>}
                    </td>
                    <td className="right font-bold" data-label="Eff (now)" style={{ borderRight: '1px solid var(--border)' }}>
                      {priceWithBtl(item.curr_effective_case_price, item.curr_effective_btl_price)}
                    </td>

                    {/* Next month */}
                    <td className="right" data-label="Case (next)">
                      {isFirstForProduct ? priceWithBtl(item.next_case_price, item.next_btl_price) : ''}
                    </td>
                    <td data-label="Tier (next)">
                      {renderTierBadge(item.rip_qty, item.rip_unit, item.next_rip_amt, 'next')}
                    </td>
                    <td className="right" data-label="Save (next)">
                      {item.next_save_per_case != null ? (
                        <>
                          <span className="text-green font-bold">{fmtSave(item.next_save_per_case)}</span>
                          {item.next_btl_price != null && item.next_effective_btl_price != null && (
                            <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{fmtSave(item.next_btl_price - item.next_effective_btl_price)}/btl</div>
                          )}
                        </>
                      ) : <span className="text-muted">-</span>}
                    </td>
                    <td className="right font-bold" data-label="Eff (next)">
                      {priceWithBtl(item.next_effective_case_price, item.next_effective_btl_price)}
                    </td>
                    <td data-label="Better">
                      {(() => {
                        const bm = betterMonth(item.curr_save_per_case, item.next_save_per_case);
                        return bm
                          ? <span className="better-price-badge" data-variant={bm.variant}>{bm.label}</span>
                          : <span className="text-muted">—</span>;
                      })()}
                    </td>
                  </tr>
                </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="pagination">
        <button disabled={page === 0} onClick={() => setPage(p => p - 1)}>Prev</button>
        <span>Page {page + 1} of {Math.max(1, Math.ceil((data?.total ?? 0) / limit))}</span>
        <button disabled={(page + 1) * limit >= (data?.total ?? 0)} onClick={() => setPage(p => p + 1)}>Next</button>
      </div>
    </div>
    </FilterSidebar>
  );
}
