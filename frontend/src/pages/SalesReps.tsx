import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { salesReps, divisions } from '../lib/api';
import type { SalesRep } from '../lib/api';
import SortableTable from '../components/SortableTable';
import { distributorName, DISTRIBUTOR_NAMES } from '../lib/distributors';
import { Trash2 } from 'lucide-react';

const DISTRIBUTORS = Object.keys(DISTRIBUTOR_NAMES);

export default function SalesRepsPage({ embedded = false }: { embedded?: boolean }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [distributor, setDistributor] = useState('');
  const [division, setDivision] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');

  const { data } = useQuery({ queryKey: ['sales-reps'], queryFn: salesReps.list });
  const { data: divs } = useQuery({ queryKey: ['divisions'], queryFn: divisions.list });

  const addMut = useMutation({
    mutationFn: (rep: Omit<SalesRep, 'id'>) => salesReps.add(rep),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sales-reps'] });
      setName(''); setDistributor(''); setDivision(''); setEmail(''); setPhone('');
    },
  });

  const removeMut = useMutation({
    mutationFn: (id: number) => salesReps.remove(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sales-reps'] }),
  });

  const handleAdd = () => {
    if (!name || !distributor) return;
    addMut.mutate({ name, distributor, division: division || undefined, email: email || undefined, phone: phone || undefined });
  };

  return (
    <div className={embedded ? '' : 'page'}>
      {!embedded && <div className="orders-header"><h2>Sales Representatives</h2></div>}
      <p className="page-sub" style={{ marginTop: embedded ? 0 : -8 }}>
        Each rep works for one distributor. You'll pick a rep when you create an order for that distributor.
      </p>

      <div className="inline-form">
        <input type="text" placeholder="Name *" value={name} onChange={e => setName(e.target.value)} />
        <select value={distributor} onChange={e => setDistributor(e.target.value)}>
          <option value="">Distributor *</option>
          {DISTRIBUTORS.map(d => <option key={d} value={d}>{distributorName(d)}</option>)}
        </select>
        <select value={division} onChange={e => setDivision(e.target.value)}>
          <option value="">Division (optional)</option>
          {(divs ?? []).map(d => <option key={d.id} value={d.name}>{d.name}</option>)}
        </select>
        <input type="email" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} />
        <input type="text" placeholder="Phone" value={phone} onChange={e => setPhone(e.target.value)} />
        <button className="btn" onClick={handleAdd} disabled={!name || !distributor}>
          Add
        </button>
      </div>

      <SortableTable
        columns={[
          { key: 'name', label: 'Name' },
          { key: 'distributor', label: 'Distributor',
            render: r => r.distributor ? distributorName(r.distributor as string) : '—' },
          { key: 'division', label: 'Division', render: r => (r.division as string) || '—' },
          { key: 'email', label: 'Email' },
          { key: 'phone', label: 'Phone' },
          {
            key: 'actions',
            label: 'Actions',
            render: r => (
              <button
                className="btn-icon"
                onClick={e => { e.stopPropagation(); removeMut.mutate(r.id as number); }}
              >
                <Trash2 size={16} />
              </button>
            ),
          },
        ]}
        data={data ?? []}
        exportName="sales-reps"
      />
    </div>
  );
}
