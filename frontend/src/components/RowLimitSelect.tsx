interface Props {
  value: number;
  onChange: (limit: number) => void;
}

const OPTIONS = [25, 50, 100, 200, 500, 1000];

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
