import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { todos, type Todo } from '../lib/api';
import { distributorName } from '../lib/distributors';
import { useProductQuickView } from '../components/ProductQuickView';
import { CheckCircle2, Trash2, RotateCcw, ListTodo, Plus, X } from 'lucide-react';
import './Todo.css';

// Pastel sticky-note colours, chosen by id so a note keeps its colour when moved.
const NOTE_COLORS = ['#fef9c3', '#dcfce7', '#dbeafe', '#fce7f3', '#ffedd5', '#e9d5ff'];

// ---- date helpers (local, no timezone surprises) ----
function todayMid(): Date { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }
function addDays(d: Date, n: number): Date { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function parseYmd(s: string): Date { const [y, m, dd] = s.split('-').map(Number); return new Date(y, (m || 1) - 1, dd || 1); }
const MD: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };

const TODAY = todayMid();
const STARTS = [0, 1, 2, 3].map(n => addDays(TODAY, n * 7));   // each week's first day
const COL_TITLES = ['This week', 'Next week', 'In 2 weeks', '3+ weeks / Later'];

function colRange(n: number): string {
  if (n === 3) return `On/after ${STARTS[3].toLocaleDateString(undefined, MD)}, plus undated`;
  return `${STARTS[n].toLocaleDateString(undefined, MD)} – ${addDays(STARTS[n + 1], -1).toLocaleDateString(undefined, MD)}`;
}
function bucketOf(t: Todo): number {
  if (!t.due_date) return 3;
  const d = parseYmd(t.due_date);
  if (d < STARTS[1]) return 0;   // this week, including overdue
  if (d < STARTS[2]) return 1;
  if (d < STARTS[3]) return 2;
  return 3;
}
function isOverdue(t: Todo): boolean { return !!t.due_date && parseYmd(t.due_date) < TODAY; }
function dueLabel(t: Todo): string {
  if (!t.due_date) return 'No date';
  const d = parseYmd(t.due_date);
  const txt = d.toLocaleDateString(undefined, MD);
  return isOverdue(t) ? `Overdue · was ${txt}` : `Due ${txt}`;
}

