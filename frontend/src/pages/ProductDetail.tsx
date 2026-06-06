import { useEffect, useMemo, useState, useCallback } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, Store, ChevronRight } from 'lucide-react';
import { catalog } from '../lib/api';
import ProductThumb from '../components/ProductThumb';
import FavoriteButton from '../components/FavoriteButton';
import AddToCartButton from '../components/AddToCartButton';
import AddToListButton from '../components/AddToListButton';
import { QtyStepper, loadCart, saveCart, type CartState } from '../components/CatalogTable';
import PriceSparklines from '../components/PriceSparklines';
import { buildMonths } from '../lib/promotionsSparkline';
import { useProductSizes, bottlesPerCase } from '../lib/productSizes';
import { useComboLink } from '../lib/comboLink';
import { distributorName, abgSku, skuLabel } from '../lib/distributors';
import type { Product, CatalogTier } from '../lib/api';

// ---- size / oz helpers ----
function toMl(label?: string | null): number {
  const s = (label || '').toUpperCase().trim();
  const m = s.match(/^([\d.]+)\s*(ML|L|LIT|LITER|OZ)?/);
  if (!m) return Number.MAX_SAFE_INTEGER;
  const n = parseFloat(m[1]);
  if (isNaN(n)) return Number.MAX_SAFE_INTEGER;
  const unit = m[2] || 'ML';
  if (unit.startsWith('L')) return n * 1000;
  if (unit === 'OZ') return n * 29.5735;
  return n;
}
function ozPerBottle(uv?: string | null): number | null {
  const ml = toMl(uv);
  return ml === Number.MAX_SAFE_INTEGER ? null : ml / 29.5735;
}
function oz(v: number | null | undefined): string {
  return v == null ? '' : ` ($${v.toFixed(2)}/oz)`;
}
const unitWord = (qty: number, unit: string) =>
  /btl|bottle/i.test(unit) ? (qty === 1 ? 'bottle' : 'bottles') : (qty === 1 ? 'case' : 'cases');

// Build the /product deep link for a related product card.
function detailUrl(p: { wholesaler: string; product_name: string; upc?: string | null }): string {
  const q = new URLSearchParams({ w: p.wholesaler, n: p.product_name });
  if (p.upc) q.set('u', String(p.upc));
  return `/product?${q.toString()}`;
}

// ---- a related-product mini card (case-mix RIP siblings / more from brand) ----
function MiniCard({ p }: { p: Product }) {
  const eff = p.effective_case_price ?? p.frontline_case_price ?? null;
  const sku = abgSku(p.wholesaler, p.abg_sku) ? `${skuLabel(p.wholesaler)} ${p.abg_sku}` : null;
  return (
    <Link to={detailUrl(p)} className="pd-mini">
      <ProductThumb src={p.image_url} alt={p.product_name} size={72} />
      <div className="pd-mini-name">{p.product_name}</div>
      <div className="pd-mini-dist"><Store size={11} /> {distributorName(p.wholesaler)}</div>
      {/* UPC + vendor SKU — shown on every product display, per spec. */}
      {(sku || p.upc) && (
        <div className="pd-mini-ids">
          {sku && <span>SKU: {sku}</span>}
          {p.upc && <span>UPC: {p.upc}</span>}
        </div>
      )}
      <div className="pd-mini-price">
        {eff != null ? `$${eff.toFixed(2)}/cs` : <span className="pd-mini-noprice">Price not available</span>}
      </div>
      <PriceSparklines wholesaler={p.wholesaler} productName={p.product_name}
        upc={p.upc} unitVolume={p.unit_volume} unitQty={p.unit_qty} vintage={p.vintage} />
    </Link>
  );
}

