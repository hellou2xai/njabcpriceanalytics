import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { salesReps, divisions } from '../lib/api';
import type { SalesRep } from '../lib/api';
import SortableTable from '../components/SortableTable';
import { distributorName, DISTRIBUTOR_NAMES } from '../lib/distributors';
import { useDraftState, clearDrafts } from '../hooks/useDraftState';
import { Trash2, Pencil, X } from 'lucide-react';

const DISTRIBUTORS = Object.keys(DISTRIBUTOR_NAMES);

export default function SalesRepsPage({ embedded = false }: { embedded?: boolean }) {
  const qc = useQueryClient();
  // Draft-persisted so an in-progress rep survives a Back-button navigation.
  const [editingId, setEditingId] = useDraftState<number | null>('reps:editingId', null);
  const [name, setName] = useDraftState('reps:name', '');
  const [distributor, setDistributor] = useDraftState('reps:distributor', '');
  const [division, setDivision] = useDraftState('reps:division', '');
  const [email, setEmail] = useDraftState('reps:email', '');
  const [phone, setPhone] = useDraftState('reps:phone', '');

  const { data } = useQuery({ queryKey: ['sales-reps'], queryFn: salesReps.list });
  const { data: divs } = useQuery({ queryKey: ['divisions'], queryFn: divisions.list });

  // Only show divisions that belong to the chosen distributor (plus any general,
  // distributor-less ones), since a division is specific to a distributor.
  const repDivs = (divs ?? []).filter(d => !d.distributor || d.distributor === distributor);

  const reset = () => {
    setEditingId(null); setName(''); setDistributor(''); setDivision(''); setEmail(''); setPhone('');
    clearDrafts('reps:');
  };

  const saveMut = useMutation({
    mutationFn: (rep: Omit<SalesRep, 'id'>) =>
      editingId ? salesReps.update(editingId, rep) : salesReps.add(rep),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['sales-reps'] }); reset(); },
  });
  const removeMut = useMutation({
    mutationFn: (id: number) => salesReps.remove(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sales-reps'] }),
  });

  const handleSave = () => {
    if (!name || !distributor) return;
    saveMut.mutate({ name, distributor, division: division || undefined, email: email || undefined, phone: phone || undefined });
  };
  const startEdit = (r: SalesRep) => {
    setEditingId(r.id);
    setName(r.name ?? '');
    setDistributor(r.distributor ?? '');
    setDivision(r.division ?? '');
    setEmail(r.email ?? '');
    setPhone(r.phone ?? '');
  };

  return (
    <div className={embedded ? '' : 'page'}>
      {!embedded && <div className="orders-header"><h2>Sales Representatives</h2></div>}
      <p className="page-sub" style={{ marginTop: embedded ? 0 : -8 }}>
        Each rep works for one distributor. Pick the distributor first; the Division list then shows that
        distributor's divisions. You'll pick a rep when you create an order for that distributor.
      </p>

      <div className="inline-form">
        <input type="text" placeholder="Name *" value={name} onChange={e => setName(e.target.value)} />
        <select value={distributor} onChange={e => { setDistributor(e.target.value); setDivision(''); }}>
          <option value="">Distributor *</option>
          {DISTRIBUTORS.map(d => <option key={d} value={d}>{distributorName(d)}</option>)}
        </select>
        <select value={division} onChange={e => setDivision(e.target.value)} disabled={!distributor} title={!distributor ? 'Pick a distributor first' : undefined}>
          <option value="">Division (optional)</option>
          {repDivs.map(d => <option key={d.id} value={d.name}>{d.name}</option>)}
        </select>
        <input type="email" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} />
        <input type="text" placeholder="Phone" value={phone} onChange={e => setPhone(e.target.value)} />
        <button className="btn" onClick={handleSave} disabled={!name || !distributor || saveMut.isPending}>
          {editingId ? 'Save changes' : 'Add'}
        </button>
        {editingId && (
          <button className="btn btn-secondary" onClick={reset} title="Cancel edit"><X size={14} /> Cancel</button>
        )}
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
              <span style={{ display: 'inline-flex', gap: 4 }}>
                <button className="btn-icon" title="Edit" onClick={e => { e.stopPropagation(); startEdit(r as unknown as SalesRep); }}>
                  <Pencil size={15} />
                </button>
                <button className="btn-icon" title="Delete" onClick={e => { e.stopPropagation(); removeMut.mutate(r.id as number); }}>
                  <Trash2 size={16} />
                </button>
              </span>
            ),
          },
        ]}
        data={data ?? []}
        exportName="sales-reps"
      />
    </div>
  );
}
