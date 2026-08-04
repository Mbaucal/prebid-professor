import { useState } from 'react';

const DEVELOPER_MESSAGE = `Subject: Ads.txt API connection

Hello,

We would like to connect our ads.txt management platform to your CMS.

Please send us:
1. The endpoint URL that accepts the complete ads.txt file.
2. Whether the endpoint uses POST or PUT.
3. The authorization type and required header name, for example Bearer token or API key.
4. The access token/API key through a secure channel.

A successful update should return HTTP 200 or 204.

We do not need access to the CMS admin panel, hosting account or server.`;

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

export default function AdsTxtConnectorAdminGuide() {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function copyDeveloperMessage(): Promise<void> {
    setError(null);
    try {
      await copyText(DEVELOPER_MESSAGE);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch (copyError) {
      setError(copyError instanceof Error ? copyError.message : 'Clipboard access was blocked.');
    }
  }

  return (
    <article className="admin-helper-card ads-txt-admin-guide">
      <div className="admin-helper-card-heading">
        <div>
          <span className="panel-kicker">Publisher integration</span>
          <h3>Ads.txt CMS connection</h3>
        </div>
        <button onClick={() => void copyDeveloperMessage()} type="button">
          {copied ? '✓ Message copied' : 'Copy message for developer'}
        </button>
      </div>

      <p>
        The developer sends the connection details. Enter them under
        <strong> Publisher → Site → Ads.txt → CMS connection</strong>.
      </p>

      <div className="ads-txt-simple-requirements">
        <div>
          <span>1</span>
          <strong>Endpoint URL</strong>
          <small>The address where Tessera will send the complete ads.txt file.</small>
        </div>
        <div>
          <span>2</span>
          <strong>POST or PUT</strong>
          <small>Select the method specified by the developer.</small>
        </div>
        <div>
          <span>3</span>
          <strong>Authorization</strong>
          <small>Enter the Bearer token or API key and its header name.</small>
        </div>
      </div>

      {error ? <div className="admin-helper-error ads-txt-admin-guide-error">{error}</div> : null}
    </article>
  );
}
