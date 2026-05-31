interface Props {
  value: number;
  onChange: (limit: number) => void;
}

// 60 is included because the promotions/movers pages default to 60 per page
// (a clean 3-column card grid); without it the select fell back to showing
// "25 rows" while the page actually paged by 60.
const OPTIONS = [25, 50, 60, 100, 200, 500, 1000];

export default function RowLimitSelect({ value, onChange }: Props) {
  return (
    <select
      className="row-limit-select"
      value={value}
      onChange={e => onChange(Number(e.target.value))}
    >
      {OPTIONS.map(n => (
        <option key={n} value={n}>{n} rows</option>
      ))}
    </select>
  );
}
