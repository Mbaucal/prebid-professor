import { useEffect, useState } from 'react';

type Status = {
  ok: true;
  configured: boolean;
  missingSecrets: string[];
  connected: boolean;
  account: null | {
    email: string;
    connectedBy: string | null;
    connectedAt: string;
    updatedAt: string;
  };
};

type Props = {
  onConnectionChange?: (connected: boolean, email: string | null) => void;
};

export default function GmailConnectionPanel({ onConnectionChange }: Props) {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function load(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/integrations/gmail/status?ts=${Date.now()}`, { credentials: 'same-origin', cache: 'no-store' });
      const payload = await response.json() as Status & { error?: string; details?: unknown };
      if (!response.ok || !payload.ok) throw new Error(payload.error || 'Gmail status could not be loaded.');
      setStatus(payload);
      onConnectionChange?.(payload.connected, payload.account?.email ?? null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Gmail status could not be loaded.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  async function disconnect(): Promise<void> {
    if (!window.confirm('Disconnect the Gmail account from Tessera?')) return;
    const response = await fetch('/api/integrations/gmail/disconnect', { method: 'POST', credentials: 'same-origin' });
    const payload = await response.json() as { ok?: boolean; error?: string };
    if (!response.ok || !payload.ok) {
      setError(payload.error || 'Gmail could not be disconnected.');
      return;
    }
    await load();
  }

  return (
    <section className="gmail-connection-panel">
      <div className="gmail-connection-heading">
        <div>
          <span className="panel-kicker">Email provider</span>
          <h4>Gmail API</h4>
        </div>
        <span className={`monitor-readonly-pill ${status?.connected ? 'healthy' : 'warning'}`}>
          {status?.connected ? 'CONNECTED' : 'DISCONNECTED'}
        </span>
      </div>

      {loading ? <div className="config-loading">Checking Gmail connection…</div> : null}
      {error ? <div className="form-error">{error}</div> : null}

      {status && !status.configured ? (
        <div className="monitor-test-send-note">
          Missing Cloudflare secrets: {status.missingSecrets.join(', ')}
        </div>
      ) : null}

      {status?.connected && status.account ? (
        <>
          <div className="gmail-account-card">
            <span>Connected account</span>
            <strong>{status.account.email}</strong>
            <small>Connected {new Date(status.account.connectedAt).toLocaleString()}</small>
          </div>
          <button className="button secondary" onClick={() => void disconnect()} type="button">Disconnect Gmail</button>
        </>
      ) : status?.configured ? (
        <a className="button primary gmail-connect-button" href="/api/integrations/gmail/connect">Connect Gmail</a>
      ) : null}
    </section>
  );
}
