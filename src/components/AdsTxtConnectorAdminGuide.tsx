import { useState } from 'react';

const DEVELOPER_MESSAGE = `Subject: Ads.txt API connection

Hello,

We want to connect Tessera to your CMS so it can replace the complete ads.txt file.

Please send us:
1. The API endpoint URL that accepts and replaces the complete ads.txt file.
2. Whether the endpoint uses POST or PUT.
3. The authorization method and header name, for example Bearer token or API key.
4. Confirmation that a successful update returns HTTP 200 or 204.

If you have a staging endpoint, please send it as well.

We do not need access to your CMS admin panel, hosting account, or server. The access credential should be limited only to ads.txt updates. Please send the credential through a secure channel, not by email.`;

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
        The setup should be simple. Ask the publisher developer for the three connection details below.
        Tessera handles the ads.txt file, verification and rollback internally.
      </p>

      <div className="ads-txt-simple-requirements">
        <div>
          <span>1</span>
          <strong>Endpoint URL</strong>
          <small>A URL that accepts and replaces the complete ads.txt file.</small>
        </div>
        <div>
          <span>2</span>
          <strong>POST or PUT</strong>
          <small>The HTTP method their endpoint expects.</small>
        </div>
        <div>
          <span>3</span>
          <strong>Authorization</strong>
          <small>Bearer token or API key, including the required header name.</small>
        </div>
      </div>

      <div className="admin-helper-notice important">
        <strong>Do not ask them for the public ads.txt URL.</strong>
        <span>Tessera already knows it from the site's Ads.txt URL field in the platform.</span>
      </div>

      <div className="admin-helper-notice reuse">
        <strong>You do not need to discuss checksums, JSON formats, cache purge or rollback.</strong>
        <span>
          Tessera will send the complete file, treat a successful HTTP 200/204 response as accepted,
          verify the configured live ads.txt URL, and restore an earlier version by sending that complete file again.
          If their endpoint has a special requirement, their developer can tell us.
        </span>
      </div>

      <div className="ads-txt-simple-example">
        <span>Example of the information we need</span>
        <code>Endpoint: https://cms.publisher.com/api/ads-txt</code>
        <code>Method: PUT</code>
        <code>Authorization: Authorization: Bearer &lt;token&gt;</code>
        <code>Success: HTTP 200 or 204</code>
      </div>

      {error ? <div className="admin-helper-error ads-txt-admin-guide-error">{error}</div> : null}
    </article>
  );
}
