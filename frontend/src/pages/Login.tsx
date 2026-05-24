import { useState, useRef, useEffect } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { auth as authApi } from '../lib/api';

export default function Login() {
  const { login, signup } = useAuth();
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  // When set, the activation popup is shown for this email.
  const [activationEmail, setActivationEmail] = useState<string | null>(null);
  const [resendMsg, setResendMsg] = useState('');
  const [resending, setResending] = useState(false);
  const firstFieldRef = useRef<HTMLInputElement>(null);

  const openActivation = (forEmail: string) => {
    setActivationEmail(forEmail);
    setResendMsg('');
    setError('');
  };

  const resendActivation = async () => {
    if (!activationEmail) return;
    setResending(true);
    setResendMsg('');
    try {
      await authApi.resendActivation(activationEmail);
      setResendMsg('Activation email re-sent. It can take a minute, and please check your spam folder.');
    } catch {
      setResendMsg('Could not resend right now. Please try again shortly.');
    } finally {
      setResending(false);
    }
  };

  useEffect(() => {
    firstFieldRef.current?.focus();
  }, [mode]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');

    if (!email.trim() || !password) {
      setError('Please enter your email and password.');
      return;
    }
    if (mode === 'signup' && password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }

    setLoading(true);
    try {
      if (mode === 'signup') {
        const res = await signup(email.trim(), password, fullName.trim() || undefined);
        if (res.activationRequired) {
          setMode('signin');
          setPassword('');
          openActivation(res.email ?? email.trim());   // show the activation popup
        }
      } else {
        await login(email.trim(), password);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Something went wrong. Please try again.';
      // A not-yet-activated account: surface the activation popup instead of a raw error.
      if (/verify your email|activate your account/i.test(msg)) {
        openActivation(email.trim());
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  };

  const isSignup = mode === 'signup';

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-brand">
          <h1 className="login-title">CELR Retail Pricing Intelligence</h1>
          <p className="login-subtitle">NJ ABC wholesale price intelligence for liquor retailers</p>
        </div>

        <form className="login-form" onSubmit={handleSubmit}>
          {error && <div className="login-error">{error}</div>}

          {isSignup && (
            <label className="login-label">
              <span>Your name</span>
              <input
                ref={isSignup ? firstFieldRef : undefined}
                type="text"
                className="login-input"
                value={fullName}
                onChange={e => setFullName(e.target.value)}
                placeholder="e.g. Sam Tripathy"
                autoComplete="name"
              />
            </label>
          )}

          <label className="login-label">
            <span>Email</span>
            <input
              ref={!isSignup ? firstFieldRef : undefined}
              type="email"
              className="login-input"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="you@store.com"
              autoComplete="email"
            />
          </label>

          <label className="login-label">
            <span>Password</span>
            <input
              type="password"
              className="login-input"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder={isSignup ? 'At least 8 characters' : 'Enter password'}
              autoComplete={isSignup ? 'new-password' : 'current-password'}
            />
          </label>

          <button type="submit" className="btn login-btn" disabled={loading}>
            {loading
              ? (isSignup ? 'Creating account...' : 'Signing in...')
              : (isSignup ? 'Create account' : 'Sign In')}
          </button>

          {!isSignup && (
            <p className="login-forgot">
              <Link to="/forgot-password">Forgot password?</Link>
              {' · '}
              <button type="button" className="login-link-btn"
                      onClick={() => email.trim()
                        ? openActivation(email.trim())
                        : setError('Enter your email above, then click "Resend activation email".')}>
                Resend activation email
              </button>
            </p>
          )}
        </form>

        <p className="login-switch">
          {isSignup ? 'Already have an account?' : 'New here?'}{' '}
          <button
            type="button"
            className="login-switch-btn"
            onClick={() => { setMode(isSignup ? 'signin' : 'signup'); setError(''); }}
          >
            {isSignup ? 'Sign in' : 'Create an account'}
          </button>
        </p>
      </div>

      {activationEmail && (
        <div className="modal-overlay" onClick={() => setActivationEmail(null)}>
          <div className="activation-card" onClick={e => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setActivationEmail(null)} aria-label="Close">✕</button>
            <h3 style={{ marginTop: 0 }}>Activate your account</h3>
            <p>
              We sent an activation link to <strong>{activationEmail}</strong>. Click it to
              activate your account, then sign in.
            </p>
            <p className="activation-spam">
              Can't find it? Please check your <strong>spam or junk</strong> folder. It can take a
              minute to arrive.
            </p>
            {resendMsg && <div className="login-info">{resendMsg}</div>}
            <div className="activation-actions">
              <button className="btn btn-secondary btn-sm" onClick={resendActivation} disabled={resending}>
                {resending ? 'Resending...' : 'Resend activation email'}
              </button>
              <button className="btn btn-sm" onClick={() => setActivationEmail(null)}>Got it</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