// ---- one size section in the right rail ----
function SizeSection({ size, view, cart, updateQty, primaryName }: {
  size: Product;
  view: 'deals' | 'bottles';
  cart: CartState;
  updateQty: (key: string, field: 'cases' | 'units', value: number) => void;
  primaryName?: string;
}) {
  const [dealsOpen, setDealsOpen] = useState(true);
  const cartKey = `${size.product_name}|${size.wholesaler}|${size.upc ?? ''}|${size.unit_volume ?? ''}`;
  const qty = cart[cartKey] ?? { cases: 0, units: 0 };
  // True bottles-per-case (corrects slash-multipacks where unit_qty is trays).
  const pack = bottlesPerCase(size.product_name, size.unit_qty);
  const ozB = ozPerBottle(size.unit_volume);
  const tiers: CatalogTier[] = size.tiers ?? [];
  const discTiers = tiers.filter(t => t.source === 'discount').sort((a, b) => a.qty - b.qty);
  const ripTiers = tiers.filter(t => t.source === 'rip').sort((a, b) => a.qty - b.qty);
  const sku = abgSku(size.wholesaler, size.abg_sku) ? `${skuLabel(size.wholesaler)} ${size.abg_sku}` : size.upc;
  const hasVintage = size.vintage != null && !['', '0', 'nv'].includes(String(size.vintage).trim().toLowerCase());
  const comboLink = useComboLink();
  const comboUrl = comboLink(size.wholesaler, size.upc);
  // Per-bottle from the corrected pack (so a 50mL 120-pack reads $2.99, not $35.90).
  const btl = (caseVal: number | null | undefined) => (caseVal != null && pack ? caseVal / pack : null);

  const headlineCase = size.frontline_case_price;
  const headlineBtl = btl(headlineCase) ?? size.frontline_unit_price;
  const caseOz = ozB && pack ? headlineCase / (ozB * pack) : null;
  const btlOz = ozB ? headlineBtl / ozB : null;
  const showDeals = view === 'deals';

  return (
    <div className="pd-size">
      <div className="pd-size-head">
        <div>
          <div className="pd-size-title">
            {hasVintage && <span className="pd-size-vintage-lead">{size.vintage}</span>}
            {size.unit_volume || '—'} Bottle
          </div>
          {/* Variant / edition name (e.g. "...250TH", a Festive pack) so the
              buyer can tell same-size SKUs apart and order the right one. */}
          {primaryName && size.product_name && size.product_name !== primaryName && (
            <div className="pd-size-variant">{size.product_name}</div>
          )}
          <div className="pd-size-pack">{pack ? `${pack} bottles/case` : 'single unit'}</div>
          <div className="pd-size-ids">
            {sku && <span>SKU: {sku}</span>}
            {size.upc && <span className="pd-size-upc">UPC: {size.upc}</span>}
            {hasVintage && <span className="tag tag-blue">Vintage {size.vintage}</span>}
            {comboUrl && (
              <Link to={comboUrl} className="prod-combo-sticker"
                title="Part of a combo bundle — view the combo">🎁 Combo</Link>
            )}
          </div>
        </div>
        <AddToListButton productName={size.product_name} wholesaler={size.wholesaler}
          upc={size.upc} unitVolume={size.unit_volume} />
      </div>

      {showDeals && discTiers.length > 0 && (
        <div className="pd-deals">
          <button type="button" className="pd-deals-toggle" onClick={() => setDealsOpen(o => !o)}>
            {discTiers.length} Deal{discTiers.length === 1 ? '' : 's'}
            <ChevronDown size={13} className={`pd-deals-chev${dealsOpen ? ' is-open' : ''}`} />
          </button>
          {dealsOpen && (
            <div className="pd-deals-body">
              <div className="pd-deals-label">Quantity</div>
              {discTiers.map((t, i) => {
                const tb = btl(t.price_after) ?? t.btl_price_after;
                const tBtlOz = ozB && tb != null ? tb / ozB : null;
                return (
                  <div key={i} className="pd-deal-line">
                    Buy {t.qty} {unitWord(t.qty, t.unit)} – <strong>${(t.price_after ?? 0).toFixed(2)}/case</strong>
                    {t.save_per_case > 0 && <span className="pd-deal-off"> (${t.save_per_case.toFixed(2)} off)</span>}
                    {tb != null && <> – ${tb.toFixed(2)}/bottle</>}
                    {tBtlOz != null && <span className="pd-oz">{oz(tBtlOz)}</span>}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      <div className="pd-size-price">
        <div className="pd-price-line">
          <strong>${headlineBtl.toFixed(2)}/bottle</strong><span className="pd-oz">{oz(btlOz)}</span>
        </div>
        <div className="pd-price-line">
          <strong>${headlineCase.toFixed(2)}/case</strong><span className="pd-oz">{oz(caseOz)}</span>
        </div>
        {/* Two price sparklines (1-case-discount + best-RIP) with a hover
            tooltip exposing the 3-month schedule — replaces the old
            "See price schedule" link. */}
        <span className="pd-schedule-spark">
          <PriceSparklines wholesaler={size.wholesaler} productName={size.product_name}
            upc={size.upc} unitVolume={size.unit_volume} unitQty={size.unit_qty} vintage={size.vintage}
            months={buildMonths(size)} />
        </span>
      </div>

      {/* Case-mix RIP tiers, by RIP tier — surfaced like the reference "Mix RIP" box. */}
      {ripTiers.length > 0 && (
        <div className="pd-mixrip">
          <div className="pd-mixrip-head">Mix RIP{size.rip_code ? ` · RIP ${size.rip_code}` : ''}</div>
          {ripTiers[0]?.description && <div className="pd-mixrip-desc">{ripTiers[0].description}</div>}
          {ripTiers.map((t, i) => (
            <div key={i} className="pd-mixrip-line">
              Buy {t.qty} {unitWord(t.qty, t.unit)} – <strong>${t.amount.toFixed(2)} RIP</strong>
              {t.price_after != null && (() => {
                const mb = btl(t.price_after) ?? t.btl_price_after;
                return (
                  <span className="pd-mixrip-after">
                    {' → '}${t.price_after.toFixed(2)}/case
                    {mb != null && <> · ${mb.toFixed(2)}/bottle</>}
                  </span>
                );
              })()}
            </div>
          ))}
        </div>
      )}

      <div className="pd-size-order">
        <div className="pd-steppers">
          <QtyStepper label="Bottles" value={qty.units} onChange={v => updateQty(cartKey, 'units', v)} />
          <QtyStepper label="Cases" value={qty.cases} onChange={v => updateQty(cartKey, 'cases', v)} />
        </div>
        <AddToCartButton productName={size.product_name} wholesaler={size.wholesaler}
          upc={size.upc} unitVolume={size.unit_volume} qtyCases={qty.cases} qtyUnits={qty.units} />
      </div>
    </div>
  );
}

export default function ProductDetail() {
  const [params] = useSearchParams();
  const wholesaler = params.get('w') ?? '';
  const name = params.get('n') ?? '';
  const upc = params.get('u') ?? undefined;

  const [cart, setCartState] = useState<CartState>(loadCart);
  const [view, setView] = useState<'deals' | 'bottles'>('deals');

  // Scroll to top whenever we navigate to a different product (related cards
  // reuse this same route with new query params).
  useEffect(() => { window.scrollTo({ top: 0 }); }, [wholesaler, name]);

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

  // Enrichment + producer + ai blurb (one representative SKU).
  const { data: detail } = useQuery({
    enabled: !!wholesaler && !!name,
    queryKey: ['pd-detail', wholesaler, name, upc],
    queryFn: () => catalog.product(wholesaler, name, { upc }),
  });

  // Every size of this product — via the shared "products by size" tool
  // (spirits: name-core variant grouping; wine: grouped by name + vintage).
  const { sizes, isLoading, isError, refetch } = useProductSizes(wholesaler, name, upc);

  const enrichment = detail?.enrichment;
  const product = detail?.product;
  const brand = enrichment?.brand ?? product?.brand ?? sizes[0]?.brand ?? null;
  // Pick the case-mix RIP code shared by the MOST sizes (the product's primary
  // rebate), not just the first size's — a single 100mL pack often carries a
  // different one-off code than the rest of the line.
  const ripCode = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of sizes) {
      const c = s.rip_group_code ?? s.rip_code;
      if (c && !['None', 'nan', '0', ''].includes(String(c))) {
        const k = String(c);
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
    }
    let best: string | null = null, n = 0;
    for (const [k, v] of counts) if (v > n) { best = k; n = v; }
    return best;
  }, [sizes]);
  const anyDisc = sizes.some(s => s.has_discount);   // quantity discount
  const anyRip = sizes.some(s => s.has_rip);          // RIP
  const comboLink = useComboLink();
  const anyComboUrl = sizes.map(s => comboLink(s.wholesaler, s.upc)).find(Boolean) ?? null;

  // Other products in the same Case Mix RIP — all visible, no "view all".
  const { data: ripSiblings } = useQuery({
    enabled: !!ripCode && !!wholesaler,
    queryKey: ['pd-rip-siblings', wholesaler, ripCode, upc],
    queryFn: () => catalog.ripSiblings(wholesaler, ripCode!, { exclude_upc: upc }),
  });

  // More from the same manufacturer (brand).
  const { data: brandData } = useQuery({
    enabled: !!brand,
    queryKey: ['pd-brand', wholesaler, brand],
    queryFn: () => catalog.search({ q: brand ?? '', brands: brand ?? undefined, limit: 24, sort: 'product_name', order: 'asc' }),
  });
  const brandProducts = useMemo(() => {
    const rows = (brandData?.items ?? []) as Product[];
    const seen = new Set<string>();
    const out: Product[] = [];
    for (const r of rows) {
      if (r.product_name === name) continue;
      const k = `${r.wholesaler}|${r.product_name}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(r);
    }
    return out.slice(0, 12);
  }, [brandData, name]);

  // Breadcrumb from the enrichment category path, else the product type.
  const crumbs = useMemo(() => {
    const path = enrichment?.category_path?.filter(Boolean) ?? [];
    if (path.length) return path;
    return product?.product_type ? [product.product_type] : [];
  }, [enrichment, product]);

  const specs = enrichment?.specs ? Object.entries(enrichment.specs).filter(([, v]) => v != null && String(v) !== '') : [];
  const hasDesc = !!enrichment?.description && enrichment.description !== 'No description found.';

  if (!wholesaler || !name) {
    return <div className="page"><p>Product not specified.</p><Link to="/products" className="link-btn">← Back to Products</Link></div>;
  }

  return (
    <div className="page pd-page">
      <nav className="pd-breadcrumb">
        <Link to="/">Home</Link>
        <Link to="/products">Products</Link>
        {crumbs.map((c, i) => (
          <span key={i} className="pd-crumb">{c}</span>
        ))}
      </nav>

      <div className="pd-layout">
        {/* ---- Left column: identity + info + related ---- */}
        <div className="pd-left">
          {anyDisc && <span className="pd-deal-badge pd-deal-qd">QD</span>}
          {anyRip && <span className="pd-deal-badge pd-deal-rip">RIP</span>}
          {anyComboUrl && (
            <Link to={anyComboUrl} className="pd-deal-badge pd-deal-combo"
              title="Part of a combo bundle — view the combo">🎁 Combo</Link>
          )}
          <div className="pd-identity">
            <ProductThumb src={enrichment?.image_url ?? sizes[0]?.image_url} alt={name} size={120} />
            <div className="pd-identity-meta">
              <div className="pd-identity-titlerow">
                <FavoriteButton productName={name} wholesaler={wholesaler} upc={sizes[0]?.upc} unitVolume={sizes[0]?.unit_volume} />
                <h1 className="pd-title">{name}</h1>
              </div>
              <dl className="pd-attrs">
                {enrichment?.region && <div><dt>Region</dt><dd>{enrichment.region}</dd></div>}
                {specs.map(([k, v]) => (
                  <div key={k}><dt>{k}</dt><dd>{String(v)}</dd></div>
                ))}
                {brand && <div><dt>Producer</dt><dd>{brand}</dd></div>}
                {brand && (
                  <div><dt></dt><dd><Link to={`/products?brands=${encodeURIComponent(brand)}`} className="pd-link">View all {brand}</Link></dd></div>
                )}
                <div><dt>Sold by</dt><dd><span className="pd-sold-by"><Store size={12} /> {distributorName(wholesaler)}</span></dd></div>
              </dl>
            </div>
          </div>

          {hasDesc && (
            <section className="pd-section">
              <h2>Product information</h2>
              <p>{enrichment!.description}</p>
            </section>
          )}

          {detail?.ai_blurb && (
            <section className="pd-section pd-ai">
              <h2>What this means</h2>
              <p>{detail.ai_blurb}</p>
            </section>
          )}

          {/* Other products in this Case Mix RIP — all visible, no "view all". */}
          {ripCode && (ripSiblings?.items?.length ?? 0) > 0 && (
            <section className="pd-section">
              <h2>Other products in this Case Mix RIP <span className="pd-rip-tag">RIP {ripCode}</span></h2>
              <p className="pd-section-sub">Buy these together to qualify for the RIP.</p>
              <div className="pd-related-grid">
                {ripSiblings!.items.map((p, i) => <MiniCard key={`${p.upc}|${i}`} p={p} />)}
              </div>
            </section>
          )}

          {/* More from the same manufacturer. */}
          {brandProducts.length > 0 && (
            <section className="pd-section">
              <h2 className="pd-section-head-row">
                <span>More from {brand}</span>
                {brand && <Link to={`/products?brands=${encodeURIComponent(brand)}`} className="pd-viewall">View All <ChevronRight size={14} /></Link>}
              </h2>
              <div className="pd-related-grid">
                {brandProducts.map((p, i) => <MiniCard key={`${p.wholesaler}|${p.product_name}|${i}`} p={p} />)}
              </div>
            </section>
          )}
        </div>

        {/* ---- Right column: per-size deals / bottles ---- */}
        <div className="pd-right">
          <div className="pd-right-tabs">
            <button type="button" className={`pd-tab${view === 'deals' ? ' is-active' : ''}`} onClick={() => setView('deals')}>
              Deals
            </button>
            <button type="button" className={`pd-tab${view === 'bottles' ? ' is-active' : ''}`} onClick={() => setView('bottles')}>
              Bottles
            </button>
          </div>
          <div className="pd-sizes">
            {isError ? (
                <div className="pd-loading">
                  <p>Couldn’t load sizes.</p>
                  <button type="button" className="btn btn-secondary" onClick={() => refetch()}>Retry</button>
                </div>
              )
              : isLoading ? <p className="pd-loading">Loading sizes…</p>
              : sizes.length === 0 ? <p className="pd-loading">No sizes found.</p>
              : sizes.map((s, i) => (
                <SizeSection key={`${s.product_name}|${s.upc}|${s.unit_volume}|${i}`}
                  size={s} view={view} cart={cart} updateQty={updateQty} primaryName={name} />
              ))}
          </div>
        </div>
      </div>
    </div>
  );
}
