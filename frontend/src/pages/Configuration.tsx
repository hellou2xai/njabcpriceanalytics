import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { divisions } from '../lib/api';
import { distributorName, DISTRIBUTOR_NAMES } from '../lib/distributors';
import { useDraftState, clearDrafts } from '../hooks/useDraftState';
import SalesRepsPage from './SalesReps';
import StoresPage from './Stores';

type Tab = 'reps' | 'divisions' | 'stores';

const DISTRIBUTORS = Object.keys(DISTRIBUTOR_NAMES);

function DivisionsManager() {
  const qc = useQueryClient();
  // Draft-persisted so a half-typed division survives a Back-button navigation.
  const [name, setName] = useDraftState('divisions:name', '');
  const [distributor, setDistributor] = useDraftState('divisions:distributor', '');
  const { data } = useQuery({ queryKey: ['divisions'], queryFn: divisions.list });

  const addMut = useMutation({
    mutationFn: () => divisions.add(name.trim(), distributor),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['divisions'] }); setName(''); clearDrafts('divisions:'); },
  });
  const removeMut = useMutation({
    mutationFn: (id: number) => divisions.remove(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['divisions'] }),
  });
  const canAdd = !!name.trim() && !!distributor;

  return (
    <section>
      <p className="page-sub" style={{ marginTop: 0 }}>
        Divisions are your own buckets within a distributor (for example: Wine, Spirits, Beer, or by aisle).
        Pick the distributor, name the division, then tag sales reps with it.
      </p>
      <div className="inline-form">
        <select value={distributor} onChange={e => setDistributor(e.target.value)}>
          <option value="">Distributor *</option>
          {DISTRIBUTORS.map(d => <option key={d} value={d}>{distributorName(d)}</option>)}
        </select>
        <input
          type="text"
          placeholder="Division name *"
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && canAdd) addMut.mutate(); }}
        />
        <button className="btn" onClick={() => canAdd && addMut.mutate()} disabled={!canAdd || addMut.isPending}>
          Add division
        </button>
      </div>
      {(data ?? []).length === 0 ? (
        <p className="text-muted">No divisions yet. Add your first one above.</p>
      ) : (
        <div className="config-chips">
          {(data ?? []).map(d => (
            <span key={d.id} className="config-chip">
              {d.distributor ? <strong style={{ marginRight: 4 }}>{distributorName(d.distributor)}:</strong> : null}{d.name}
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
  const [tab, setTab] = useDraftState<Tab>('config:tab', 'reps');
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
