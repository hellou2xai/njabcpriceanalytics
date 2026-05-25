import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { notes, todos } from '../lib/api';
import type { AllNote, UserNote } from '../lib/api';
import { useProductQuickView } from '../components/ProductQuickView';
import { distributorName } from '../lib/distributors';
import { Package, Star, ShoppingCart, ClipboardList, Plus, Pencil, Trash2, ListTodo, X, Check } from 'lucide-react';

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

// Sticky colours are deliberately the same in light and dark mode (a yellow
// sticky reads as yellow either way) with a fixed dark text colour for contrast.
const STICKY_COLORS = [
  { name: 'yellow', bg: '#fef9c3', border: '#fde047' },
  { name: 'blue',   bg: '#dbeafe', border: '#93c5fd' },
  { name: 'green',  bg: '#dcfce7', border: '#86efac' },
  { name: 'pink',   bg: '#fce7f3', border: '#f9a8d4' },
  { name: 'purple', bg: '#ede9fe', border: '#c4b5fd' },
  { name: 'orange', bg: '#ffedd5', border: '#fdba74' },
];
const STICKY_TEXT = '#1f2937';
function colorOf(name?: string | null) {
  return STICKY_COLORS.find(c => c.name === name) ?? STICKY_COLORS[0];
}

export default function NotesPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { open } = useProductQuickView();
  const [search, setSearch] = useState('');
  const [source, setSource] = useState<'' | AllNote['source']>('');

  // Composer
  const [newTitle, setNewTitle] = useState('');
  const [newText, setNewText] = useState('');
  const [newColor, setNewColor] = useState(STICKY_COLORS[0].name);

  // Inline edit
  const [editId, setEditId] = useState<number | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editText, setEditText] = useState('');

  // Add-to-To-Do
  const [todoFor, setTodoFor] = useState<UserNote | null>(null);

  const { data: sticky, isLoading: stickyLoading } = useQuery({ queryKey: ['notes', 'standalone'], queryFn: notes.standalone });
  const { data, isLoading } = useQuery({ queryKey: ['notes', 'all'], queryFn: notes.all });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['notes'] });
  const addMut = useMutation({
    mutationFn: () => notes.add({ note: newText.trim(), title: newTitle.trim() || undefined, color: newColor }),
    onSuccess: () => { invalidate(); setNewTitle(''); setNewText(''); },
  });
  const updateMut = useMutation({
    mutationFn: ({ id, body }: { id: number; body: { note?: string; title?: string; color?: string } }) => notes.update(id, body),
    onSuccess: () => { invalidate(); setEditId(null); },
  });
  const removeMut = useMutation({
    mutationFn: (id: number) => notes.remove(id),
    onSuccess: invalidate,
  });

  const startEdit = (n: UserNote) => { setEditId(n.id); setEditTitle(n.title ?? ''); setEditText(n.note); };

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

  const stickyNotes = sticky ?? [];

  return (
    <div className="page">
      <div className="tracker-header">
        <div>
          <h2 style={{ marginBottom: 2 }}>My Notes</h2>
          <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
            Jot down sticky notes, and see every note you've left on products, favorites and orders in one place.
          </span>
        </div>
      </div>

      {/* ---- Composer ---- */}
      <div className="sticky-composer">
        <input
          className="sticky-composer-title"
          placeholder="Title (optional)"
          value={newTitle}
          onChange={e => setNewTitle(e.target.value)}
        />
        <textarea
          className="sticky-composer-text"
          placeholder="Write a note... (e.g. Ask Allied rep about Q3 Macallan allocation)"
          rows={2}
          value={newText}
          onChange={e => setNewText(e.target.value)}
        />
        <div className="sticky-composer-foot">
          <div className="sticky-swatches">
            {STICKY_COLORS.map(c => (
              <button
                key={c.name}
                type="button"
                title={c.name}
                className={`sticky-swatch${newColor === c.name ? ' active' : ''}`}
                style={{ background: c.bg, borderColor: c.border }}
                onClick={() => setNewColor(c.name)}
              />
            ))}
          </div>
          <button className="btn btn-sm" disabled={!newText.trim() || addMut.isPending} onClick={() => addMut.mutate()}>
            <Plus size={14} /> {addMut.isPending ? 'Adding...' : 'Add note'}
          </button>
        </div>
      </div>

      {/* ---- Sticky notes ---- */}
      {stickyLoading ? (
        <p className="text-muted">Loading...</p>
      ) : stickyNotes.length > 0 ? (
        <div className="sticky-grid">
          {stickyNotes.map(n => {
            const c = colorOf(n.color);
            const editing = editId === n.id;
            return (
              <div key={n.id} className="sticky-note" style={{ background: c.bg, borderColor: c.border, color: STICKY_TEXT }}>
                {editing ? (
                  <>
                    <input className="sticky-edit-title" value={editTitle} onChange={e => setEditTitle(e.target.value)} placeholder="Title (optional)" />
                    <textarea className="sticky-edit-text" rows={4} value={editText} onChange={e => setEditText(e.target.value)} />
                    <div className="sticky-swatches" style={{ margin: '4px 0' }}>
                      {STICKY_COLORS.map(sc => (
                        <button key={sc.name} type="button" title={sc.name}
                          className={`sticky-swatch${(n.color ?? STICKY_COLORS[0].name) === sc.name ? ' active' : ''}`}
                          style={{ background: sc.bg, borderColor: sc.border }}
                          onClick={() => updateMut.mutate({ id: n.id, body: { color: sc.name } })} />
                      ))}
                    </div>
                    <div className="sticky-actions">
                      <button className="sticky-icon" title="Save" disabled={!editText.trim()}
                        onClick={() => updateMut.mutate({ id: n.id, body: { title: editTitle.trim(), note: editText.trim() } })}>
                        <Check size={15} />
                      </button>
                      <button className="sticky-icon" title="Cancel" onClick={() => setEditId(null)}><X size={15} /></button>
                    </div>
                  </>
                ) : (
                  <>
                    {n.title && <div className="sticky-title">{n.title}</div>}
                    <div className="sticky-text">{n.note}</div>
                    <div className="sticky-foot">
                      <span className="sticky-date">{new Date(n.created_at).toLocaleDateString()}</span>
                      <div className="sticky-actions">
                        <button className="sticky-icon" title="Add to To-Do" onClick={() => setTodoFor(n)}><ListTodo size={15} /></button>
                        <button className="sticky-icon" title="Edit" onClick={() => startEdit(n)}><Pencil size={14} /></button>
                        <button className="sticky-icon" title="Delete" onClick={() => removeMut.mutate(n.id)}><Trash2 size={14} /></button>
                      </div>
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <p className="text-muted" style={{ fontSize: 13 }}>No sticky notes yet. Write one above.</p>
      )}

      {/* ---- Consolidated feed ---- */}
      <h3 style={{ margin: '24px 0 8px', fontSize: 15 }}>From products, favorites &amp; orders</h3>
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
          <p className="text-muted" style={{ fontSize: 13 }}>
            No notes here yet. Add a note from any product, a Favorite, or an order and it shows up in this list.
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

      {todoFor && <NoteToTodoDialog note={todoFor} onClose={() => setTodoFor(null)} />}
    </div>
  );
}

// ---- Add a sticky note to the To-Do list ----
function NoteToTodoDialog({ note, onClose }: { note: UserNote; onClose: () => void }) {
  const qc = useQueryClient();
  const [title, setTitle] = useState(note.title || note.note.slice(0, 60));
  const [detail, setDetail] = useState(note.title ? note.note : '');
  const [due, setDue] = useState('');
  const save = useMutation({
    mutationFn: () => todos.create({
      title: title.trim(), note: detail.trim() || undefined, due_date: due || undefined, source_page: 'Notes',
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['todos'] }); onClose(); },
  });
  const field: React.CSSProperties = {
    width: '100%', padding: '9px 12px', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
    background: 'var(--bg)', color: 'var(--text)', fontSize: 14, fontFamily: 'var(--font-sans)',
  };
  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal" style={{ maxWidth: 460 }} onMouseDown={e => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="Close"><X size={18} /></button>
        <h3 style={{ marginTop: 0 }}>Add to To-Do</h3>
        <p className="text-muted" style={{ marginTop: -4, fontSize: 13 }}>From a sticky note</p>
        <label style={{ display: 'block', marginTop: 12 }}>
          <span style={{ fontSize: 12.5, fontWeight: 600, display: 'block', marginBottom: 4 }}>What do you want to do?</span>
          <input style={field} autoFocus value={title} onChange={e => setTitle(e.target.value)} />
        </label>
        <label style={{ display: 'block', marginTop: 10 }}>
          <span style={{ fontSize: 12.5, fontWeight: 600, display: 'block', marginBottom: 4 }}>Note</span>
          <textarea style={{ ...field, resize: 'vertical' }} rows={3} value={detail} onChange={e => setDetail(e.target.value)} />
        </label>
        <label style={{ display: 'block', marginTop: 10 }}>
          <span style={{ fontSize: 12.5, fontWeight: 600, display: 'block', marginBottom: 4 }}>Do it by</span>
          <input style={field} type="date" value={due} onChange={e => setDue(e.target.value)} />
        </label>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button className="btn btn-secondary btn-sm" onClick={onClose}>Cancel</button>
          <button className="btn btn-sm" disabled={!title.trim() || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? 'Adding...' : 'Add to To-Do'}
          </button>
        </div>
      </div>
    </div>
  );
}
