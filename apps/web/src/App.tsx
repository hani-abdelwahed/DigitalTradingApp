import { useEffect, useState } from 'react';
import type { PublicUser } from '@dta/shared';
import { api, refreshSession } from './api';
import { AuthPage } from './pages/AuthPage';
import { Dashboard } from './pages/Dashboard';

export function App() {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    refreshSession()
      .then((t) => setUser(t?.user ?? null))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="center muted">Loading…</div>;
  if (!user) return <AuthPage onSignedIn={setUser} />;
  return (
    <Dashboard
      user={user}
      onUserChange={setUser}
      onSignOut={async () => {
        await api.logout().catch(() => undefined);
        setUser(null);
      }}
    />
  );
}
