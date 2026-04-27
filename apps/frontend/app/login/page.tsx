'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '../lib/auth';
import { config } from '../lib/config';

type Mode = 'signin' | 'signup' | 'confirm';

export default function LoginPage() {
  const router = useRouter();
  const { signIn, signUp, confirmSignUp, loading, error, user } = useAuth();

  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [confirmCode, setConfirmCode] = useState('');
  const [localError, setLocalError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // If already authenticated, redirect
  if (user) {
    router.push('/');
    return null;
  }

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError('');
    setSubmitting(true);
    try {
      await signIn(email, password);
      router.push('/');
    } catch (err: unknown) {
      setLocalError((err as Error).message || 'Sign in failed');
    }
    setSubmitting(false);
  };

  const handleSignUp = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError('');
    setSubmitting(true);
    try {
      const result = await signUp(email, password, name);
      if (result.needsConfirmation) {
        setMode('confirm');
      } else {
        // Auto-confirmed — sign in
        await signIn(email, password);
        router.push('/');
      }
    } catch (err: unknown) {
      setLocalError((err as Error).message || 'Sign up failed');
    }
    setSubmitting(false);
  };

  const handleConfirm = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError('');
    setSubmitting(true);
    try {
      await confirmSignUp(email, confirmCode);
      // Now sign in
      await signIn(email, password);
      router.push('/');
    } catch (err: unknown) {
      setLocalError((err as Error).message || 'Confirmation failed');
    }
    setSubmitting(false);
  };

  const displayError = localError || error;

  if (!config.isApiConfigured) {
    return (
      <div className="login-page">
        <div className="login-card">
          <div className="login-logo">
            <div className="login-logo-icon">C</div>
            <h1 className="login-title">Cliquey</h1>
          </div>
          <div className="login-setup-notice">
            <div className="login-setup-icon">⚙</div>
            <h2>Backend Not Configured</h2>
            <p>Set the following environment variables in <code>.env.local</code> to connect to AWS:</p>
            <div className="login-env-list">
              <code>NEXT_PUBLIC_API_URL</code>
              <code>NEXT_PUBLIC_COGNITO_USER_POOL_ID</code>
              <code>NEXT_PUBLIC_COGNITO_CLIENT_ID</code>
            </div>
            <p className="login-setup-hint">These values come from your CDK stack outputs after running <code>cdk deploy</code>.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="login-page">
      <div className="login-card">
        {/* Logo */}
        <div className="login-logo">
          <div className="login-logo-icon">C</div>
          <h1 className="login-title">Cliquey</h1>
          <p className="login-subtitle">Omnichannel Marketing Platform</p>
        </div>

        {/* Error banner */}
        {displayError && (
          <div className="login-error">
            <span>⚠</span> {displayError}
          </div>
        )}

        {/* Sign In Form */}
        {mode === 'signin' && (
          <form onSubmit={handleSignIn} className="login-form">
            <div className="login-field">
              <label htmlFor="signin-email">Email</label>
              <input
                id="signin-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                required
                autoComplete="email"
                autoFocus
              />
            </div>
            <div className="login-field">
              <label htmlFor="signin-password">Password</label>
              <input
                id="signin-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
                autoComplete="current-password"
              />
            </div>
            <button type="submit" className="login-btn" disabled={submitting || loading}>
              {submitting ? 'Signing in...' : 'Sign In'}
            </button>
            <p className="login-switch">
              Don't have an account?{' '}
              <button type="button" onClick={() => { setMode('signup'); setLocalError(''); }}>
                Create one
              </button>
            </p>
          </form>
        )}

        {/* Sign Up Form */}
        {mode === 'signup' && (
          <form onSubmit={handleSignUp} className="login-form">
            <div className="login-field">
              <label htmlFor="signup-name">Full Name</label>
              <input
                id="signup-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Jane Smith"
                autoComplete="name"
                autoFocus
              />
            </div>
            <div className="login-field">
              <label htmlFor="signup-email">Email</label>
              <input
                id="signup-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                required
                autoComplete="email"
              />
            </div>
            <div className="login-field">
              <label htmlFor="signup-password">Password</label>
              <input
                id="signup-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Min 8 chars, mixed case + number"
                required
                autoComplete="new-password"
                minLength={8}
              />
            </div>
            <button type="submit" className="login-btn" disabled={submitting}>
              {submitting ? 'Creating account...' : 'Create Account'}
            </button>
            <p className="login-switch">
              Already have an account?{' '}
              <button type="button" onClick={() => { setMode('signin'); setLocalError(''); }}>
                Sign in
              </button>
            </p>
          </form>
        )}

        {/* Confirmation Code Form */}
        {mode === 'confirm' && (
          <form onSubmit={handleConfirm} className="login-form">
            <p className="login-confirm-hint">
              We sent a verification code to <strong>{email}</strong>. Enter it below to complete your registration.
            </p>
            <div className="login-field">
              <label htmlFor="confirm-code">Verification Code</label>
              <input
                id="confirm-code"
                type="text"
                value={confirmCode}
                onChange={(e) => setConfirmCode(e.target.value)}
                placeholder="123456"
                required
                autoFocus
                autoComplete="one-time-code"
                inputMode="numeric"
              />
            </div>
            <button type="submit" className="login-btn" disabled={submitting}>
              {submitting ? 'Verifying...' : 'Verify & Sign In'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
