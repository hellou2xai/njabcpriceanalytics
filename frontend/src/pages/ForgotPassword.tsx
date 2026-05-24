import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { auth } from '../lib/api';

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim()) { setError('Enter your email.'); return; }
    setLoading(true);
    setError('');
    try {
      await auth.forgotPassword(email.trim());
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-brand">
          <h1 className="login-title">CELR Retail Pricing Intelligence</h1>
          <p className="login-subtitle">Reset your password</p>
        </div>
        {sent ? (
          <div className="login-info">
            If an account exists for that email, a reset link is on its way. Check your inbox.
          </div>
        ) : (
          <form className="login-form" onSubmit={submit}>
            {error && <div className="login-error">{error}</div>}
            <label className="login-label">
              <span>Email</span>
              <input type="email" className="login-input" value={email}
                     onChange={e => setEmail(e.target.value)} placeholder="you@store.com"
                     autoComplete="email" autoFocus />
            </label>
            <button type="submit" className="btn login-btn" disabled={loading}>
              {loading ? 'Sending...' : 'Send reset link'}
            </button>
          </form>
        )}
        <p className="login-switch"><Link to="/">Back to sign in</Link></p>
      </div>
    </div>
  );
}
