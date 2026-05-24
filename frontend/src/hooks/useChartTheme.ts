export function useChartTheme() {
  const s = getComputedStyle(document.documentElement);
  return {
    grid: s.getPropertyValue('--chart-grid').trim() || '#333',
    axis: s.getPropertyValue('--text-muted').trim() || '#888',
    tooltipBg: s.getPropertyValue('--chart-tooltip-bg').trim() || '#1e1e2e',
    tooltipBorder: s.getPropertyValue('--chart-tooltip-border').trim() || '#333',
  };
}
