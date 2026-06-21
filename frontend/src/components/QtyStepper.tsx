import { useState } from 'react';

// Quantity stepper with a manually-editable field. The input keeps a LOCAL draft
// while focused and commits only on blur / Enter — so a multi-digit entry like
// "15" isn't sent (and clamped back) on every keystroke. +/- step and commit
// immediately. Shared by the Cart and the Lists order lines.
export function QtyStepper({ label, value, onChange, disabled }: {
  label?: string; value: number; onChange: (n: number) => void; disabled?: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft != null ? draft : (value === 0 ? '' : String(value));
  const commit = (raw: string) => {
    const n = Math.max(0, parseInt(raw.replace(/[^0-9]/g, '') || '0', 10));
    setDraft(null);
    if (n !== value) onChange(n);
  };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      {label && <span style={{ fontSize: 10, color: 'var(--text-muted)', width: 28 }}>{label}</span>}
      <button type="button" className="btn btn-secondary btn-sm" disabled={disabled || value <= 0}
        onClick={() => { setDraft(null); onChange(Math.max(0, value - 1)); }}>-</button>
      <input type="text" inputMode="numeric" value={shown} placeholder="0" disabled={disabled}
        style={{ width: 52, textAlign: 'center' }}
        onFocus={e => { setDraft(value === 0 ? '' : String(value)); e.currentTarget.select(); }}
        onChange={e => setDraft(e.target.value.replace(/[^0-9]/g, ''))}
        onBlur={e => commit(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') e.currentTarget.blur();
          else if (e.key === 'Escape') { setDraft(null); e.currentTarget.blur(); }
        }} />
      <button type="button" className="btn btn-secondary btn-sm" disabled={disabled}
        onClick={() => { setDraft(null); onChange(value + 1); }}>+</button>
    </div>
  );
}
