import { useQuery } from '@tanstack/react-query';
import { Star } from 'lucide-react';
import { watchlist } from '../lib/api';

interface Props {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
}

export default function TrackedOnlyToggle({ enabled, onChange }: Props) {
  const { data } = useQuery({ queryKey: ['watchlist'], queryFn: watchlist.get });
  const count = data?.length ?? 0;

  return (
    <label className="tracked-toggle">
      <input type="checkbox" checked={enabled} onChange={e => onChange(e.target.checked)} />
      <Star size={13} />
      <span>In Favorites ({count})</span>
    </label>
  );
}
