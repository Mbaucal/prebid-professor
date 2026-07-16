import { useEffect, useMemo, useState } from 'react';
import AdminHelpers from './AdminHelpers';

type AuthUser = {
  email: string;
};

type AuthResponse = {
  ok: true;
  user: AuthUser;
};

export default function AuthAccount() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const [helpersOpen, setHelpersOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;

    fetch('/api/auth/me', {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    })
      .then(async (response) => {
        if (response.status === 401) {
          window.location.replace('/login');
          return null;
        }
        if (!response.ok) throw new Error(`Session check returned ${response.status}.`);
        return (await response.json()) as AuthResponse;
      })
      .then((payload) => {
        if (!cancelled && payload) setUser(payload.user);
      })
      .catch((requestError: unknown) => {
        if (!cancelled) {
          setError(requestError instanceof Error ? requestError.message : 'Session could not be read.');
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const initial = useMemo(() => (user?.email.trim().charAt(0) || 'A').toUpperCase(), [user]);

  async function logout() {
    setLoggingOut(true);
    setError(null);
    try {
      const response = await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      });
      if (!response.ok && response.status !== 204) {
        throw new Error(`Logout returned ${response.status}.`);
      }
      window.location.assign('/login');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Logout failed.');
      setLoggingOut(false);
    }
  }

  return (
    <>
      <aside className="auth-account-card" aria-label="Signed-in administrator">
        <div className="auth-account-avatar">{initial}</div>
        <button
          className="auth-account-identity"
          onClick={() => setHelpersOpen(true)}
          title="Open admin helpers"
          type="button"
        >
          <span>{user?.email ?? (error ? 'Session error' : 'Loading admin…')}</span>
          <small>{error ?? 'admin · signed session'}</small>
        </button>
        <button onClick={() => setHelpersOpen(true)} title="Admin helpers" type="button">?</button>
        <button disabled={loggingOut} onClick={() => void logout()} title="Sign out" type="button">
          {loggingOut ? '…' : '↪'}
        </button>
      </aside>

      <AdminHelpers adminEmail={user?.email} onClose={() => setHelpersOpen(false)} open={helpersOpen} />
    </>
  );
}
