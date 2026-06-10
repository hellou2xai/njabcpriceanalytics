import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Search, Sparkles, Store, ChevronRight } from 'lucide-react';
import { catalog, compare } from '../lib/api';
import type { Product } from '../lib/api';
import ProductThumb from '../components/ProductThumb';
import { distributorName, packLabel, priceUnit } from '../lib/distributors';
import { bottlesPerCase } from '../lib/productSizes';
import './Home.css';

const MAX_BOTTLE_PRICE = 500;
// per-bottle price (case price / bottles-per-case), used for the < $500 filter
function perBottle(p: Product): number | null {
  const caseP = p.effective_case_price ?? p.frontline_case_price ?? null;
  if (caseP == null) return p.frontline_unit_price ?? null;
  const pack = bottlesPerCase(p.product_name, p.unit_qty);
  return pack && pack > 0 ? caseP / pack : (p.frontline_unit_price ?? caseP);
}

/**
 * Home — the post-login landing. A search-first storefront (not the dashboard):
 * a hero search that routes to the Products page, quick category browsing, and
 * rails of REAL products per category pulled from the actual distributor
 * catalogues, plus the distributors the account can see. All data comes from
 * the same catalog/compare APIs the rest of the app uses — no mock data.
 */

// All major categories, ordered Spirits -> Wine -> Beer -> the rest. A rail with
// no mid-priced, image-having products simply hides itself.
const RAILS: { key: string; label: string }[] = [
  { key: 'Spirits', label: 'Spirits' },
  { key: 'Wine', label: 'Wine' },
  { key: 'Beer', label: 'Beer' },
  { key: 'RTD', label: 'Ready-to-Drink' },
  { key: 'FAB', label: 'Seltzer & FMB' },
  { key: 'Cider', label: 'Cider' },
  { key: 'Sparkling', label: 'Sparkling' },
  { key: 'Hemp', label: 'Hemp / THC' },
];
const BROWSE: { key: string; label: string }[] = [
  { key: 'Beer', label: 'Beer' },
  { key: 'Wine', label: 'Wine' },
  { key: 'Spirits', label: 'Spirits' },
  { key: 'RTD', label: 'Ready-to-Drink' },
  { key: 'FAB', label: 'Seltzer / FMB' },
  { key: 'Cider', label: 'Cider' },
  { key: 'Non-Alcoholic', label: 'Non-Alcoholic' },
];

const money = (v?: number | null) => (v == null ? null : `$${Number(v).toFixed(2)}`);
const detailUrl = (p: Product) => {
  const q = new URLSearchParams({ w: p.wholesaler, n: p.product_name });
  if (p.upc) q.set('u', String(p.upc));
  return `/product?${q.toString()}`;
};

function ProductCard({ p }: { p: Product }) {
  const navigate = useNavigate();
  const price = money(p.effective_case_price ?? p.frontline_case_price);
  return (
    <button className="home-card" onClick={() => navigate(detailUrl(p))}>
      <ProductThumb src={p.image_url} alt={p.product_name} size={96} />
      <div className="home-card-name">{p.product_name}</div>
      <div className="home-card-sub">
        {p.unit_volume || '-'}{packLabel(p.unit_volume, p.unit_qty, p.unit_type) ? ` · ${packLabel(p.unit_volume, p.unit_qty, p.unit_type)}` : ''}
      </div>
      <div className="home-card-dist"><Store size={11} /> {distributorName(p.wholesaler)}</div>
      <div className="home-card-price">{price ? `${price}/${priceUnit(p.unit_volume, p.unit_type)}` : <span className="home-card-noprice">Price not available</span>}</div>
    </button>
  );
}

function Rail({ category, label }: { category: string; label: string }) {
  const navigate = useNavigate();
  const { data, isLoading } = useQuery({
    queryKey: ['home-rail', category],
    // price-agnostic sample (by name) so we span the whole price range, then
    // keep MID-priced products with an image — avoids both the ultra-premium /
    // anomalous high-priced items and the cheapest filler.
    queryFn: () => catalog.search({ categories: category, limit: 120, sort: 'product_name', order: 'asc' }),
    staleTime: 5 * 60_000,
  });
  const items = (() => {
    // De-duplicate to one card per distinct product: same UPC (or, when the UPC
    // is missing, same name + size) can come back as several rows (multiple
    // distributors, split listings). Sort cheapest-first, then keep the first of
    // each identity so the survivor is the best-priced offer.
    const seen = new Set<string>();
    const ok = ((data?.items ?? []) as Product[])
      .map(p => ({ p, btl: perBottle(p) }))
      .filter(x => !!x.p.image_url && x.btl != null && x.btl > 0 && x.btl < MAX_BOTTLE_PRICE)
      .sort((a, b) => (a.btl as number) - (b.btl as number))
      .filter(x => {
        const upc = x.p.upc ? String(x.p.upc).replace(/^0+/, '') : '';
        const key = upc || `${(x.p.product_name || '').toLowerCase().trim()}|${x.p.unit_volume || ''}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    if (ok.length <= 12) return ok.map(x => x.p);
    // take a window centred on the median so the rail reads as "mid-priced"
    const start = Math.min(Math.floor(ok.length * 0.35), Math.max(0, ok.length - 12));
    return ok.slice(start, start + 12).map(x => x.p);
  })();
  if (!isLoading && !items.length) return null;
  return (
    <section className="home-rail">
      <div className="home-rail-head">
        <h2>Top {label} from your distributors</h2>
        <button className="home-link" onClick={() => navigate(`/products?categories=${encodeURIComponent(category)}`)}>
          View all <ChevronRight size={14} />
        </button>
      </div>
      <div className="home-rail-track">
        {items.map((p, i) => <ProductCard key={`${p.upc}|${i}`} p={p} />)}
      </div>
    </section>
  );
}

export default function Home() {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const { data: dists } = useQuery({
    queryKey: ['home-distributors'],
    queryFn: compare.options,
    staleTime: 10 * 60_000,
  });
  const go = () => { if (q.trim()) navigate(`/products?q=${encodeURIComponent(q.trim())}`); };

  return (
    <div className="page home-page">
      <div className="home-hero">
        <div className="home-brand"><Sparkles size={26} /> Celr AI</div>
        <h1 className="home-hero-title">Find any product, at any distributor</h1>
        <div className="home-search">
          <Search size={20} className="home-search-icon" />
          <input
            autoFocus
            placeholder="Search products, brands or distributors…"
            value={q}
            onChange={e => setQ(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') go(); }}
          />
          <button type="button" className="home-search-go" onClick={go}>Search</button>
        </div>
        <div className="home-browse">
          {BROWSE.map(b => (
            <button key={b.key} type="button" className="home-chip"
              onClick={() => navigate(`/products?categories=${encodeURIComponent(b.key)}`)}>
              {b.label}
            </button>
          ))}
        </div>
      </div>

      {RAILS.map(r => <Rail key={r.key} category={r.key} label={r.label} />)}

      {!!dists?.length && (
        <section className="home-rail">
          <div className="home-rail-head"><h2>Your distributors</h2></div>
          <div className="home-dists">
            {dists.map(d => (
              <button key={d.wholesaler} type="button" className="home-dist"
                onClick={() => navigate(`/products?wholesaler=${encodeURIComponent(d.wholesaler)}`)}>
                <Store size={15} />
                <span className="home-dist-name">{distributorName(d.wholesaler)}</span>
                <span className="home-dist-n">{d.products.toLocaleString()} products</span>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
