import { useQuery } from '@tanstack/react-query';
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
      <span>Tracked only ({count})</span>
    </label>
  );
}
