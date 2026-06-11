import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Star } from 'lucide-react';
import { watchlist } from '../lib/api';

interface Props {
  productName: string;
  wholesaler: string;
  upc?: string;
  unitVolume?: string;
  showNote?: boolean;
}

export default function FavoriteButton({ productName, wholesaler, upc, unitVolume, showNote }: Props) {
  const qc = useQueryClient();
  const [popover, setPopover] = useState(false);
  const [note, setNote] = useState('');

  const { data: items } = useQuery({ queryKey: ['watchlist'], queryFn: watchlist.get });
  const match = items?.find(i => i.product_name === productName && i.wholesaler === wholesaler);

  const addMut = useMutation({
    mutationFn: () => watchlist.add({ product_name: productName, wholesaler, upc, unit_volume: unitVolume, notes: note || undefined }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['watchlist'] }); setPopover(false); setNote(''); },
  });

  const removeMut = useMutation({
    mutationFn: () => watchlist.remove(match!.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['watchlist'] }),
  });

  const loading = addMut.isPending || removeMut.isPending;

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (match) {
      removeMut.mutate();
    } else {
      setPopover(true);
    }
  };

  return (
    <span className="fav-wrapper" style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <button
        className={`fav-btn ${match ? 'active' : ''}`}
        onClick={handleClick}
        disabled={loading}
        title={match ? 'Remove from watchlist' : 'Add to watchlist'}
        aria-label={match ? 'Remove from watchlist' : 'Add to watchlist'}
        aria-pressed={!!match}
      >
        <Star size={16} fill={match ? 'currentColor' : 'none'} />
      </button>

      {showNote && match?.notes && (
        <span className="fav-note" title={match.notes}>{match.notes}</span>
      )}

      {popover && (
        <div className="fav-popover" onClick={e => e.stopPropagation()}>
          <div className="fav-popover-title">Add to Watchlist</div>
          <textarea
            placeholder="Why are you adding this? (optional)"
            value={note}
            onChange={e => setNote(e.target.value)}
            rows={2}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addMut.mutate(); } if (e.key === 'Escape') setPopover(false); }}
          />
          <div className="fav-popover-actions">
            <button className="btn btn-secondary" onClick={() => setPopover(false)}>Cancel</button>
            <button className="btn" onClick={() => addMut.mutate()} disabled={loading}>Add</button>
          </div>
        </div>
      )}
    </span>
  );
}
