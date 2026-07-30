import { useState } from 'react';

const DEVELOPER_BRIEF = `Subject: Ads.txt CMS/API endpoint integration for Tessera

We need a restricted API endpoint that lets Tessera publish one explicitly approved complete ads.txt version.

Please confirm/provide:
1. How ads.txt is currently generated and which system is its source of truth.
2. Staging endpoint URL and production endpoint URL.
3. HTTP method accepted for publication (preferably PUT or POST).
4. Authentication method: restricted Bearer token or HMAC signature.
5. Whether IP allowlisting is required.
6. Maximum request size and timeout limit.
7. Whether the endpoint accepts the complete ads.txt body plus version metadata.
8. Expected success and error response formats.
9. How cache purge works after publication.
10. Public ads.txt URL Tessera should verify after publishing.
11. Rollback method, or confirmation that an earlier full-file version can be published again.
12. A technical contact for staging verification.

Tessera sends:
- siteId
- domain
- immutable versionId
- SHA-256 checksum
- complete ads.txt content
- publication timestamp

Expected success response:
{
  "ok": true,
  "versionId": "same-version-id",
  "checksum": "same-sha256-checksum"
}

Tessera does not need access to the full CMS, hosting account, or server. The credential should be limited only to reading/replacing ads.txt.`;

const REQUEST_EXAMPLE = `POST https://cms.publisher.com/integrations/ads-txt
Authorization: Bearer <restricted-token>
Content-Type: application/json

{
  "siteId": "magazin-politika-rs",
  "domain": "magazin.politika.rs",
  "versionId": "ads-magazin-politika-rs-0007",
  "checksum": "<sha256>",
  "content": "# Google\\ngoogle.com, pub-123, DIRECT, ...\\n",
  "publishedAt": "2026-07-30T14:00:00.000Z"
}`;

const RESPONSE_EXAMPLE = `HTTP 200
Content-Type: application/json

{
  "ok": true,
  "versionId": "ads-magazin-politika-rs-0007",
  "checksum": "<same-sha256>"
}`;

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
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function copy(value: string, key: string): Promise<void> {
    setError(null);
    try {
      await copyText(value);
      setCopied(key);
      window.setTimeout(() => setCopied((current) => (current === key ? null : current)), 1800);
    } catch (copyError) {
      setError(copyError instanceof Error ? copyError.message : 'Clipboard access was blocked.');
    }
  }

  return (
    <article className="admin-helper-card ads-txt-admin-guide">
      <div className="admin-helper-card-heading">
        <div>
          <span className="panel-kicker">Publisher integration</span>
          <h3>Ads.txt CMS/API endpoint</h3>
        </div>
        <button onClick={() => void copy(DEVELOPER_BRIEF, 'brief')} type="button">
          {copied === 'brief' ? '✓ Brief copied' : 'Copy developer brief'}
        </button>
      </div>

      <p>
        This connector lets Tessera send one approved complete ads.txt file to a publisher CMS, then check the
        public ads.txt URL to confirm that the same version was actually published.
      </p>

      <div className="ads-txt-admin-flow" aria-label="Ads.txt API publishing flow">
        <div><span>1</span><strong>Prepare</strong><small>Tessera creates an immutable version and SHA-256 fingerprint.</small></div>
        <div><span>2</span><strong>Publish</strong><small>The full file and version metadata are sent to the restricted CMS endpoint.</small></div>
        <div><span>3</span><strong>Verify</strong><small>Tessera reads the public ads.txt and compares its checksum.</small></div>
        <div><span>4</span><strong>Rollback</strong><small>An earlier approved full-file version can be restored if needed.</small></div>
      </div>

      <div className="admin-helper-notice reuse">
        <strong>We do not need full CMS or server access.</strong>
        <span>The publisher should provide a credential restricted only to the ads.txt resource. Credentials must be exchanged through a secure channel, never pasted into email, GitHub, logs, or frontend fields.</span>
      </div>

      {error ? <div className="admin-helper-error ads-txt-admin-guide-error">{error}</div> : null}

      <div className="ads-txt-admin-guide-grid">
        <section>
          <h4>What to ask the publisher developer</h4>
          <ol className="admin-helper-checklist">
            <li>How is ads.txt currently generated, and which system is the source of truth?</li>
            <li>What are the staging and production endpoint URLs?</li>
            <li>Which HTTP method should Tessera use: <code>PUT</code> or <code>POST</code>?</li>
            <li>Do they support a restricted Bearer token or HMAC signature?</li>
            <li>Do they require IP allowlisting, a custom header, or a specific timeout?</li>
            <li>Can the endpoint accept the complete file plus version ID and SHA-256 checksum?</li>
            <li>What exact JSON indicates success, validation failure, authentication failure, or server failure?</li>
            <li>How is CDN/CMS cache purged after publication?</li>
            <li>Which public ads.txt URL should Tessera verify?</li>
            <li>Can an earlier complete version be submitted again for rollback?</li>
          </ol>
        </section>

        <section>
          <h4>What Tessera needs before connection</h4>
          <dl className="ads-txt-admin-data-list">
            <div><dt>Endpoint</dt><dd>Staging first, then production.</dd></div>
            <div><dt>Authentication</dt><dd>Restricted token/HMAC and the required header format.</dd></div>
            <div><dt>Request contract</dt><dd>Accepted fields, maximum payload, and timeout.</dd></div>
            <div><dt>Response contract</dt><dd>Returned version ID, checksum, and error structure.</dd></div>
            <div><dt>Verification URL</dt><dd>The public URL that must contain the published file.</dd></div>
            <div><dt>Cache and rollback</dt><dd>Purge behavior and restoration procedure.</dd></div>
          </dl>
        </section>
      </div>

      <details className="ads-txt-admin-contract" open>
        <summary>Example request sent by Tessera</summary>
        <pre>{REQUEST_EXAMPLE}</pre>
        <button onClick={() => void copy(REQUEST_EXAMPLE, 'request')} type="button">
          {copied === 'request' ? '✓ Copied' : 'Copy request example'}
        </button>
      </details>

      <details className="ads-txt-admin-contract">
        <summary>Expected successful response</summary>
        <pre>{RESPONSE_EXAMPLE}</pre>
        <button onClick={() => void copy(RESPONSE_EXAMPLE, 'response')} type="button">
          {copied === 'response' ? '✓ Copied' : 'Copy response example'}
        </button>
      </details>
    </article>
  );
}
