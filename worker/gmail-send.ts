import { apiError, json, readJson } from './http';
import type { GmailOAuthEnv } from './gmail-oauth';
import { decryptToken, getStoredGmailConnection } from './gmail-oauth';

type MessageInput = {
  to?: unknown;
  cc?: unknown;
  replyTo?: unknown;
  subject?: unknown;
  body?: unknown;
  bodyFormat?: unknown;
  attachmentName?: unknown;
  attachmentContent?: unknown;
};

function list(value: unknown): string[] {
  return String(value ?? '').split(/[;,\n]+/).map((v) => v.trim().toLowerCase()).filter(Boolean);
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function attachmentBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replace(/(.{76})/g, '$1\r\n');
}

function mimeMessage(from: string, message: MessageInput): string {
  const to = list(message.to);
  const cc = list(message.cc);
  const subject = String(message.subject ?? '').trim();
  const body = String(message.body ?? '');
  const replyTo = String(message.replyTo ?? '').trim();
  const filename = String(message.attachmentName ?? 'ads.txt').replace(/["\r\n]/g, '-');
  const content = String(message.attachmentContent ?? '');
  const html = message.bodyFormat === 'html';
  const boundary = `tessera_${crypto.randomUUID()}`;
  const headers = [
    `From: ${from}`,
    `To: ${to.join(', ')}`,
    ...(cc.length ? [`Cc: ${cc.join(', ')}`] : []),
    ...(replyTo ? [`Reply-To: ${replyTo}`] : []),
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
  ];
  return [
    ...headers,
    `--${boundary}`,
    `Content-Type: ${html ? 'text/html' : 'text/plain'}; charset="UTF-8"`,
    'Content-Transfer-Encoding: 8bit',
    '',
    body,
    '',
    `--${boundary}`,
    `Content-Type: text/plain; charset="UTF-8"; name="${filename}"`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment; filename="${filename}"`,
    '',
    attachmentBase64(content),
    '',
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

async function accessToken(env: GmailOAuthEnv, encryptedRefreshToken: string): Promise<string> {
  const refreshToken = await decryptToken(env.GMAIL_TOKEN_ENCRYPTION_KEY!, encryptedRefreshToken);
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_OAUTH_CLIENT_ID!,
      client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET!,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const payload = await response.json() as { access_token?: string; error?: string; error_description?: string };
  if (!response.ok || !payload.access_token) throw new Error(payload.error_description || payload.error || 'Google access token refresh failed.');
  return payload.access_token;
}

export async function sendGmailTest(request: Request, env: GmailOAuthEnv): Promise<Response> {
  const connection = await getStoredGmailConnection(env);
  if (!connection) return apiError('Gmail is not connected.', 503);
  if (!env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET || !env.GMAIL_TOKEN_ENCRYPTION_KEY) {
    return apiError('Gmail OAuth secrets are not configured.', 503);
  }
  let body: { message?: MessageInput };
  try {
    body = await readJson<{ message?: MessageInput }>(request);
  } catch (error) {
    return apiError('Gmail test email JSON could not be read.', 400, error instanceof Error ? error.message : String(error));
  }
  const message = body.message ?? {};
  const to = list(message.to);
  const subject = String(message.subject ?? '').trim();
  const content = String(message.body ?? '').trim();
  if (!to.length || !subject || !content) return apiError('Recipient, subject and body are required.', 422);
  try {
    const token = await accessToken(env, connection.refresh_token_encrypted);
    const raw = encodeBase64Url(mimeMessage(connection.email, message));
    const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ raw }),
    });
    const payload = await response.json() as { id?: string; threadId?: string; error?: unknown };
    if (!response.ok || !payload.id) return apiError('Gmail API rejected the email.', 502, payload.error ?? payload);
    return json({ ok: true, provider: 'gmail', messageId: payload.id, threadId: payload.threadId ?? null, from: connection.email, sentAt: new Date().toISOString() });
  } catch (error) {
    return apiError('Gmail test email could not be sent.', 502, error instanceof Error ? error.message : String(error));
  }
}
