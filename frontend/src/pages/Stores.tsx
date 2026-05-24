import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Trash2, Pencil, MapPin, Plus, X, Phone } from 'lucide-react';
import { stores as storesApi } from '../lib/api';
import type { Store, StorePrediction } from '../lib/api';

type FormState = {
  id?: number;
  name: string;
  place_id: string | null;
  formatted_address: string;
  street: string;
  city: string;
  state: string;
  postal_code: string;
  country: string;
  phone: string;
  license_number: string;
  notes: string;
};

const EMPTY: FormState = {
  name: '', place_id: null, formatted_address: '', street: '', city: '', state: '',
  postal_code: '', country: '', phone: '', license_number: '', notes: '',
};

function storeToForm(s: Store): FormState {
  return {
    id: s.id,
    name: s.name ?? '',
    place_id: s.place_id ?? null,
    formatted_address: s.formatted_address ?? '',
    street: s.street ?? '',
    city: s.city ?? '',
    state: s.state ?? '',
    postal_code: s.postal_code ?? '',
    country: s.country ?? '',
    phone: s.phone ?? '',
    license_number: s.license_number ?? '',
    notes: s.notes ?? '',
  };
}

export default function StoresPage({ onboarding = false, embedded = false }: { onboarding?: boolean; embedded?: boolean }) {
  const qc = useQueryClient();
  const [form, setForm] = useState<FormState>(EMPTY);
  const [showForm, setShowForm] = useState(onboarding);

  // Name autocomplete
  const [predictions, setPredictions] = useState<StorePrediction[]>([]);
  const [lookupOpen, setLookupOpen] = useState(false);
  const [lookupNote, setLookupNote] = useState<string | null>(null);
  const [lookupEnabled, setLookupEnabled] = useState(true);
  const debounceRef = useRef<number | undefined>(undefined);

  const { data: list, isLoading } = useQuery({ queryKey: ['stores'], queryFn: storesApi.list });

  const saveMut = useMutation({
    mutationFn: (f: FormState) => {
      const payload = {
        name: f.name,
        place_id: f.place_id,
        formatted_address: f.formatted_address || null,
        street: f.street || null,
        city: f.city || null,
        state: f.state || null,
        postal_code: f.postal_code || null,
        country: f.country || null,
        phone: f.phone || null,
        license_number: f.license_number || null,
        notes: f.notes || null,
      };
      return f.id ? storesApi.update(f.id, payload) : storesApi.create(payload);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['stores'] });
      resetForm();
    },
  });

  const removeMut = useMutation({
    mutationFn: (id: number) => storesApi.remove(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['stores'] }),
  });

  function resetForm() {
    setForm(EMPTY);
    setShowForm(false);
    setPredictions([]);
    setLookupOpen(false);
  }

  function startAdd() {
    setForm(EMPTY);
    setShowForm(true);
  }

  function startEdit(s: Store) {
    setForm(storeToForm(s));
    setShowForm(true);
    setLookupOpen(false);
  }

  // Debounced name lookup.
  useEffect(() => {
    if (!lookupOpen) return;
    const q = form.name.trim();
    if (q.length < 2) { setPredictions([]); return; }
    window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(async () => {
      try {
        const res = await storesApi.lookup(q);
        setLookupEnabled(res.enabled);
        setLookupNote(res.note);
        setPredictions(res.predictions);
      } catch {
        setPredictions([]);
      }
    }, 300);
    return () => window.clearTimeout(debounceRef.current);
  }, [form.name, lookupOpen]);

  async function choosePrediction(p: StorePrediction) {
    setLookupOpen(false);
    setPredictions([]);
    try {
      const d = await storesApi.placeDetails(p.place_id);
      setForm(f => ({
        ...f,
        name: d.name || p.main_text || f.name,
        place_id: d.place_id,
        formatted_address: d.formatted_address ?? '',
        street: d.street ?? '',
        city: d.city ?? '',
        state: d.state ?? '',
        postal_code: d.postal_code ?? '',
        country: d.country ?? '',
        phone: d.phone ?? f.phone,
      }));
    } catch {
      // Keep the typed name; user can fill the address manually.
      setForm(f => ({ ...f, name: p.main_text || f.name }));
    }
  }

  const set = (k: keyof FormState) => (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }));

  return (
    <div className={embedded ? 'stores-embedded' : 'page'}>
      {!onboarding && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            {embedded ? <h3 style={{ margin: 0 }}>My stores</h3> : <h2>My Stores</h2>}
            {!showForm && (
              <button className="btn" onClick={startAdd}><Plus size={16} /> Add store</button>
            )}
          </div>
          <p style={{ color: 'var(--text-muted, #888)', marginTop: -4 }}>
            Add every store you own. The more stores you add, the more granular your pricing and deal analytics get. Start typing a store name to look up its address.
          </p>
        </>
      )}

      {showForm && (
        <div className="store-form">
          <div className="store-form-row" style={{ position: 'relative' }}>
            <label className="store-field" style={{ flex: 2 }}>
              <span>Store name *</span>
              <input
                type="text"
                value={form.name}
                placeholder="Start typing, e.g. Joe's Wine & Spirits"
                autoComplete="off"
                onChange={e => { setForm(f => ({ ...f, name: e.target.value, place_id: null })); setLookupOpen(true); }}
                onFocus={() => { if (form.name.trim().length >= 2) setLookupOpen(true); }}
              />
            </label>
            {lookupOpen && (predictions.length > 0 || (!lookupEnabled && lookupNote)) && (
              <ul className="store-suggest">
                {predictions.map(p => (
                  <li key={p.place_id} onMouseDown={() => choosePrediction(p)}>
                    <MapPin size={14} />
                    <span>
                      <strong>{p.main_text}</strong>
                      {p.secondary_text ? <small> {p.secondary_text}</small> : null}
                    </span>
                  </li>
                ))}
                {!lookupEnabled && lookupNote && (
                  <li className="store-suggest-note">{lookupNote}</li>
                )}
              </ul>
            )}
          </div>

          <div className="store-form-row">
            <label className="store-field" style={{ flex: 3 }}>
              <span>Street</span>
              <input type="text" value={form.street} onChange={set('street')} />
            </label>
            <label className="store-field">
              <span>City</span>
              <input type="text" value={form.city} onChange={set('city')} />
            </label>
          </div>

          <div className="store-form-row">
            <label className="store-field">
              <span>State</span>
              <input type="text" value={form.state} onChange={set('state')} />
            </label>
            <label className="store-field">
              <span>ZIP</span>
              <input type="text" value={form.postal_code} onChange={set('postal_code')} />
            </label>
            <label className="store-field">
              <span>Phone</span>
              <input type="text" value={form.phone} onChange={set('phone')} />
            </label>
            <label className="store-field">
              <span>License #</span>
              <input type="text" value={form.license_number} onChange={set('license_number')} />
            </label>
          </div>

          <label className="store-field">
            <span>Notes</span>
            <textarea value={form.notes} onChange={set('notes')} rows={2} />
          </label>

          {saveMut.isError && (
            <div className="login-error">
              {saveMut.error instanceof Error ? saveMut.error.message : 'Could not save the store.'}
            </div>
          )}

          <div className="store-form-actions">
            <button className="btn" disabled={!form.name.trim() || saveMut.isPending} onClick={() => saveMut.mutate(form)}>
              {saveMut.isPending ? 'Saving...' : form.id ? 'Save changes' : 'Add store'}
            </button>
            {!onboarding && <button className="btn btn-secondary" onClick={resetForm}><X size={16} /> Cancel</button>}
          </div>
        </div>
      )}

      {isLoading ? (
        <p>Loading...</p>
      ) : (list && list.length > 0) ? (
        <div className="store-grid">
          {list.map(s => (
            <div key={s.id} className="store-card">
              <div className="store-card-head">
                <h3>{s.name}</h3>
                <div className="store-card-actions">
                  <button className="btn-icon" title="Edit" onClick={() => startEdit(s)}><Pencil size={16} /></button>
                  <button className="btn-icon" title="Delete" onClick={() => removeMut.mutate(s.id)}><Trash2 size={16} /></button>
                </div>
              </div>
              <p className="store-card-addr">
                <MapPin size={14} />
                {s.formatted_address
                  || [s.street, s.city, s.state, s.postal_code].filter(Boolean).join(', ')
                  || 'No address on file'}
              </p>
              {s.phone && <p className="store-card-meta"><Phone size={14} /> {s.phone}</p>}
              {s.license_number && <p className="store-card-meta">License: {s.license_number}</p>}
              {s.notes && <p className="store-card-notes">{s.notes}</p>}
            </div>
          ))}
        </div>
      ) : (
        !showForm && <p>No stores yet. Click "Add store" to create your first one.</p>
      )}
    </div>
  );
}
