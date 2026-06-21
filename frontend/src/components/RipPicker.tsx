import { ripPrograms, effectiveRipCode, betterProgram, programSummary, fmtAmt } from '../lib/ripPrograms';
import type { CatalogTier } from '../lib/api';

// The "RIP" field for a cart / list line: shows which RIP code is CONSIDERED for
// the line, and — because one item identity can sit under several RIP programs
// (they don't stack) — lets the buyer pick a better one. When a program pays more
// at the line's quantity, a "★ Better" shortcut switches to it in one click.
// Same component on the Cart and Lists so the two stay in lock-step.
export function RipPicker({ line, qtyCases, onChoose, busy }: {
  line: { rip_choice?: string | null; rip_code?: string | null; tiers?: CatalogTier[] | null };
  qtyCases: number;
  onChoose: (code: string | null) => void;
  busy?: boolean;
}) {
  const programs = ripPrograms(line.tiers);
  if (!programs.length) return <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>No RIP</span>;
  const eff = effectiveRipCode(line, programs);
  const better = betterProgram(programs, eff, qtyCases);
  // Only one program → show the considered code; nothing better to choose.
  if (programs.length === 1) {
    return (
      <span style={{ fontSize: 11, whiteSpace: 'nowrap' }} title={programSummary(programs[0])}>
        RIP {programs[0].code ?? '—'}
      </span>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }} onClick={e => e.stopPropagation()}>
      <select value={eff ?? ''} disabled={busy}
        title="This item qualifies under more than one RIP program — they don't stack, so pick the one this line should earn."
        style={{ fontSize: 11, padding: '1px 4px', maxWidth: 200, border: '1px solid var(--border)', borderRadius: 4, background: 'var(--surface)' }}
        onChange={e => onChoose(e.target.value || null)}>
        {programs.map(p => (
          <option key={p.code ?? ''} value={p.code ?? ''}>
            RIP {p.code ?? '—'} · {programSummary(p)}
          </option>
        ))}
      </select>
      {better && (
        <button type="button"
          title={`RIP ${better.program.code} pays ${fmtAmt(better.pays)} vs ${fmtAmt(better.currentPays)} at ${better.atQty} — click to switch.`}
          style={{ fontSize: 10, fontWeight: 700, color: 'hsl(150 60% 30%)', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', padding: 0 }}
          onClick={() => onChoose(better.program.code)}>
          ★ Better: RIP {better.program.code} (+{fmtAmt(better.pays - better.currentPays)})
        </button>
      )}
    </div>
  );
}
