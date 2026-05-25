import { useEffect, useState } from 'react';
import { consent as consentApi } from '../lib/api';
import './CookieConsent.css';

// Bump this when the cookie policy materially changes to re-prompt everyone.
const POLICY_VERSION = '2026-05-25';
const STORE_KEY = 'celr_cookie_consent';
const ANON_KEY = 'celr_anon_id';

type Stored = { analytics: boolean; marketing: boolean; version: string; ts: string; decision: string };

function readStored(): Stored | null {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch { return null; }
}
function anonId(): string {
  let id = localStorage.getItem(ANON_KEY);
  if (!id) {
    id = (crypto as any)?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(ANON_KEY, id);
  }
  return id;
}

// Other parts of the UI (e.g. a footer link) can reopen the preferences:
//   window.dispatchEvent(new Event('celr:cookie-preferences'))
export default function CookieConsent() {
  const [open, setOpen] = useState(false);
  const [manage, setManage] = useState(false);
  const [analytics, setAnalytics] = useState(true);
  const [marketing, setMarketing] = useState(true);

  useEffect(() => {
    const c = readStored();
    if (!c || c.version !== POLICY_VERSION) {
      setOpen(true);
    } else {
      setAnalytics(c.analytics);
      setMarketing(c.marketing);
    }
    const reopen = () => {
      const cur = readStored();
      if (cur) { setAnalytics(cur.analytics); setMarketing(cur.marketing); }
      setManage(true);
      setOpen(true);
    };
    window.addEventListener('celr:cookie-preferences', reopen);
    return () => window.removeEventListener('celr:cookie-preferences', reopen);
  }, []);

  const save = (a: boolean, m: boolean, decision: string) => {
    const rec: Stored = { analytics: a, marketing: m, version: POLICY_VERSION, ts: new Date().toISOString(), decision };
    localStorage.setItem(STORE_KEY, JSON.stringify(rec));
    // Record every decision in the database (best-effort; never blocks the UI).
    consentApi.record({
      anon_id: anonId(), analytics: a, marketing: m, decision,
      policy_version: POLICY_VERSION, page: window.location.pathname, user_agent: navigator.userAgent,
    }).catch(() => {});
    setAnalytics(a); setMarketing(m); setManage(false); setOpen(false);
  };

  if (!open) return null;

  return (
    <div className="cc">
      {!manage ? (
        <div className="cc-banner" role="dialog" aria-label="Cookie consent">
          <div className="cc-text">
            <strong>We use cookies.</strong> We use essential cookies to run CELR.ai and, with your
            consent, analytics and marketing cookies to improve the product. See our{' '}
            <a href="/privacy" target="_blank" rel="noreferrer">Privacy Policy</a>.
          </div>
          <div className="cc-actions">
            <button className="cc-btn cc-ghost" onClick={() => setManage(true)}>Manage</button>
            <button className="cc-btn cc-ghost" onClick={() => save(false, false, 'reject')}>Reject non-essential</button>
            <button className="cc-btn cc-primary" onClick={() => save(true, true, 'accept_all')}>Accept all</button>
          </div>
        </div>
      ) : (
        <div className="cc-modal-overlay" onClick={() => { if (readStored()) setOpen(false); setManage(false); }}>
          <div className="cc-modal" role="dialog" aria-label="Cookie preferences" onClick={e => e.stopPropagation()}>
            <h3 className="cc-modal-title">Cookie preferences</h3>
            <p className="cc-modal-sub">
              Choose which cookies CELR.ai may use. You can change this anytime. See our{' '}
              <a href="/privacy" target="_blank" rel="noreferrer">Privacy Policy</a>.
            </p>

            <div className="cc-row">
              <div>
                <div className="cc-row-title">Strictly necessary</div>
                <div className="cc-row-desc">Required to sign you in and keep the app working. Always on.</div>
              </div>
              <label className="cc-toggle cc-toggle-locked">
                <input type="checkbox" checked readOnly disabled />
                <span className="cc-track" />
              </label>
            </div>

            <div className="cc-row">
              <div>
                <div className="cc-row-title">Analytics</div>
                <div className="cc-row-desc">Helps us understand usage so we can improve the product. Aggregated and anonymized.</div>
              </div>
              <label className="cc-toggle">
                <input type="checkbox" checked={analytics} onChange={e => setAnalytics(e.target.checked)} />
                <span className="cc-track" />
              </label>
            </div>

            <div className="cc-row">
              <div>
                <div className="cc-row-title">Marketing</div>
                <div className="cc-row-desc">Lets us tailor product updates and offers that are relevant to you.</div>
              </div>
              <label className="cc-toggle">
                <input type="checkbox" checked={marketing} onChange={e => setMarketing(e.target.checked)} />
                <span className="cc-track" />
              </label>
            </div>

            <div className="cc-modal-actions">
              <button className="cc-btn cc-ghost" onClick={() => save(false, false, 'reject')}>Reject non-essential</button>
              <button className="cc-btn cc-primary" onClick={() => save(analytics, marketing, 'custom')}>Save preferences</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
