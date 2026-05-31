import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ListPlus, Check } from 'lucide-react';
import { lists } from '../lib/api';
import { useDialog } from './Dialog';

interface Props {
  productName: string;
  wholesaler: string;
  upc?: string;
  unitVolume?: string;
  comboCode?: string;
}

/**
 * "Add to list" — lets the user drop a product onto one of their saved lists
 * (or create a new one), as the alternative to adding it to the cart/order.
 * The menu is fixed-positioned off the button's rect so it never gets clipped
 * inside a scrolling table.
 */
export default function AddToListButton({ productName, wholesaler, upc, unitVolume, comboCode }: Props) {
  const qc = useQueryClient();
  const { promptText } = useDialog();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [flash, setFlash] = useState(false);
  const [busy, setBusy] = useState(false);
  const { data: allLists } = useQuery({ queryKey: ['lists'], queryFn: lists.list, enabled: open });

  const toggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setPos({ left: r.left, top: r.bottom + 4 });
    setOpen(o => !o);
  };

  const addTo = async (listId: number) => {
    if (busy) return;
    setBusy(true);
    try {
      await lists.addItem(listId, {
        product_name: productName, wholesaler, upc,
        unit_volume: unitVolume, combo_code: comboCode,
      });
      qc.invalidateQueries({ queryKey: ['lists'] });
      setOpen(false);
      setFlash(true);
      setTimeout(() => setFlash(false), 1300);
    } finally {
      setBusy(false);
    }
  };

  const newList = async () => {
    const name = await promptText({ title: 'New list', placeholder: 'List name', confirmText: 'Create' });
    if (!name || !name.trim()) return;
    const l = await lists.create(name.trim());
    await addTo(l.id);
  };

  return (
    <>
      <button
        type="button"
        className={`btn btn-sm add-to-list-btn${flash ? ' is-added' : ''}`}
        title="Add to a list"
        onClick={toggle}
        disabled={busy}
      >
        {flash ? <><Check size={13} /> Added</> : <><ListPlus size={13} /> Add to list</>}
      </button>
      {open && pos && (
        <>
          <div className="add-to-list-backdrop" onClick={e => { e.stopPropagation(); setOpen(false); }} />
          <div className="add-to-list-menu" style={{ left: pos.left, top: pos.top }} onClick={e => e.stopPropagation()}>
            {(allLists ?? []).map(l => (
              <button key={l.id} type="button" className="add-to-list-item" onClick={() => addTo(l.id)}>
                {l.name}
              </button>
            ))}
            {(allLists ?? []).length === 0 && <div className="add-to-list-empty">No lists yet</div>}
            <button type="button" className="add-to-list-item add-to-list-new" onClick={newList}>+ New list…</button>
          </div>
        </>
      )}
    </>
  );
}
