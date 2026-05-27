import { useNavigate } from 'react-router-dom';
import { TOURS } from '../lib/tours/registry';

/**
 * Tours dashboard. A grid of guided walkthroughs; clicking a live tile starts
 * that tour on the real screens. "Coming soon" tiles are the per-screen tours we
 * are still building (one per page).
 */
export default function Tours() {
  const navigate = useNavigate();

  return (
    <div className="page">
      <div className="orders-header"><h2>Guided Tours</h2></div>
      <p className="tours-intro">
        Pick a walkthrough. Each one runs on the real screens and points things out as you go.
        The <b>Product Quick Tour</b> covers the whole app end to end; the rest are deep dives into a single screen.
      </p>

      <div className="tours-grid">
        {TOURS.map((t) => {
          const Icon = t.icon;
          const live = !!t.run;
          return (
            <button
              key={t.id}
              type="button"
              className={`tour-card${live ? '' : ' tour-card--soon'}`}
              disabled={!live}
              onClick={() => t.run?.(navigate)}
            >
              <span className="tour-card-icon" style={{ color: t.accent, background: `${t.accent}1f` }}>
                <Icon size={22} />
              </span>
              <span className="tour-card-body">
                <span className="tour-card-title">{t.title}</span>
                <span className="tour-card-desc">{t.desc}</span>
              </span>
              <span className={`tour-card-meta${live ? ' is-live' : ''}`}>{t.meta}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
