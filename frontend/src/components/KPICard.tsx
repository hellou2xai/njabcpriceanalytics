import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

interface Props {
  label: string;
  value: string | number;
  sub?: string;
  color?: string;
  to?: string;
  title?: string;
  icon?: ReactNode;
}

export default function KPICard({ label, value, sub, color, to, title, icon }: Props) {
  const navigate = useNavigate();
  const clickable = !!to;
  const accent = color ?? '#3b82f6';
  const handleClick = () => { if (to) navigate(to); };
  const handleKey = (e: React.KeyboardEvent) => {
    if (to && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      navigate(to);
    }
  };
  return (
    <div
      className={`kpi-card${clickable ? ' kpi-card-clickable' : ''}`}
      onClick={clickable ? handleClick : undefined}
      onKeyDown={clickable ? handleKey : undefined}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      title={title}
    >
      <div className="kpi-card-head">
        {icon && (
          <span
            className="kpi-icon"
            style={{ color: accent, background: `color-mix(in srgb, ${accent} 14%, transparent)` }}
          >
            {icon}
          </span>
        )}
      </div>
      <div className="kpi-value" style={{ color: accent }}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
      <div className="kpi-label">{label}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}