export default function TodoPage() {
  const qc = useQueryClient();
  const { open } = useProductQuickView();
  const { data } = useQuery({ queryKey: ['todos'], queryFn: todos.list });
  const all = data ?? [];
  const openItems = all.filter(t => t.status === 'open');
  const doneItems = all.filter(t => t.status === 'done');

  const update = useMutation({
    mutationFn: ({ id, d }: { id: number; d: Parameters<typeof todos.update>[1] }) => todos.update(id, d),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['todos'] }),
  });
  const remove = useMutation({
    mutationFn: (id: number) => todos.remove(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['todos'] }),
  });

  const [dragId, setDragId] = useState<number | null>(null);
  const [overCol, setOverCol] = useState<number | null>(null);
  const [adding, setAdding] = useState<{ due?: string } | null>(null);

  const drop = (n: number) => {
    if (dragId != null) update.mutate({ id: dragId, d: { due_date: ymd(STARTS[n]) } });
    setDragId(null);
    setOverCol(null);
  };

  const openProduct = (t: Todo) => {
    if (t.product_name && t.wholesaler) {
      open(t.product_name, t.wholesaler, undefined, { upc: t.upc ?? undefined, unitVolume: t.unit_volume ?? undefined });
    }
  };

  const card = (t: Todo) => (
    <div
      key={t.id}
      className={`todo-card sticky ${isOverdue(t) ? 'overdue' : ''} ${dragId === t.id ? 'dragging' : ''}`}
      style={{ background: NOTE_COLORS[t.id % NOTE_COLORS.length] }}
      draggable
      onDragStart={e => { setDragId(t.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(t.id)); }}
      onDragEnd={() => { setDragId(null); setOverCol(null); }}
    >
      <div className="todo-card-top">
        <button className="todo-icon-btn done" title="Mark done"
          onClick={() => update.mutate({ id: t.id, d: { status: 'done' } })}>
          <CheckCircle2 size={16} />
        </button>
        <span className="todo-title">{t.title}</span>
        <button className="todo-icon-btn danger" title="Delete" onClick={() => remove.mutate(t.id)}>
          <Trash2 size={14} />
        </button>
      </div>
      {t.note && <div className="todo-note">{t.note}</div>}
      <div className="todo-meta">
        <span className={`todo-due ${isOverdue(t) ? 'overdue' : ''}`}>{dueLabel(t)}</span>
      </div>
      {t.product_name && (
        <button className="todo-source" onClick={() => openProduct(t)} title="Open the product">
          <div className="src-name">{t.product_name}</div>
          <div className="src-meta">
            {t.wholesaler && distributorName(t.wholesaler)}
            {t.source_page ? ` · from ${t.source_page}` : ''}
          </div>
        </button>
      )}
    </div>
  );

  return (
    <div className="page">
      <div className="orders-header">
        <h2>To-Do</h2>
        <button className="btn btn-sm" onClick={() => setAdding({})}><Plus size={14} /> New To-Do</button>
      </div>
      <p className="text-muted" style={{ fontSize: 13, marginTop: -8, marginBottom: 14 }}>
        Add one here, or right-click any product anywhere and choose <strong>Add to To-Do</strong>. Drag a card
        to a different week to reschedule it.
      </p>

      <div className="todo-board">
        {COL_TITLES.map((title, n) => {
          const items = openItems.filter(t => bucketOf(t) === n);
          return (
            <div
              key={n}
              className={`todo-col ${overCol === n ? 'over' : ''}`}
              onDragOver={e => { e.preventDefault(); if (overCol !== n) setOverCol(n); }}
              onDragLeave={() => setOverCol(o => (o === n ? null : o))}
              onDrop={() => drop(n)}
            >
              <div className="todo-col-head">
                <span className="todo-col-title">{title}</span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <button className="todo-icon-btn" title={`Add a to-do in ${title}`}
                    onClick={() => setAdding({ due: ymd(STARTS[n]) })}><Plus size={15} /></button>
                  <span className="todo-col-count">{items.length}</span>
                </span>
              </div>
              <div className="todo-col-sub">{colRange(n)}</div>
              {items.map(card)}
              {items.length === 0 && <div className="todo-col-empty">Drop items here</div>}
            </div>
          );
        })}
      </div>

      {openItems.length === 0 && (
        <div className="alert-empty" style={{ marginTop: 16 }}>
          <ListTodo size={20} /> No to-dos yet. Use <strong>New To-Do</strong> above, or right-click any product and pick &ldquo;Add to To-Do&rdquo;.
        </div>
      )}

      {doneItems.length > 0 && (
        <>
          <div className="section-label" style={{ marginTop: 26 }}>Done ({doneItems.length})</div>
          <div className="todo-done-list">
            {doneItems.map(t => (
              <div key={t.id} className="todo-done-row">
                <span className="t">{t.title}</span>
                {t.product_name && <span className="text-muted" style={{ fontSize: 12 }}>{t.product_name}</span>}
                <button className="todo-icon-btn" title="Reopen" onClick={() => update.mutate({ id: t.id, d: { status: 'open' } })}>
                  <RotateCcw size={14} />
                </button>
                <button className="todo-icon-btn danger" title="Delete" onClick={() => remove.mutate(t.id)}>
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      {adding && <NewTodoDialog preset={adding} onClose={() => setAdding(null)} />}
    </div>
  );
}

function NewTodoDialog({ preset, onClose }: { preset: { due?: string }; onClose: () => void }) {
  const qc = useQueryClient();
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [due, setDue] = useState(preset.due ?? '');
  const save = useMutation({
    mutationFn: () => todos.create({ title: title.trim(), note: note.trim() || undefined, due_date: due || undefined, source_page: 'To-Do' }),
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
        <h3 style={{ marginTop: 0 }}>New To-Do</h3>
        <label style={{ display: 'block', marginTop: 12 }}>
          <span style={{ fontSize: 12.5, fontWeight: 600, display: 'block', marginBottom: 4 }}>What do you want to do?</span>
          <input style={field} autoFocus value={title} onChange={e => setTitle(e.target.value)}
            placeholder="e.g. Call Allied rep about the Tito's deal" />
        </label>
        <label style={{ display: 'block', marginTop: 10 }}>
          <span style={{ fontSize: 12.5, fontWeight: 600, display: 'block', marginBottom: 4 }}>Note</span>
          <textarea style={{ ...field, resize: 'vertical' }} rows={3} value={note} onChange={e => setNote(e.target.value)}
            placeholder="Any details to help you decide later" />
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
