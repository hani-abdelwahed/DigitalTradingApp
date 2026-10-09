import { useEffect, useState, type FormEvent } from 'react';
import type { ApiKey, ApiKeyScope, CreatedApiKey, PublicUser } from '@dta/shared';
import { api, errorMessage } from '../api';

const SCOPE_LABEL: Record<ApiKeyScope, string> = { read: 'Read', trade: 'Trade' };

function date(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString() : 'never';
}

export function ApiKeysPanel({ user }: { user: PublicUser }) {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedApiKey | null>(null);
  const [name, setName] = useState('');
  const [trade, setTrade] = useState(false);
  const [expires, setExpires] = useState('90');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = () => void api.apiKeys().then(setKeys).catch((err) => setError(errorMessage(err)));
  useEffect(load, []);

  async function create(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const key = await api.createApiKey({
        name,
        scopes: trade ? ['read', 'trade'] : ['read'],
        expiresInDays: expires === 'never' ? null : Number(expires),
        password,
        ...(user.mfaEnabled ? { code } : {}),
      });
      setCreated(key);
      setCreating(false);
      setName('');
      setPassword('');
      setCode('');
      setTrade(false);
      load();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function revoke(k: ApiKey) {
    if (!window.confirm(`Revoke "${k.name}"? Programs using it will stop working.`)) return;
    setError(null);
    try {
      await api.revokeApiKey(k.id);
      load();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <section className="card">
      <h2>API keys</h2>
      <p className="muted small">Let your own programs read your account or place orders. Keys cannot change sign-in settings.</p>

      {created && (
        <div className="new-key">
          <p className="small">Copy this key now. It will not be shown again.</p>
          <code className="mono small">{created.key}</code>
          <div className="row">
            <button
              type="button"
              onClick={() => void navigator.clipboard.writeText(created.key).then(() => setCopied(true))}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button type="button" className="secondary" onClick={() => (setCreated(null), setCopied(false))}>
              Done
            </button>
          </div>
        </div>
      )}

      {keys.length > 0 && (
        <ul className="key-list">
          {keys.map((k) => (
            <li key={k.id}>
              <div>
                <strong>{k.name}</strong> {k.scopes.map((s) => <span key={s} className={`badge ${s === 'trade' ? 'warn' : 'off'}`}>{SCOPE_LABEL[s]}</span>)}
                <div className="muted small mono">{k.prefix}…</div>
                <div className="muted small">
                  Last used {date(k.lastUsedAt)} · expires {date(k.expiresAt)}
                </div>
              </div>
              <button type="button" className="secondary" onClick={() => void revoke(k)}>
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}

      {creating ? (
        <form onSubmit={create}>
          <input placeholder="Name, e.g. My trading bot" value={name} onChange={(e) => setName(e.target.value)} maxLength={64} required />
          <label className="check">
            <input type="checkbox" checked={trade} onChange={(e) => setTrade(e.target.checked)} disabled={!user.mfaEnabled} />
            Can place and cancel orders
          </label>
          {!user.mfaEnabled && <p className="muted small">Turn on two-factor authentication to create keys that can trade.</p>}
          <label>
            Expires
            <select value={expires} onChange={(e) => setExpires(e.target.value)}>
              <option value="30">In 30 days</option>
              <option value="90">In 90 days</option>
              <option value="365">In 1 year</option>
              <option value="never">Never</option>
            </select>
          </label>
          <input
            type="password"
            placeholder="Confirm your password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          {user.mfaEnabled && (
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
          )}
          <div className="row">
            <button>Create key</button>
            <button type="button" className="secondary" onClick={() => setCreating(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        !created && (
          <button type="button" onClick={() => (setCreating(true), setError(null))}>
            New key
          </button>
        )
      )}
      {error && <p className="error">{error}</p>}
    </section>
  );
}
