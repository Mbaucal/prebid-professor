import { useState } from 'react';

type BodyFormat = 'plain' | 'html';

type Props = {
  siteId: string;
  emailConfigured: boolean;
  senderName: string;
  senderEmail: string;
  replyTo: string;
  to: string;
  cc: string;
  subject: string;
  body: string;
  bodyFormat: BodyFormat;
  attachmentName: string;
  attachmentContent: string;
  previewReady: boolean;
};

type SendResponse = {
  ok: true;
  mode: 'manual-test';
  messageId: string;
  sentAt: string;
  recipients: string[];
  cc: string[];
  attachmentName: string;
};

type FailurePayload = {
  error?: string;
  details?: unknown;
};

function detailText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export default function MonitoringEmailSendTest(props: Props) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function sendTest(): Promise<void> {
    if (!props.previewReady || !props.emailConfigured || sending) return;
    const recipients = props.to.trim() || 'the configured recipient';
    const confirmed = window.confirm(
      `Send a real test email to ${recipients}?\n\nThis sends the rendered preview and the ads.txt attachment.`,
    );
    if (!confirmed) return;

    setSending(true);
    setError(null);
    setSuccess(null);
    try {
      const response = await fetch(
        `/api/publishers/${encodeURIComponent(props.siteId)}/monitoring/gmail-send-test`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: JSON.stringify({
            message: {
              senderName: props.senderName,
              senderEmail: props.senderEmail,
              replyTo: props.replyTo,
              to: props.to,
              cc: props.cc,
              subject: props.subject,
              body: props.body,
              bodyFormat: props.bodyFormat,
              attachmentName: props.attachmentName,
              attachmentContent: props.attachmentContent,
            },
          }),
        },
      );
      const text = await response.text();
      let payload: (SendResponse & FailurePayload) | null = null;
      try {
        payload = text ? JSON.parse(text) as SendResponse & FailurePayload : null;
      } catch {
        throw new Error(text || `Test email request failed with status ${response.status}.`);
      }
      if (!response.ok || !payload?.ok) {
        const details = detailText(payload?.details);
        throw new Error(`${payload?.error || `Test email request failed with status ${response.status}.`}${details ? ` ${details}` : ''}`);
      }
      setSuccess(`Test email sent · ${payload.messageId}`);
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : 'Test email could not be sent.');
    } finally {
      setSending(false);
    }
  }

  const disabledReason = !props.emailConfigured
    ? 'Cloudflare EMAIL binding is not configured on this preview.'
    : !props.previewReady
      ? 'Generate the email and attachment preview first.'
      : null;

  return (
    <section className="monitor-test-send">
      <div className="monitor-test-send-heading">
        <div>
          <span className="panel-kicker">Manual delivery test</span>
          <h4>Send the rendered preview</h4>
        </div>
        <span className={`monitor-readonly-pill ${props.emailConfigured ? 'healthy' : 'warning'}`}>
          {props.emailConfigured ? 'EMAIL BINDING READY' : 'EMAIL BINDING MISSING'}
        </span>
      </div>
      <p>
        This sends one real test message with the generated ads.txt attachment. It does not enable schedules,
        reminders, recovery messages or automatic delivery.
      </p>
      {disabledReason ? <div className="monitor-test-send-note">{disabledReason}</div> : null}
      {error ? <div className="form-error monitor-test-send-message">{error}</div> : null}
      {success ? <div className="release-success monitor-test-send-message">✓ {success}</div> : null}
      <button
        className="button primary"
        disabled={Boolean(disabledReason) || sending}
        onClick={() => void sendTest()}
        type="button"
      >
        {sending ? 'Sending test…' : 'Send test email'}
      </button>
    </section>
  );
}
