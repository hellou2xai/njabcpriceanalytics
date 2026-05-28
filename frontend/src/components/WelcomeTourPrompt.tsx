import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Compass, X } from 'lucide-react';

/**
 * One-time welcome prompt shown to every signed-in user (new or existing) on
 * login, nudging them to the Guided Tours. "Skip for now" hides it until the
 * next login (session flag); "Don't remind me again" hides it for good
 * (localStorage). Rendered inside Layout, so it only appears once authenticated.
 */
const NEVER_KEY = 'celr_welcome_tour_never';
const SESSION_KEY = 'celr_welcome_tour_seen';

export default function WelcomeTourPrompt() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (localStorage.getItem(NEVER_KEY) === '1') return;
    if (sessionStorage.getItem(SESSION_KEY) === '1') return;
    const t = setTimeout(() => setOpen(true), 700);
    return () => clearTimeout(t);
  }, []);

  if (!open) return null;

  const markSeen = () => sessionStorage.setItem(SESSION_KEY, '1');
  const skip = () => { markSeen(); setOpen(false); };
  const never = () => { localStorage.setItem(NEVER_KEY, '1'); setOpen(false); };
  const goTours = () => {
    markSeen();
    setOpen(false);
    // Highlight signal so the Tours page pulses the Product Quick Tour tile,
    // removing the "I am here but what now?" confusion new users reported.
    navigate('/tours', { state: { highlight: 'quick' } });
  };
  const goDashboard = () => { markSeen(); setOpen(false); navigate('/'); };

  return (
    <div className="welcome-overlay" role="dialog" aria-modal="true" aria-labelledby="welcome-title">
      <div className="welcome-modal">
        <button className="welcome-close" onClick={skip} aria-label="Close"><X size={18} /></button>
        <div className="welcome-icon"><Compass size={26} /></div>
        <h2 id="welcome-title">New here? Take a 5-minute tour</h2>
        <p>
          Spend five minutes with the <b>Guided Tours</b> in your left menu. You will learn everything it
          takes to find the best deals, build orders across distributors, and start saving
          <b> thousands of dollars every week</b>, with all the discount and rebate maths done for you.
        </p>
        <div className="welcome-actions">
          <button className="btn btn-primary" onClick={goTours}><Compass size={16} /> Take me to the tours</button>
          <button className="btn btn-secondary" onClick={goDashboard}>Go to dashboard</button>
        </div>
        <div className="welcome-minor">
          <button type="button" className="welcome-link" onClick={skip}>Skip for now</button>
          <span className="welcome-dot">·</span>
          <button type="button" className="welcome-link" onClick={never}>Don’t remind me again</button>
        </div>
      </div>
    </div>
  );
}
