import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { todos, type Todo } from '../lib/api';
import { distributorName } from '../lib/distributors';
import { useProductQuickView } from '../components/ProductQuickView';
import { CheckCircle2, Trash2, RotateCcw, ListTodo } from 'lucide-react';
import './Todo.css';

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
      className={`todo-card ${isOverdue(t) ? 'overdue' : ''} ${dragId === t.id ? 'dragging' : ''}`}
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
      <div className="orders-header"><h2>To-Do</h2></div>
      <p className="text-muted" style={{ fontSize: 13, marginTop: -8, marginBottom: 14 }}>
        Right-click any product anywhere and choose <strong>Add to To-Do</strong>. Drag a card to a different
        week to reschedule it.
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
                <span className="todo-col-count">{items.length}</span>
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
          <ListTodo size={20} /> No to-dos yet. Right-click a product and pick &ldquo;Add to To-Do&rdquo;.
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
    </div>
  );
}
