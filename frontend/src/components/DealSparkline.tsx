import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { catalog } from '../lib/api';

/**
 * Tiny inline SVG sparkline of a product's case price across recent editions,
 * with the effective (after-deal) price overlaid as a green line. Fetches its
 * own price history, but only after it scrolls into view, so a Time-Sensitive
 * Deals page with dozens of cards doesn't fire dozens of requests at once.
 */
interface Props { wholesaler: string; productName: string; width?: number; height?: number; }

export default function DealSparkline({ wholesaler, productName, width = 140, height = 36 }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!ref.current || visible) return;
    const io = new IntersectionObserver(entries => {
      for (const e of entries) if (e.isIntersecting) { setVisible(true); io.disconnect(); break; }
    }, { rootMargin: '120px' });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [visible]);

  const { data } = useQuery({
    queryKey: ['price-history', wholesaler, productName],
    queryFn: () => catalog.priceHistory(wholesaler, productName),
    enabled: visible,
    staleTime: 5 * 60_000,
  });

  const points = data?.history ?? [];
  const pad = 2;
  const path = (vals: number[]) => {
    if (vals.length < 2) return '';
    const min = Math.min(...vals), max = Math.max(...vals);
    const span = Math.max(0.0001, max - min);
    return vals.map((v, i) => {
      const x = pad + (i / (vals.length - 1)) * (width - pad * 2);
      const y = pad + (1 - (v - min) / span) * (height - pad * 2);
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
  };
  const list = points.map(p => p.frontline_case_price).filter(v => typeof v === 'number');
  const effList = points.map(p => p.effective_case_price).filter(v => typeof v === 'number');
  const first = list[0], last = list[list.length - 1];
  const direction = first != null && last != null ? (last > first ? 'up' : last < first ? 'down' : 'flat') : null;
  const stroke = direction === 'down' ? '#16a34a' : direction === 'up' ? '#dc2626' : 'var(--text-muted)';

  return (
    <div ref={ref} className="deal-spark" title="Case price over recent editions" style={{ width, height, position: 'relative' }}>
      {visible && list.length >= 2 ? (
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
          <path d={path(list)} fill="none" stroke={stroke} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          {effList.length >= 2 && (
            <path d={path(effList)} fill="none" stroke="#16a34a" strokeWidth="1.2" strokeDasharray="2 2" strokeLinecap="round" />
          )}
          {(() => {
            const xs = pad + (width - pad * 2);
            const ys = list.length ? pad + (1 - (last - Math.min(...list)) / Math.max(0.0001, Math.max(...list) - Math.min(...list))) * (height - pad * 2) : height / 2;
            return <circle cx={xs} cy={ys} r="2.4" fill={stroke} />;
          })()}
        </svg>
      ) : (
        <div className="deal-spark-placeholder" />
      )}
    </div>
  );
}
