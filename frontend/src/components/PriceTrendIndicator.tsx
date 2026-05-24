import React from 'react';

interface PriceTrendProps {
  currentPrice: number;
  previousPrice?: number;
  low12m?: number;
  high12m?: number;
  isNew?: boolean;
}

const ArrowDown = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
    <path d="M6 2v8M3 7l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const ArrowUp = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
    <path d="M6 10V2M3 5l3-3 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const ArrowFlat = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
    <path d="M2 6h8M7 3l3 3-3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export default function PriceTrendIndicator({
  currentPrice,
  previousPrice,
  low12m,
  high12m,
  isNew,
}: PriceTrendProps) {
  if (isNew) {
    return (
      <div className="price-trend">
        <span className="price-trend-badge new-item">NEW</span>
      </div>
    );
  }

  if (previousPrice === undefined || previousPrice === 0) {
    return <div className="price-trend">--</div>;
  }

  const delta = currentPrice - previousPrice;
  const pctChange = (delta / previousPrice) * 100;
  const isDown = delta < -0.005;
  const isUp = delta > 0.005;

  const color = isDown ? 'var(--green)' : isUp ? 'var(--red)' : 'var(--text-muted)';
  const sign = isUp ? '+' : '';
  const formattedPct = `${sign}${pctChange.toFixed(1)}%`;

  const isAt12mLow = low12m !== undefined && Math.abs(currentPrice - low12m) < 0.01;
  const isAt12mHigh = high12m !== undefined && Math.abs(currentPrice - high12m) < 0.01;

  return (
    <div className="price-trend">
      <span className="price-trend-arrow" style={{ color }}>
        {isDown ? <ArrowDown /> : isUp ? <ArrowUp /> : <ArrowFlat />}
        {formattedPct}
      </span>
      <span className="price-trend-prev">was ${previousPrice.toFixed(2)}</span>
      {isAt12mLow && <span className="price-trend-badge low">12m low</span>}
      {isAt12mHigh && <span className="price-trend-badge high">12m high</span>}
    </div>
  );
}
