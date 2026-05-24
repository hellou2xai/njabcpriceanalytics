import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { divisions } from '../lib/api';
import SalesRepsPage from './SalesReps';
import StoresPage from './Stores';

type Tab = 'reps' | 'divisions' | 'stores';

function DivisionsManager() {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const { data } = useQuery({ queryKey: ['divisions'], queryFn: divisions.list });

  const addMut = useMutation({
    mutationFn: () => divisions.add(name.trim()),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['divisions'] }); setName(''); },
  });
  const removeMut = useMutation({
    mutationFn: (id: number) => divisions.remove(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['divisions'] }),
  });

  return (
    <section>
      <p className="page-sub" style={{ marginTop: 0 }}>
        Divisions are your own buckets (for example: Wine, Spirits, Beer, or by aisle). Tag sales reps with them.
      </p>
      <div className="inline-form">
        <input
          type="text"
          placeholder="Division name *"
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && name.trim()) addMut.mutate(); }}
        />
        <button className="btn" onClick={() => name.trim() && addMut.mutate()} disabled={!name.trim() || addMut.isPending}>
          Add division
        </button>
      </div>
      {(data ?? []).length === 0 ? (
        <p className="text-muted">No divisions yet. Add your first one above.</p>
      ) : (
        <div className="config-chips">
          {(data ?? []).map(d => (
            <span key={d.id} className="config-chip">
              {d.name}
              <button className="btn-icon" title="Delete division" onClick={() => removeMut.mutate(d.id)}>
                <Trash2 size={13} />
              </button>
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

export default function Configuration() {
  const [tab, setTab] = useState<Tab>('reps');
  return (
    <div className="page">
      <h2>Configuration</h2>
      <p className="page-sub">Master data for your account: sales reps, divisions, and stores.</p>

      <div className="tab-bar">
        <button type="button" className={`tab ${tab === 'reps' ? 'active' : ''}`} onClick={() => setTab('reps')}>Sales Reps</button>
        <button type="button" className={`tab ${tab === 'divisions' ? 'active' : ''}`} onClick={() => setTab('divisions')}>Divisions</button>
        <button type="button" className={`tab ${tab === 'stores' ? 'active' : ''}`} onClick={() => setTab('stores')}>Stores</button>
      </div>

      {tab === 'reps' && <SalesRepsPage embedded />}
      {tab === 'divisions' && <DivisionsManager />}
      {tab === 'stores' && <StoresPage embedded />}
    </div>
  );
}
