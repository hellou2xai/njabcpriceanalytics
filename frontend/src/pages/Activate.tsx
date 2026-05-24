import { useEffect, useRef, useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

export default function Activate() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const { activate } = useAuth();
  const [error, setError] = useState('');
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    if (!token) { setError('This activation link is missing its token.'); return; }
    activate(token)
      .then(() => { window.location.replace('/'); })   // full reload into the app
      .catch(err => setError(err instanceof Error ? err.message : 'Activation failed.'));
  }, [token, activate]);

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-brand">
          <h1 className="login-title">CELR Retail Pricing Intelligence</h1>
          <p className="login-subtitle">Account activation</p>
        </div>
        {error
          ? <div className="login-error">{error}</div>
          : <div className="login-info">Activating your account...</div>}
        {error && <p className="login-switch"><Link to="/">Back to sign in</Link></p>}
      </div>
    </div>
  );
}
