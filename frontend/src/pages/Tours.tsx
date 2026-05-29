import { useEffect, useMemo, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { TOURS } from '../lib/tours/registry';
import { trackAction } from '../lib/activityTracker';
import { useAuth } from '../contexts/AuthContext';

/**
 * Tours dashboard. A grid of guided walkthroughs; clicking a live tile starts
 * that tour on the real screens. "Coming soon" tiles are the per-screen tours we
 * are still building (one per page).
 *
 * Recommended tiles (registry: recommended) wear a "Start here" banner so new
 * users know which tour to take first. When the user arrives from the post-login
 * welcome popup (router state `{ highlight: <tour id> }`), the matching tile
 * scrolls into view and pulses for a few seconds to remove any "now what?"
 * confusion.
 */
export default function Tours() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();
  const highlightId = (location.state as { highlight?: string } | null)?.highlight ?? null;
  const highlightedRef = useRef<HTMLButtonElement | null>(null);

  // Hide tiles whose tour targets an admin-only screen (e.g. RIP Products)
  // when the viewer isn't an admin. Otherwise a non-admin would start the
  // tour and be navigated to a route they can't open.
  const visibleTours = useMemo(
    () => TOURS.filter(t => !t.adminOnly || user?.is_admin),
    [user?.is_admin],
  );

  useEffect(() => {
    if (!highlightId) return;
    const node = highlightedRef.current;
    if (!node) return;
    node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    node.classList.add('tour-card--pulse');
    const t = window.setTimeout(() => node.classList.remove('tour-card--pulse'), 4200);
    // Clear the router state so a manual return to /tours doesn't re-pulse.
    window.history.replaceState({}, '');
    return () => window.clearTimeout(t);
  }, [highlightId]);

  return (
    <div className="page">
      <div className="orders-header"><h2>Guided Tours</h2></div>
      <p className="tours-intro">
        Pick a walkthrough. Each one runs on the real screens and points things out as you go.
        New here? Open the <b>Product Quick Tour</b> — it covers the whole app end to end. The other tiles are deep dives into a single screen.
      </p>

      <div className="tours-grid">
        {visibleTours.map((t) => {
          const Icon = t.icon;
          const live = !!t.run;
          const isRecommended = !!t.recommended && live;
          const isHighlighted = highlightId === t.id;
          return (
            <button
              key={t.id}
              ref={isHighlighted ? highlightedRef : undefined}
              type="button"
              className={[
                'tour-card',
                live ? '' : 'tour-card--soon',
                isRecommended ? 'tour-card--recommended' : '',
              ].filter(Boolean).join(' ')}
              disabled={!live}
              onClick={() => { if (t.run) { trackAction(`Started tour: ${t.title}`, { tour: t.id }); t.run(navigate); } }}
            >
              {isRecommended && (
                <span className="tour-card-starthere" aria-hidden="true">
                  Start here <ArrowRight size={14} />
                </span>
              )}
              <span className="tour-card-head">
                <span className="tour-card-icon" style={{ color: t.accent, background: `${t.accent}1f` }}>
                  <Icon size={22} />
                </span>
                <span className={`tour-card-meta${live ? ' is-live' : ''}`}>{t.meta}</span>
              </span>
              <span className="tour-card-title">{t.title}</span>
              <span className="tour-card-desc">{t.desc}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
