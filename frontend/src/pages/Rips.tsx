import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { deals } from '../lib/api';
import SortableTable from '../components/SortableTable';
import RowLimitSelect from '../components/RowLimitSelect';
import FilterSidebar, { type FilterSection } from '../components/FilterSidebar';
import { ErrorState, EmptyState } from '../components/DataState';
import DataLoading from '../components/DataLoading';
import { distributorName, ALL_DISTRIBUTORS } from '../lib/distributors';

export default function Rips() {
  const [wholesaler, setWholesaler] = useState('');
  const [q, setQ] = useState('');
  const [minAmount, setMinAmount] = useState('');
  const [limit, setLimit] = useState(100);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['rips', wholesaler, q, limit],
    queryFn: () => deals.rips({ wholesaler: wholesaler || undefined, q: q || undefined, limit }),
  });

  const items = useMemo(() => {
    let result = data ?? [];
    if (minAmount) {
      const min = parseFloat(minAmount);
      result = result.filter(i => i.rip_amt_1 >= min);
    }
    return result;
  }, [data, minAmount]);

  const sections: FilterSection[] = [
    {
      type: 'text', key: 'q', title: 'Search',
      placeholder: 'Description or RIP code',
      value: q, onChange: setQ,
    },
    {
      type: 'pills', key: 'wholesaler', title: 'Distributor',
      options: ALL_DISTRIBUTORS,
      value: wholesaler, onChange: setWholesaler,
    },
    {
      type: 'pills', key: 'min_amount', title: 'Min RIP Amount',
      options: [
        { value: '', label: 'Any' },
        { value: '5', label: '$5+' },
        { value: '10', label: '$10+' },
        { value: '25', label: '$25+' },
        { value: '50', label: '$50+' },
        { value: '100', label: '$100+' },
      ],
      value: minAmount, onChange: setMinAmount,
    },
  ];

  const resetFilters = () => { setQ(''); setWholesaler(''); setMinAmount(''); };

  return (
    <FilterSidebar storageKey="rips" sections={sections} onReset={resetFilters}>
      <div className="page">
        <h2>Active RIP Promotions</h2>

        <div className="rip-filter-bar">
          <RowLimitSelect value={limit} onChange={setLimit} />
          <span className="search-count">{items.length} promotions</span>
        </div>

        {isError ? (
          <ErrorState retry={() => refetch()} />
        ) : isLoading ? (
          <DataLoading label="Loading RIP promotions..." />
        ) : items.length === 0 ? (
          <EmptyState title="No promotions match these filters">Try broadening or clearing your filters.</EmptyState>
        ) : (
        <SortableTable
          columns={[
            { key: 'rip_description', label: 'Description' },
            { key: 'wholesaler', label: 'Distributor', render: (r) => distributorName(r.wholesaler as string) },
            { key: 'rip_code', label: 'RIP Code' },
            { key: 'rip_unit_1', label: 'Unit' },
            { key: 'rip_qty_1', label: 'Qty', align: 'right' },
            { key: 'rip_amt_1', label: 'Amount', align: 'right', sortable: true,
              render: r => <span className="text-green">${r.rip_amt_1}</span> },
          ]}
          data={items}
          exportName="rips"
        />
        )}
      </div>
    </FilterSidebar>
  );
}
