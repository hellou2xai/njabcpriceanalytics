import {
  ResponsiveContainer, BarChart, Bar, LineChart, Line, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import type { AssistantChart as ChartSpec } from '../lib/api';

const PALETTE = ['#2563eb', '#16a34a', '#ea580c', '#7c3aed', '#db2777', '#0891b2', '#a16207', '#dc2626'];

// Renders a chart spec the assistant produced (built from real tool data).
export default function AssistantChart({ spec }: { spec: ChartSpec }) {
  const { type, title, labels, series } = spec;
  if (!labels?.length || !series?.length) return null;

  // recharts wants row objects: { label, <seriesName>: value, ... }
  const rows = labels.map((lab, i) => {
    const row: Record<string, string | number> = { label: String(lab) };
    series.forEach((s, si) => { row[s.name || `Series ${si + 1}`] = s.data?.[i] ?? 0; });
    return row;
  });
  const seriesNames = series.map((s, si) => s.name || `Series ${si + 1}`);

  return (
    <figure className="assistant-chart">
      {title && <figcaption className="assistant-chart-title">{title}</figcaption>}
      <ResponsiveContainer width="100%" height={260}>
        {type === 'pie' ? (
          <PieChart>
            <Pie data={rows} dataKey={seriesNames[0]} nameKey="label" cx="50%" cy="50%" outerRadius={90} label>
              {rows.map((_, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}
            </Pie>
            <Tooltip />
            <Legend />
          </PieChart>
        ) : type === 'line' ? (
          <LineChart data={rows} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="label" tick={{ fontSize: 12 }} />
            <YAxis tick={{ fontSize: 12 }} />
            <Tooltip />
            {seriesNames.length > 1 && <Legend />}
            {seriesNames.map((n, i) => (
              <Line key={n} type="monotone" dataKey={n} stroke={PALETTE[i % PALETTE.length]} strokeWidth={2} dot={false} />
            ))}
          </LineChart>
        ) : (
          <BarChart data={rows} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="label" tick={{ fontSize: 12 }} />
            <YAxis tick={{ fontSize: 12 }} />
            <Tooltip />
            {seriesNames.length > 1 && <Legend />}
            {seriesNames.map((n, i) => (
              <Bar key={n} dataKey={n} fill={PALETTE[i % PALETTE.length]} radius={[4, 4, 0, 0]} />
            ))}
          </BarChart>
        )}
      </ResponsiveContainer>
    </figure>
  );
}
