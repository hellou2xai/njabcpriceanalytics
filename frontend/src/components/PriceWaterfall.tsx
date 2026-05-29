import {
  BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip, LabelList, ResponsiveContainer,
} from 'recharts';
import { useChartTheme } from '../hooks/useChartTheme';

/**
 * Classic waterfall: anchored green totals (List, You pay) with red floating
 * "decrease" bars for each reduction (CPL discount, RIP). Totals are labeled
 * above their bar; decreases are labeled ($x) below — same convention as a
 * P&L / expenses waterfall.
 */
interface Props {
  list: number;
  afterDiscount: number;   // list minus best CPL discount (best_case_price)
  effective: number;       // afterDiscount minus best RIP (effective_case_price)
  height?: number;
  yMax?: number;           // shared Y-axis ceiling so paired charts are comparable
}

const money = (v: number) => `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const TOTAL = '#2e9e6e';     // green — start/end totals
const DECREASE = '#e0695a';  // coral — reductions (discount / RIP)

interface Step { name: string; base: number; bar: number; total: boolean; label: string; kind: string; full: number }

export default function PriceWaterfall({ list, afterDiscount, effective, height = 250, yMax }: Props) {
  const ct = useChartTheme();
  const aDisc = Math.max(0, list - afterDiscount);
  const rip = Math.max(0, afterDiscount - effective);

  const steps: Step[] = [
    { name: 'List', base: 0, bar: list, total: true, label: money(list), kind: 'List price', full: list },
  ];
  if (aDisc > 0) steps.push({ name: 'Discount', base: afterDiscount, bar: aDisc, total: false, label: `(${money(aDisc)})`, kind: 'CPL discount', full: aDisc });
  if (rip > 0) steps.push({ name: 'RIP', base: effective, bar: rip, total: false, label: `(${money(rip)})`, kind: 'RIP rebate', full: rip });
  steps.push({ name: 'Price after RIP', base: 0, bar: effective, total: true, label: money(effective), kind: 'Price after RIP', full: effective });

  // Totals labeled above the bar; decreases labeled below (in parentheses).
  const renderLabel = (props: { x?: number; y?: number; width?: number; height?: number; index?: number }) => {
    const { x = 0, y = 0, width = 0, height: h = 0, index = 0 } = props;
    const s = steps[index];
    if (!s) return null;
    const cx = x + width / 2;
    return s.total
      ? <text x={cx} y={y - 5} textAnchor="middle" fontSize={11} fontWeight={700} fill={ct.axis}>{s.label}</text>
      : <text x={cx} y={y + h + 14} textAnchor="middle" fontSize={11} fontWeight={600} fill={DECREASE}>{s.label}</text>;
  };

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={steps} margin={{ top: 22, right: 8, bottom: 20, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={ct.grid} vertical={false} />
        <XAxis dataKey="name" stroke={ct.axis} fontSize={11} interval={0} />
        <YAxis stroke={ct.axis} fontSize={11} tickFormatter={v => `$${v}`} domain={[0, yMax ?? 'auto']} allowDecimals={false} />
        <Tooltip
          cursor={{ fill: 'transparent' }}
          content={({ active, payload }) => {
            if (!active || !payload || !payload.length) return null;
            const s = payload[0]?.payload as Step | undefined;
            if (!s) return null;
            return (
              <div style={{ background: ct.tooltipBg, border: `1px solid ${ct.tooltipBorder}`, borderRadius: 8, padding: '7px 10px', fontSize: 12 }}>
                <div style={{ fontWeight: 600 }}>{s.kind}</div>
                <div style={{ color: s.total ? TOTAL : DECREASE }}>{s.total ? `${money(s.full)} / case` : `− ${money(s.full)} / case`}</div>
              </div>
            );
          }}
        />
        <Bar dataKey="base" stackId="a" fill="transparent" isAnimationActive={false} />
        <Bar dataKey="bar" stackId="a" maxBarSize={70} isAnimationActive={false}>
          {steps.map((s, i) => <Cell key={i} fill={s.total ? TOTAL : DECREASE} />)}
          <LabelList content={renderLabel} />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
