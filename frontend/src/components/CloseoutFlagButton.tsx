/**
 * CloseoutFlagButton — the closeout sibling of FavoriteButton, an "X" toggle
 * used ONLY on the Compare Prices page. A user marks a product as a closeout
 * candidate; an admin reviews the flags in the "User Closeout Flags" form and
 * decides what to do. Toggle is per (user, wholesaler, product, size).
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { XCircle } from 'lucide-react';
import { closeout } from '../lib/api';

interface Props {
  productName: string;
  wholesaler: string;
  upc?: string;
  unitVolume?: string;
  unitQty?: string;
}

export default function CloseoutFlagButton({ productName, wholesaler, upc, unitVolume, unitQty }: Props) {
  const qc = useQueryClient();
  const [popover, setPopover] = useState(false);
  const [note, setNote] = useState('');

  const { data: flags } = useQuery({ queryKey: ['closeout-mine'], queryFn: closeout.mine });
  const match = flags?.find(f =>
    f.product_name === productName && f.wholesaler === wholesaler
    && (f.unit_volume ?? '') === (unitVolume ?? '')
    && (f.unit_qty ?? '') === (unitQty ?? ''));

  const addMut = useMutation({
    mutationFn: () => closeout.add({ product_name: productName, wholesaler, upc, unit_volume: unitVolume, unit_qty: unitQty, note: note || undefined }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['closeout-mine'] }); setPopover(false); setNote(''); },
  });
  const removeMut = useMutation({
    mutationFn: () => closeout.remove(match!.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['closeout-mine'] }),
  });
  const loading = addMut.isPending || removeMut.isPending;

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (match) removeMut.mutate();
    else setPopover(true);
  };

  return (
    <span className="closeout-wrapper" style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
      <button
        className={`closeout-btn${match ? ' active' : ''}`}
        onClick={handleClick}
        disabled={loading}
        title={match ? 'Flagged as closeout. Click to unflag.' : 'Flag as closeout candidate'}
        aria-label={match ? 'Unflag closeout candidate' : 'Flag as closeout candidate'}
        aria-pressed={!!match}
      >
        <XCircle size={16} fill={match ? 'currentColor' : 'none'} />
      </button>

      {popover && (
        <div className="fav-popover" onClick={e => e.stopPropagation()}>
          <div className="fav-popover-title">Flag as closeout</div>
          <textarea
            placeholder="Why? (optional — e.g. 'discontinued', 'last 3 cases')"
            value={note}
            onChange={e => setNote(e.target.value)}
            rows={2}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addMut.mutate(); }
              if (e.key === 'Escape') setPopover(false);
            }}
          />
          <div className="fav-popover-actions">
            <button className="btn btn-secondary" onClick={() => setPopover(false)}>Cancel</button>
            <button className="btn" onClick={() => addMut.mutate()} disabled={loading}>Flag</button>
          </div>
        </div>
      )}
    </span>
  );
}
