import { Link } from 'react-router-dom';
import { Percent, TrendingDown, Zap, BarChart3, Brain, ShieldCheck, ArrowRight } from 'lucide-react';

const PAGES = [
  { path: '/discounts', label: 'Discounts', icon: Percent, color: '#10b981', desc: 'Ranked discount opportunities by savings per case.' },
  { path: '/clearance', label: 'Clearance', icon: TrendingDown, color: '#ef4444', desc: 'Closeout / last-chance items before they discontinue.' },
  { path: '/rips', label: 'Promotions', icon: Zap, color: '#8b5cf6', desc: 'Active RIP promotions from the rebate sheets.' },
  { path: '/analytics', label: 'Analytics', icon: BarChart3, color: '#3b82f6', desc: 'Price movers, lifecycle, cross-source and category trends.' },
  { path: '/decisions', label: 'Decisions', icon: Brain, color: '#f59e0b', desc: 'Buy signals, buy sheet and missed opportunities.' },
  { path: '/qa', label: 'QA', icon: ShieldCheck, color: '#ef4444', desc: 'Agentic data-quality scan — variance flags + root cause.' },
];

export default function AdditionalPages() {
  return (
    <div className="page">
      <div className="dashboard-hero">
        <div>
          <h2 className="dashboard-hero-title">Additional Pages</h2>
          <p className="dashboard-hero-sub">Secondary tools, grouped here while we organize the workspace.</p>
        </div>
      </div>

      <div className="addnl-grid">
        {PAGES.map(({ path, label, icon: Icon, color, desc }) => (
          <Link key={path} to={path} className="addnl-card" style={{ borderLeftColor: color }}>
            <span className="addnl-icon" style={{ color, background: `color-mix(in srgb, ${color} 14%, transparent)` }}>
              <Icon size={22} />
            </span>
            <div className="addnl-body">
              <div className="addnl-label">{label}</div>
              <div className="addnl-desc">{desc}</div>
            </div>
            <ArrowRight size={18} className="addnl-arrow" />
          </Link>
        ))}
      </div>
    </div>
  );
}
