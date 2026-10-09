import { useState, type FormEvent } from 'react';
import type { PublicUser } from '@dta/shared';
import { api, errorMessage } from '../api';

type Mode = 'login' | 'register';

export function AuthPage({ onSignedIn }: { onSignedIn: (u: PublicUser) => void }) {
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    void run(async () => {
      if (mode === 'register') {
        onSignedIn((await api.register({ email, password })).user);
        return;
      }
      const res = await api.login({ email, password });
      if (res.status === 'ok') onSignedIn(res.user);
      else setMfaToken(res.mfaToken);
    });
  }

  function submitCode(e: FormEvent) {
    e.preventDefault();
    void run(async () => onSignedIn((await api.verifyMfa(mfaToken!, code)).user));
  }

  if (mfaToken) {
    return (
      <main className="center">
        <form className="card" onSubmit={submitCode}>
          <h1>Two-factor check</h1>
          <p className="muted">Enter the 6-digit code from your authenticator app.</p>
          <input
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d{6}"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            autoFocus
            required
          />
          {error && <p className="error">{error}</p>}
          <button disabled={busy}>Verify</button>
          <button type="button" className="link" onClick={() => setMfaToken(null)}>
            Back to sign in
          </button>
        </form>
      </main>
    );
  }

  return (
    <main className="center">
      <form className="card" onSubmit={submit}>
        <h1>{mode === 'login' ? 'Sign in' : 'Create account'}</h1>
        <label>
          Email
          <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label>
          Password
          <input
            type="password"
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            minLength={mode === 'register' ? 12 : undefined}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        {mode === 'register' && <p className="muted small">At least 12 characters.</p>}
        {error && <p className="error">{error}</p>}
        <button disabled={busy}>{mode === 'login' ? 'Sign in' : 'Create account'}</button>
        <button
          type="button"
          className="link"
          onClick={() => {
            setMode(mode === 'login' ? 'register' : 'login');
            setError(null);
          }}
        >
          {mode === 'login' ? 'New here? Create an account' : 'Have an account? Sign in'}
        </button>
      </form>
    </main>
  );
}
