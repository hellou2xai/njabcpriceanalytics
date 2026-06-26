import { useEffect, useMemo, useState, useCallback } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { loadCart, saveCart, type CartState } from '../components/CatalogTable';
import ProductListingCard from '../components/ProductListingCard';
import { useProductSizes, sizeToMl, stripHeaderVintage } from '../lib/productSizes';

const upcNorm = (v: unknown) => String(v ?? '').replace(/^0+/, '');

export default function ProductDetail() {
  const [params] = useSearchParams();
  const wholesaler = params.get('w') ?? '';
  const name = params.get('n') ?? '';
  const upc = params.get('u') ?? undefined;
  const sizeParam = params.get('s') ?? undefined;   // exact unit_volume of the clicked SKU

  const [cart, setCartState] = useState<CartState>(loadCart);
  useEffect(() => { window.scrollTo({ top: 0 }); }, [wholesaler, name, upc, sizeParam]);

  const setCart = useCallback((upd: CartState | ((p: CartState) => CartState)) => {
    setCartState(prev => {
      const next = typeof upd === 'function' ? upd(prev) : upd;
      saveCart(next);
      return next;
    });
  }, []);
  const updateQty = useCallback((key: string, field: 'cases' | 'units', value: number) => {
    setCart(prev => ({ ...prev, [key]: { cases: prev[key]?.cases ?? 0, units: prev[key]?.units ?? 0, [field]: value } }));
  }, [setCart]);

  // The product's listings (every size, and the same product at other
  // distributors). We then narrow to the ONE the user clicked.
  const { sizes, isLoading, isError, refetch } = useProductSizes(wholesaler, name, upc, true, true);

  // Show ONLY the clicked product, not the whole family: match the seed UPC and
  // exact size, preferring the clicked distributor. Falls back to all sizes only
  // when the click carried no UPC/size to scope by (e.g. a bare family link).
  const listings = useMemo(() => {
    const seedUpc = upc ? upcNorm(upc) : null;
    let rows = sizes;
    if (seedUpc || sizeParam) {
      rows = sizes.filter(s =>
        (!seedUpc || upcNorm(s.upc) === seedUpc) &&
        (!sizeParam || s.unit_volume === sizeParam));
      const own = rows.filter(s => s.wholesaler === wholesaler);
      if (own.length) rows = own;
      if (rows.length === 0) rows = sizes;   // safety: never show an empty page
    }
    const vnum = (v: unknown) => { const n = parseInt(String(v ?? ''), 10); return Number.isFinite(n) ? n : -1; };
    return [...rows].sort((a, b) =>
      sizeToMl(a.unit_volume) - sizeToMl(b.unit_volume)
      || (a.wholesaler === wholesaler ? 0 : 1) - (b.wholesaler === wholesaler ? 0 : 1)
      || a.wholesaler.localeCompare(b.wholesaler)
      || vnum(b.vintage) - vnum(a.vintage));
  }, [sizes, upc, sizeParam, wholesaler]);

  if (!wholesaler || !name) {
    return <div className="page"><p>Product not specified.</p><Link to="/products" className="link-btn">← Back to Products</Link></div>;
  }

  return (
    <div className="page pdx-page">
      <div className="pdx-top">
        <Link to="/products" className="pdx-back">← Products</Link>
        <h1 className="pdx-page-title">{stripHeaderVintage(name, listings[0]?.product_type)}</h1>
      </div>

      {isError ? (
        <div className="pdx-loading">
          <p>Couldn’t load this product.</p>
          <button type="button" className="btn btn-secondary" onClick={() => refetch()}>Retry</button>
        </div>
      ) : isLoading ? (
        <p className="pdx-loading">Loading…</p>
      ) : listings.length === 0 ? (
        <p className="pdx-loading">No listing found.</p>
      ) : (
        <div className="pdx-listings">
          {listings.map((s, i) => (
            <ProductListingCard key={`${s.product_name}|${s.upc}|${s.unit_volume}|${s.wholesaler}|${i}`}
              size={s} name={name} cart={cart} updateQty={updateQty} />
          ))}
        </div>
      )}
    </div>
  );
}
