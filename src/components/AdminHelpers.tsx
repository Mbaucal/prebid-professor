import { useEffect, useMemo, useState } from 'react';
import AdsTxtConnectorAdminGuide from './AdsTxtConnectorAdminGuide';

type Props = {
  open: boolean;
  onClose: () => void;
  adminEmail?: string | null;
};

const RANDOM_SECRET_SNIPPET = `Array.from(
  crypto.getRandomValues(new Uint8Array(48)),
  byte => byte.toString(16).padStart(2, '0')
).join('')`;

const LOCAL_PAGES_DEPLOY_SNIPPET = `CLOUDFLARE_API_TOKEN="PASTE_TOKEN_LOCALLY" \\
CLOUDFLARE_ACCOUNT_ID="TARGET_ACCOUNT_ID" \\
npx wrangler pages deploy . --project-name=PROJECT_NAME`;

function secretNameFromLabel(value: string): string {
  const suffix = value
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);

  return `CLOUDFLARE_API_TOKEN_${suffix || 'NEW_ACCOUNT'}`;
}

function makeRandomSecret(): string {
  return Array.from(
    globalThis.crypto.getRandomValues(new Uint8Array(48)),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
}

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
}

export default function AdminHelpers({ open, onClose, adminEmail }: Props) {
  const [label, setLabel] = useState('Politika');
  const [randomSecret, setRandomSecret] = useState('');
  const [copied, setCopied] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);

  const suggestedSecretName = useMemo(() => secretNameFromLabel(label), [label]);

  useEffect(() => {
    if (!open) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose, open]);

  if (!open) return null;

  async function handleCopy(value: string, key: string) {
    setCopyError(null);
    try {
      await copyText(value);
      setCopied(key);
      window.setTimeout(() => setCopied((current) => (current === key ? null : current)), 1800);
    } catch (error) {
      setCopyError(error instanceof Error ? error.message : 'Clipboard access was blocked.');
    }
  }

  function generateSecret() {
    setRandomSecret(makeRandomSecret());
    setCopied(null);
    setCopyError(null);
  }

  return (
    <div className="admin-helper-backdrop" onMouseDown={onClose} role="presentation">
      <section
        aria-labelledby="admin-helper-title"
        aria-modal="true"
        className="admin-helper-modal"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        <header className="admin-helper-heading">
          <div>
            <span className="panel-kicker">Operations library</span>
            <h2 id="admin-helper-title">Admin helpers</h2>
            <p>Deployment, security and publisher-integration checklists with safe copyable examples.</p>
          </div>
          <button aria-label="Close helpers" className="admin-helper-close" onClick={onClose} type="button">×</button>
        </header>

        {copyError ? <div className="admin-helper-error">{copyError}</div> : null}

        <div className="admin-helper-grid">
          <AdsTxtConnectorAdminGuide />

          <article className="admin-helper-card token-card">
            <div className="admin-helper-card-heading">
              <div>
                <span className="panel-kicker">New destination</span>
                <h3>Cloudflare Pages API token</h3>
              </div>
              <a href="https://dash.cloudflare.com/profile/api-tokens" rel="noreferrer" target="_blank">
                Open Cloudflare ↗
              </a>
            </div>

            <div className="admin-helper-notice important">
              <strong>Do not generate or paste the Cloudflare API token in this dashboard.</strong>
              <span>Create it inside the target Cloudflare account, then store only its value as a GitHub Actions repository secret.</span>
            </div>

            <label className="admin-helper-field">
              <span>Cloudflare account / publisher label</span>
              <input onChange={(event) => setLabel(event.target.value)} placeholder="Politika" value={label} />
              <small>Use the account or publisher name only to produce a consistent GitHub secret name.</small>
            </label>

            <div className="admin-helper-copy-row">
              <code>{suggestedSecretName}</code>
              <button onClick={() => void handleCopy(suggestedSecretName, 'secret-name')} type="button">
                {copied === 'secret-name' ? '✓ Copied' : 'Copy name'}
              </button>
            </div>

            <ol className="admin-helper-checklist">
              <li>Create a custom API token in the <strong>target Cloudflare account</strong>.</li>
              <li>Grant only the Pages write/edit permission needed for that account.</li>
              <li>Add the token value in GitHub: <strong>Repository → Settings → Secrets and variables → Actions</strong>.</li>
              <li>Name the GitHub secret <code>{suggestedSecretName}</code>.</li>
              <li>Use the same secret name in the site's Deployment Target.</li>
            </ol>

            <div className="admin-helper-notice reuse">
              <strong>One token is not required for every site.</strong>
              <span>If several Pages projects live in the same Cloudflare account and share the same permission scope, they may reuse one account-scoped token. Create a new token for another Cloudflare account or when you want stricter isolation.</span>
            </div>
          </article>

          <article className="admin-helper-card">
            <div className="admin-helper-card-heading">
              <div>
                <span className="panel-kicker">Console helper</span>
                <h3>Generate a random secret</h3>
              </div>
            </div>
            <p>Use this for <code>SESSION_SECRET</code> or <code>DEPLOY_CALLBACK_SECRET</code>. It does not create a Cloudflare API token.</p>
            <pre>{RANDOM_SECRET_SNIPPET}</pre>
            <div className="admin-helper-actions">
              <button onClick={() => void handleCopy(RANDOM_SECRET_SNIPPET, 'random-snippet')} type="button">
                {copied === 'random-snippet' ? '✓ Copied' : 'Copy console snippet'}
              </button>
              <button className="primary" onClick={generateSecret} type="button">Generate here</button>
            </div>
            {randomSecret ? (
              <div className="admin-helper-generated">
                <code>{randomSecret}</code>
                <button onClick={() => void handleCopy(randomSecret, 'generated-secret')} type="button">
                  {copied === 'generated-secret' ? '✓' : 'Copy'}
                </button>
              </div>
            ) : null}
          </article>

          <article className="admin-helper-card">
            <div className="admin-helper-card-heading">
              <div>
                <span className="panel-kicker">Local fallback</span>
                <h3>Wrangler Pages deploy</h3>
              </div>
            </div>
            <p>Use this only in your own terminal. Replace placeholders locally and never save the token in source control or shell scripts.</p>
            <pre>{LOCAL_PAGES_DEPLOY_SNIPPET}</pre>
            <div className="admin-helper-actions">
              <button onClick={() => void handleCopy(LOCAL_PAGES_DEPLOY_SNIPPET, 'deploy-snippet')} type="button">
                {copied === 'deploy-snippet' ? '✓ Copied' : 'Copy command'}
              </button>
            </div>
          </article>

          <article className="admin-helper-card compact-card">
            <span className="panel-kicker">Signed-in administrator</span>
            <h3>{adminEmail ?? 'Admin session'}</h3>
            <p>Secrets generated here remain only in this browser tab until copied. They are not sent to D1, R2 or the Worker API.</p>
          </article>
        </div>
      </section>
    </div>
  );
}
