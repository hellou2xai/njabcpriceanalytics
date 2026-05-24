import { useQuery } from '@tanstack/react-query';
import { catalog } from '../lib/api';
import { useDistributor } from '../contexts/DistributorContext';
import { DISTRIBUTOR_NAMES } from '../lib/distributors';

interface Props {
  value?: string;
  onChange?: (v: string) => void;
}

export default function WholesalerFilter({ value, onChange }: Props) {
  const ctx = useDistributor();
  const currentValue = value ?? ctx.distributor;
  const handleChange = onChange ?? ctx.setDistributor;
  const { data: editions } = useQuery({
    queryKey: ['editions'],
    queryFn: catalog.editions,
  });

  const wholesalers = [...new Set(editions?.map(e => e.wholesaler) ?? [])];

  return (
    <div className="filter-pills">
      <button
        className={`pill ${currentValue === '' ? 'active' : ''}`}
        onClick={() => handleChange('')}
      >
        All Distributors
      </button>
      {wholesalers.map(w => (
        <button
          key={w}
          className={`pill ${currentValue === w ? 'active' : ''}`}
          onClick={() => handleChange(w)}
        >
          {DISTRIBUTOR_NAMES[w] ?? w}
        </button>
      ))}
    </div>
  );
}
