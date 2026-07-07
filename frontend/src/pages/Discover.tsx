/**
 * Discover — market-intelligence landing. A stack of horizontal "Top <Category>"
 * rails (spirit categories, then wine varietals) ordered by MI sales revenue.
 * Each rail lazy-loads its top products (ranked by MI 9L sales volume desc) only
 * when it scrolls into view, and its header deep-links into the existing Products
 * page with the category filter + volume sort. Does not touch the Products page.
 */
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { catalog, type MiRail, type Product } from '../lib/api';
import ProductThumb from '../components/ProductThumb';
import './Discover.css';

const TYPES = ['Beer', 'Wine', 'Spirits', 'RTD', 'Seltzer', 'Cider', 'Non-Alcoholic'];

// Build the Products deep-link for a rail: its filter params + volume sort.
function railHref(params: Record<string, string>): string {
  const sp = new URLSearchParams({ ...params, sort: 'mi_volume', order: 'desc' });
  return `/products?${sp.toString()}`;
}

// Fire once when the element first scrolls near the viewport (lazy rails).
function useInView<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (!ref.current || seen) return;
    const io = new IntersectionObserver(
      ([e]) => { if (e.isIntersecting) { setSeen(true); io.disconnect(); } },
      { rootMargin: '300px' },
    );
    io.observe(ref.current);
    return () => io.disconnect();
  }, [seen]);
  return { ref, seen };
}

function money(n?: number | null): string | null {
  return n == null ? null : `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

// Dedupe search rows (many sizes/distributors per product) to one card each.
function distinctProducts(items: Product[], max: number): Product[] {
  const seen = new Set<string>();
  const out: Product[] = [];
  for (const p of items) {
    const k = (p.product_name || '').toUpperCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
    if (out.length >= max) break;
  }
  return out;
}

function Rail({ rail }: { rail: MiRail }) {
  const { ref, seen } = useInView<HTMLElement>();
  const { data, isLoading } = useQuery({
    queryKey: ['mi-rail', rail.params],
    enabled: seen,
    staleTime: 300_000,
    queryFn: () => catalog.search({ ...rail.params, sort: 'mi_volume', order: 'desc', limit: 24, images_first: false }),
  });
  const products = distinctProducts(data?.items ?? [], 12);
  return (
    <section ref={ref} className="disc-rail">
      <div className="disc-rail-head">
        <h2 className="disc-rail-title">{rail.label}</h2>
        <Link to={railHref(rail.params)} className="disc-rail-all">See all &rarr;</Link>
      </div>
      <div className="disc-rail-track">
        {(!seen || isLoading) && Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="disc-card disc-card--skel" />
        ))}
        {seen && !isLoading && products.length === 0 && (
          <div className="disc-rail-empty">No products found.</div>
        )}
        {products.map((p, i) => {
          const price = money(p.frontline_case_price ?? p.effective_case_price ?? null);
          return (
            <Link
              key={`${p.product_name}-${i}`}
              to={`/products?q=${encodeURIComponent(p.product_name)}`}
              className="disc-card"
            >
              <ProductThumb src={p.image_url} alt={p.product_name} size={120} />
              <div className="disc-card-name">{p.abg_item_name?.trim() || p.product_name}</div>
              {price && <div className="disc-card-price">{price}/case</div>}
            </Link>
          );
        })}
      </div>
    </section>
  );
}

export default function Discover() {
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const { data } = useQuery({ queryKey: ['mi-top-categories'], queryFn: catalog.topCategories, staleTime: 3_600_000 });
  const rails: MiRail[] = [...(data?.spirits ?? []), ...(data?.wine ?? [])];

  return (
    <div className="disc-page">
      <header className="disc-hero">
        <h1 className="disc-title">Celr AI</h1>
        <p className="disc-sub">Find any product, at any distributor</p>
        <form
          className="disc-search"
          onSubmit={(e) => { e.preventDefault(); if (q.trim()) nav(`/products?q=${encodeURIComponent(q.trim())}`); }}
        >
          <Search size={18} className="disc-search-ic" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search products, brands, regions, varietals…"
            aria-label="Search products"
          />
          <button type="submit">Search</button>
        </form>
        <div className="disc-types">
          {TYPES.map((t) => (
            <Link key={t} to={`/products?product_type=${encodeURIComponent(t)}`} className="disc-type">{t}</Link>
          ))}
        </div>
        <p className="disc-hint">Top categories by market sales volume</p>
      </header>

      <div className="disc-rails">
        {rails.map((r) => <Rail key={r.label} rail={r} />)}
      </div>
    </div>
  );
}
