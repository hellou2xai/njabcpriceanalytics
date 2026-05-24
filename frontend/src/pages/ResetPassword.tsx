import { useState } from 'react';
import type { FormEvent } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { auth } from '../lib/api';

export default function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [pw, setPw] = useState('');
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (pw.length < 8) { setError('Password must be at least 8 characters.'); return; }
    if (!token) { setError('This reset link is missing or invalid.'); return; }
    setLoading(true);
    setError('');
    try {
      await auth.resetPassword(token, pw);
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reset your password.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-brand">
          <h1 className="login-title">CELR Retail Pricing Intelligence</h1>
          <p className="login-subtitle">Choose a new password</p>
        </div>
        {done ? (
          <>
            <div className="login-info">Your password has been reset. You can sign in now.</div>
            <p className="login-switch"><Link to="/">Go to sign in</Link></p>
          </>
        ) : (
          <form className="login-form" onSubmit={submit}>
            {error && <div className="login-error">{error}</div>}
            <label className="login-label">
              <span>New password</span>
              <input type="password" className="login-input" value={pw}
                     onChange={e => setPw(e.target.value)} placeholder="At least 8 characters"
                     autoComplete="new-password" autoFocus />
            </label>
            <button type="submit" className="btn login-btn" disabled={loading}>
              {loading ? 'Saving...' : 'Reset password'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
