import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { notes } from '../lib/api';
import type { AllNote } from '../lib/api';
import { useProductQuickView } from '../components/ProductQuickView';
import { distributorName } from '../lib/distributors';
import { Package, Star, ShoppingCart, ClipboardList } from 'lucide-react';

const SOURCE_META: Record<AllNote['source'], { label: string; icon: typeof Package; color: string }> = {
  product:    { label: 'Product',    icon: Package,       color: 'var(--accent)' },
  watchlist:  { label: 'Favorite',   icon: Star,          color: '#d97706' },
  order:      { label: 'Order',      icon: ShoppingCart,  color: 'var(--green)' },
  order_line: { label: 'Order line', icon: ClipboardList, color: '#7c3aed' },
};

const FILTERS: { value: '' | AllNote['source']; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'product', label: 'Products' },
  { value: 'watchlist', label: 'Favorites' },
  { value: 'order', label: 'Orders' },
  { value: 'order_line', label: 'Order lines' },
];

export default function NotesPage() {
  const navigate = useNavigate();
  const { open } = useProductQuickView();
  const [search, setSearch] = useState('');
  const [source, setSource] = useState<'' | AllNote['source']>('');

  const { data, isLoading } = useQuery({ queryKey: ['notes', 'all'], queryFn: notes.all });

  const all = data ?? [];
  const filtered = useMemo(() => {
    let r = all;
    if (source) r = r.filter(n => n.source === source);
    if (search) {
      const t = search.toLowerCase();
      r = r.filter(n => n.note.toLowerCase().includes(t) || n.title.toLowerCase().includes(t));
    }
    return r;
  }, [all, source, search]);

  const goTo = (n: AllNote) => {
    if ((n.source === 'order' || n.source === 'order_line') && n.order_id) {
      navigate(`/orders/${n.order_id}`);
    } else if (n.product_name && n.wholesaler) {
      open(n.product_name, n.wholesaler);
    }
  };

  return (
    <div className="page">
      <div className="tracker-header">
        <div>
          <h2 style={{ marginBottom: 2 }}>My Notes</h2>
          <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
            Every note you've left, in one place: products, favorites, orders, and order lines.
          </span>
        </div>
      </div>

      <div className="filter-bar">
        {FILTERS.map(f => (
          <button
            key={f.value || 'all'}
            type="button"
            className={`filter-pill ${source === f.value ? 'active' : ''}`}
            onClick={() => setSource(f.value)}
          >
            {f.label}
          </button>
        ))}
        <input
          type="text"
          placeholder="Search notes..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ padding: '8px 12px', background: 'var(--surface)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius)', color: 'var(--text)', fontSize: 13, width: 240, marginLeft: 'auto' }}
        />
      </div>

      {isLoading ? (
        <p className="text-muted">Loading...</p>
      ) : filtered.length === 0 ? (
        <div className="notes-empty">
          <p>No notes yet.</p>
          <p className="text-muted" style={{ fontSize: 13 }}>
            Add a note from any product (open it and use the Notes section), from a Favorite, or on an order or order line. They all show up here.
          </p>
        </div>
      ) : (
        <div className="notes-feed">
          {filtered.map(n => {
            const meta = SOURCE_META[n.source];
            const Icon = meta.icon;
            const linkable = (n.order_id != null) || (!!n.product_name && !!n.wholesaler);
            return (
              <div
                key={`${n.source}-${n.id}`}
                className={`note-card${linkable ? ' note-card-link' : ''}`}
                onClick={linkable ? () => goTo(n) : undefined}
                role={linkable ? 'button' : undefined}
                tabIndex={linkable ? 0 : undefined}
              >
                <span className="note-source" style={{ color: meta.color, background: `color-mix(in srgb, ${meta.color} 12%, transparent)` }}>
                  <Icon size={13} /> {meta.label}
                </span>
                <div className="note-body">
                  <div className="note-title">
                    {n.title}
                    {n.wholesaler && <span className="note-dist"> · {distributorName(n.wholesaler)}</span>}
                  </div>
                  <div className="note-text">{n.note}</div>
                </div>
                <span className="note-date">{new Date(n.created_at).toLocaleDateString()}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
