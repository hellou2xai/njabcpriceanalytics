import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { catalog } from '../lib/api';
import { distributorName } from '../lib/distributors';
import './ProductSearchBox.css';

export interface ProductPick {
  product_name: string;
  upc?: string;
  wholesaler?: string;
  unit_volume?: string;
  unit_qty?: string;
}

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSelect: (p: ProductPick) => void;
  onSubmit?: () => void;
  placeholder?: string;
  autoFocus?: boolean;
}

/**
 * Smart/semantic product search box (typeahead). Suggestions come from
 * /api/catalog/search — the shared smart search (aliases + spell-fix + UPC
 * resolve) — so "absolut vodka", "tito's", a misspelling or a barcode all
 * land on the right product. Per CLAUDE.md, every product search box in the
 * app should use this rather than a raw substring <input>.
 */
export default function ProductSearchBox({ value, onChange, onSelect, onSubmit, placeholder, autoFocus }: Props) {
  const [open, setOpen] = useState(false);
  const [debounced, setDebounced] = useState(value);
  const [hi, setHi] = useState(-1);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => { const t = setTimeout(() => setDebounced(value), 180); return () => clearTimeout(t); }, [value]);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const { data } = useQuery({
    queryKey: ['product-suggest', debounced],
    queryFn: () => catalog.search({ q: debounced, limit: 12 }),
    enabled: debounced.trim().length >= 2,
    staleTime: 60_000,
  });

  // collapse the per-distributor rows to one suggestion per product+size, and
  // count how many distributors carry it.
  const items = (() => {
    const m = new Map<string, { p: ProductPick; n: number; type?: string }>();
    for (const r of (data?.items ?? [])) {
      const key = `${(r.product_name || '').toLowerCase()}|${r.unit_volume ?? ''}`;
      const cur = m.get(key);
      if (cur) { cur.n += 1; }
      else m.set(key, { p: { product_name: r.product_name, upc: r.upc, wholesaler: r.wholesaler, unit_volume: r.unit_volume, unit_qty: r.unit_qty }, n: 1, type: r.product_type });
    }
    return [...m.values()].slice(0, 10);
  })();

  const choose = (it: { p: ProductPick }) => { onChange(it.p.product_name); onSelect(it.p); setOpen(false); setHi(-1); };

  return (
    <div className="psb" ref={ref}>
      <Search size={15} className="psb-icon" />
      <input
        className="psb-input"
        value={value}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onChange={e => { onChange(e.target.value); setOpen(true); setHi(-1); }}
        onFocus={() => setOpen(true)}
        onKeyDown={e => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setHi(h => Math.min(h + 1, items.length - 1)); setOpen(true); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setHi(h => Math.max(h - 1, -1)); }
          else if (e.key === 'Enter') {
            if (hi >= 0 && items[hi]) { e.preventDefault(); choose(items[hi]); }
            else { setOpen(false); onSubmit?.(); }
          } else if (e.key === 'Escape') setOpen(false);
        }}
      />
      {open && items.length > 0 && (
        <ul className="psb-list">
          {items.map((it, i) => (
            <li key={i} className={`psb-item${i === hi ? ' psb-hi' : ''}`}
                onMouseEnter={() => setHi(i)} onMouseDown={e => { e.preventDefault(); choose(it); }}>
              <span className="psb-name">{it.p.product_name}</span>
              <span className="psb-meta">
                {it.p.unit_qty}×{it.p.unit_volume}{it.type ? ` · ${it.type}` : ''}
                {it.n > 1 ? ` · ${it.n} distributors` : ` · ${distributorName(it.p.wholesaler ?? '')}`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
