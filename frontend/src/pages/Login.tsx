import { useState, useRef, useEffect } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

export default function Login() {
  const { login, signup } = useAuth();
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [loading, setLoading] = useState(false);
  const firstFieldRef = useRef<HTMLInputElement>(null);

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
          setInfo('Account created. Check your email for an activation link, then sign in.');
          setMode('signin');
          setPassword('');
        }
      } else {
        await login(email.trim(), password);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
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
          {info && <div className="login-info">{info}</div>}

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
    </div>
  );
}
