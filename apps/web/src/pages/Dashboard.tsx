import { useState, type FormEvent } from 'react';
import QRCode from 'qrcode';
import type { PublicUser } from '@dta/shared';
import { api, errorMessage } from '../api';

interface Props {
  user: PublicUser;
  onUserChange: (u: PublicUser) => void;
  onSignOut: () => void;
}

export function Dashboard({ user, onUserChange, onSignOut }: Props) {
  return (
    <>
      <header className="topbar">
        <strong>DigitalTradingApp</strong>
        <span className="muted">{user.email}</span>
        <button className="secondary" onClick={onSignOut}>
          Sign out
        </button>
      </header>
      <main className="grid">
        <section className="card wide">
          <h2>Trading terminal</h2>
          <p className="muted">Charts, order book and order entry arrive in the next step.</p>
        </section>
        <MfaPanel user={user} onUserChange={onUserChange} />
      </main>
    </>
  );
}

function MfaPanel({ user, onUserChange }: { user: PublicUser; onUserChange: (u: PublicUser) => void }) {
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function run(fn: () => Promise<void>) {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const startSetup = () =>
    run(async () => {
      const res = await api.mfaSetup();
      setSetup({ secret: res.secret, qr: await QRCode.toDataURL(res.otpauthUrl) });
    });

  function enable(e: FormEvent) {
    e.preventDefault();
    void run(async () => {
      onUserChange(await api.mfaEnable(code));
      setSetup(null);
      setCode('');
    });
  }

  function disable(e: FormEvent) {
    e.preventDefault();
    void run(async () => {
      onUserChange(await api.mfaDisable(code, password));
      setCode('');
      setPassword('');
    });
  }

  const codeInput = (
    <input
      inputMode="numeric"
      autoComplete="one-time-code"
      placeholder="6-digit code"
      pattern="\d{6}"
      maxLength={6}
      value={code}
      onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
      required
    />
  );

  return (
    <section className="card">
      <h2>Two-factor authentication</h2>
      {user.mfaEnabled ? (
        <form onSubmit={disable}>
          <p>
            <span className="badge on">On</span> Codes from your authenticator app are required to sign in.
          </p>
          <input
            type="password"
            placeholder="Password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          {codeInput}
          <button className="secondary">Turn off</button>
        </form>
      ) : setup ? (
        <form onSubmit={enable}>
          <p className="muted">Scan this with Google Authenticator, 1Password or similar, then enter the code.</p>
          <img src={setup.qr} alt="QR code for your authenticator app" width={180} height={180} />
          <p className="small mono">{setup.secret}</p>
          {codeInput}
          <button>Turn on</button>
        </form>
      ) : (
        <>
          <p>
            <span className="badge off">Off</span> Add a second step to sign-in.
          </p>
          <button onClick={startSetup}>Set up</button>
        </>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  );
}
