import { useMemo } from 'react';
import {
  ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, ReferenceDot, LabelList,
} from 'recharts';
import type { PricePoint } from '../lib/api';
import { useChartTheme } from '../hooks/useChartTheme';

interface Props {
  data: PricePoint[];
  labelA?: string;
  // When set, overlay a second distributor's effective cost (Allied vs Fedway).
  compare?: { data: PricePoint[]; labelB: string } | null;
}

// The story we want the chart to tell: what's the *list* price, what you
// actually *pay* (effective, after discount + RIP), and the gap between them
// — your savings — shaded so it reads at a glance.
const METRICS = [
  { base: 'frontline_case_price', color: '#94a3b8', name: 'List price', dash: '5 4', width: 1.5 },
  { base: 'best_case_price', color: '#10b981', name: 'After discount', dash: '', width: 2 },
  { base: 'effective_case_price', color: '#f59e0b', name: 'Your cost (effective)', dash: '', width: 3 },
] as const;

const A_COLOR = '#6366f1';
const B_COLOR = '#f59e0b';

const vKey = (v: string | null | undefined) => v ?? '';
const money = (v: number) => `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function PriceChart({ data, labelA = 'A', compare }: Props) {
  if (compare) return <ComparePriceChart data={data} labelA={labelA} compareData={compare.data} labelB={compare.labelB} />;
  return <SinglePriceChart data={data} />;
}

/* ── Two-distributor comparison: effective cost (all discounts + RIPs) ── */
function ComparePriceChart({ data, labelA, compareData, labelB }: {
  data: PricePoint[]; labelA: string; compareData: PricePoint[]; labelB: string;
}) {
  const ct = useChartTheme();

  const { rows, byEdition } = useMemo(() => {
    const aBy = Object.fromEntries(data.map(p => [p.edition, p]));
    const bBy = Object.fromEntries(compareData.map(p => [p.edition, p]));
    const editions = Array.from(new Set([...data, ...compareData].map(p => p.edition))).sort();
    const rows = editions.map(ed => {
      const a = aBy[ed], b = bBy[ed];
      const aEff = a?.effective_case_price ?? null;
      const bEff = b?.effective_case_price ?? null;
      const row: Record<string, unknown> = {
        edition: ed,
        aEff, bEff,
        aList: a?.frontline_case_price ?? null,
        bList: b?.frontline_case_price ?? null,
        // shaded gap between the two effective costs
        gap: aEff != null && bEff != null ? [Math.min(aEff, bEff), Math.max(aEff, bEff)] : null,
      };
      return row;
    });
    const byEdition: Record<string, { a?: PricePoint; b?: PricePoint }> = {};
    for (const ed of editions) byEdition[ed] = { a: aBy[ed], b: bBy[ed] };
    return { rows, byEdition };
  }, [data, compareData]);

  return (
    <ResponsiveContainer width="100%" height={320}>
      <ComposedChart data={rows} margin={{ top: 24, right: 28, bottom: 5, left: 10 }}>
        <defs>
          <linearGradient id="gapGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={ct.axis} stopOpacity={0.14} />
            <stop offset="100%" stopColor={ct.axis} stopOpacity={0.04} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke={ct.grid} vertical={false} />
        <XAxis dataKey="edition" stroke={ct.axis} fontSize={12} />
        <YAxis stroke={ct.axis} fontSize={12} tickFormatter={v => `$${v}`} domain={[0, 'auto']} />
        <Tooltip
          content={({ active, label }) => {
            if (!active || label == null) return null;
            const e = byEdition[label as string];
            if (!e) return null;
            const aEff = e.a?.effective_case_price;
            const bEff = e.b?.effective_case_price;
            let verdict: string | null = null;
            if (aEff != null && bEff != null && aEff !== bEff) {
              const cheaper = aEff < bEff ? labelA : labelB;
              verdict = `${cheaper} cheaper by ${money(Math.abs(aEff - bEff))}`;
            } else if (aEff != null && bEff != null) {
              verdict = 'Same effective cost';
            }
            const Row = ({ c, name, p }: { c: string; name: string; p?: PricePoint }) =>
              p ? (
                <div style={{ color: c, display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                  <span>{name}</span>
                  <strong>{money(p.effective_case_price)}<span style={{ opacity: 0.6, fontWeight: 400 }}> · list {money(p.frontline_case_price)}</span></strong>
                </div>
              ) : (
                <div style={{ color: c, display: 'flex', justifyContent: 'space-between', gap: 12 }}><span>{name}</span><span style={{ opacity: 0.6 }}>—</span></div>
              );
            return (
              <div style={{ background: ct.tooltipBg, border: `1px solid ${ct.tooltipBorder}`, borderRadius: 8, padding: '8px 10px', fontSize: 12, minWidth: 210 }}>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>{label}</div>
                <Row c={A_COLOR} name={labelA} p={e.a} />
                <Row c={B_COLOR} name={labelB} p={e.b} />
                {verdict && (
                  <div style={{ marginTop: 4, paddingTop: 4, borderTop: `1px solid ${ct.tooltipBorder}`, fontWeight: 700 }}>{verdict}</div>
                )}
              </div>
            );
          }}
        />
        <Legend />
        <Area dataKey="gap" stroke="none" fill="url(#gapGrad)" connectNulls={false} legendType="none" tooltipType="none" isAnimationActive={false} activeDot={false} />
        {/* Faint list-price references */}
        <Line type="monotone" dataKey="aList" stroke={A_COLOR} strokeWidth={1} strokeDasharray="4 4" strokeOpacity={0.45} dot={false} connectNulls name={`${labelA} list`} isAnimationActive={false} />
        <Line type="monotone" dataKey="bList" stroke={B_COLOR} strokeWidth={1} strokeDasharray="4 4" strokeOpacity={0.45} dot={false} connectNulls name={`${labelB} list`} isAnimationActive={false} />
        {/* Effective cost — the real comparison (includes all discounts + RIPs) */}
        <Line type="monotone" dataKey="aEff" stroke={A_COLOR} strokeWidth={3} dot={{ r: 3 }} connectNulls name={`${labelA} cost`} isAnimationActive={false}>
          <LabelList dataKey="aEff" position="top" offset={8} fontSize={10} fill={A_COLOR} formatter={(v: number | null) => (v != null ? `$${Number(v).toFixed(0)}` : '')} />
        </Line>
        <Line type="monotone" dataKey="bEff" stroke={B_COLOR} strokeWidth={3} dot={{ r: 3 }} connectNulls name={`${labelB} cost`} isAnimationActive={false}>
          <LabelList dataKey="bEff" position="bottom" offset={8} fontSize={10} fill={B_COLOR} formatter={(v: number | null) => (v != null ? `$${Number(v).toFixed(0)}` : '')} />
        </Line>
      </ComposedChart>
    </ResponsiveContainer>
  );
}

/* ── Single product: list vs effective with savings band ── */
function SinglePriceChart({ data }: { data: PricePoint[] }) {
  const ct = useChartTheme();

  const { rows, segCount, byEdition, bestPoint } = useMemo(() => {
    // A single UPC can carry different vintages across editions. Assign each
    // point to a contiguous-vintage segment so lines/band break (rather than
    // slope) when the vintage changes — a vintage swap is not a price move.
    const segOf: number[] = [];
    let seg = 0;
    data.forEach((p, i) => {
      if (i > 0 && vKey(data[i - 1].vintage) !== vKey(p.vintage)) seg++;
      segOf.push(seg);
    });
    const rows = data.map((p, i) => {
      const row: Record<string, unknown> = { edition: p.edition };
      for (const m of METRICS) {
        for (let s = 0; s <= seg; s++) {
          row[`${m.base}__${s}`] = segOf[i] === s ? (p as never)[m.base] : null;
        }
      }
      const eff = p.effective_case_price ?? p.frontline_case_price;
      for (let s = 0; s <= seg; s++) {
        row[`band__${s}`] = segOf[i] === s ? [eff, p.frontline_case_price] : null;
      }
      return row;
    });
    const byEdition = Object.fromEntries(data.map(p => [p.edition, p]));
    let bestPoint: PricePoint | null = null;
    for (const p of data) {
      if (bestPoint == null || p.effective_case_price < bestPoint.effective_case_price) bestPoint = p;
    }
    if (bestPoint && bestPoint.effective_case_price >= bestPoint.frontline_case_price) {
      const anySaving = data.some(p => p.effective_case_price < p.frontline_case_price);
      if (!anySaving) bestPoint = null;
    }
    return { rows, segCount: seg + 1, byEdition, bestPoint };
  }, [data]);

  const showLabels = data.length <= 8;

  return (
    <ResponsiveContainer width="100%" height={320}>
      <ComposedChart data={rows} margin={{ top: 24, right: 28, bottom: 5, left: 10 }}>
        <defs>
          <linearGradient id="savingsGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#10b981" stopOpacity={0.22} />
            <stop offset="100%" stopColor="#10b981" stopOpacity={0.04} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke={ct.grid} vertical={false} />
        <XAxis dataKey="edition" stroke={ct.axis} fontSize={12} />
        <YAxis stroke={ct.axis} fontSize={12} tickFormatter={v => `$${v}`} domain={[0, 'auto']} />
        <Tooltip
          content={({ active, label }) => {
            if (!active || label == null) return null;
            const p = byEdition[label as string];
            if (!p) return null;
            const saving = (p.frontline_case_price ?? 0) - (p.effective_case_price ?? 0);
            const pct = p.frontline_case_price > 0 ? (saving / p.frontline_case_price) * 100 : 0;
            return (
              <div style={{ background: ct.tooltipBg, border: `1px solid ${ct.tooltipBorder}`, borderRadius: 8, padding: '8px 10px', fontSize: 12, minWidth: 170 }}>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>
                  {label}{p.vintage ? ` · Vintage ${p.vintage}` : ''}
                </div>
                {METRICS.map(m => (
                  <div key={m.base} style={{ color: m.color, display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                    <span>{m.name}</span>
                    <strong>{money(Number((p as never)[m.base] ?? 0))}</strong>
                  </div>
                ))}
                <div style={{ marginTop: 4, paddingTop: 4, borderTop: `1px solid ${ct.tooltipBorder}`, color: saving > 0 ? '#10b981' : ct.axis, display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                  <span>You save</span>
                  <strong>{saving > 0 ? `${money(saving)} (${pct.toFixed(0)}%)` : '—'}</strong>
                </div>
              </div>
            );
          }}
        />
        <Legend />
        {Array.from({ length: segCount }).map((_, s) => (
          <Area
            key={`band-${s}`}
            dataKey={`band__${s}`}
            stroke="none"
            fill="url(#savingsGrad)"
            connectNulls={false}
            legendType="none"
            tooltipType="none"
            isAnimationActive={false}
            activeDot={false}
          />
        ))}
        {METRICS.map(m =>
          Array.from({ length: segCount }).map((_, s) => (
            <Line
              key={`${m.base}-${s}`}
              type="monotone"
              dataKey={`${m.base}__${s}`}
              stroke={m.color}
              strokeWidth={m.width}
              strokeDasharray={m.dash || undefined}
              connectNulls={false}
              dot={{ r: 3 }}
              name={m.name}
              legendType={s === 0 ? 'line' : 'none'}
              isAnimationActive={false}
            >
              {m.base === 'effective_case_price' && showLabels && (
                <LabelList
                  dataKey={`${m.base}__${s}`}
                  position="bottom"
                  offset={8}
                  fontSize={10}
                  fill={m.color}
                  formatter={(v: number | null) => (v != null ? `$${Number(v).toFixed(0)}` : '')}
                />
              )}
            </Line>
          ))
        )}
        {bestPoint && (
          <ReferenceDot
            x={bestPoint.edition}
            y={bestPoint.effective_case_price}
            r={6}
            fill="#f59e0b"
            stroke="#fff"
            strokeWidth={2}
            isFront
            label={{ value: `Best · ${money(bestPoint.effective_case_price)}`, position: 'top', fontSize: 11, fill: '#f59e0b', fontWeight: 700 }}
          />
        )}
      </ComposedChart>
    </ResponsiveContainer>
  );
}
