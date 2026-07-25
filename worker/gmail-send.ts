import { apiError, json, readJson } from './http';
import type { GmailOAuthEnv } from './gmail-oauth';
import { decryptToken, getStoredGmailConnection } from './gmail-oauth';

export type GmailMessageInput = {
  senderName?: unknown;
  to?: unknown;
  cc?: unknown;
  replyTo?: unknown;
  subject?: unknown;
  body?: unknown;
  bodyFormat?: unknown;
  attachmentName?: unknown;
  attachmentContent?: unknown;
};

export type NormalizedGmailMessage = {
  senderName: string;
  to: string[];
  cc: string[];
  replyTo: string;
  subject: string;
  body: string;
  bodyFormat: 'plain' | 'html';
  attachmentName: string;
  attachmentContent: string;
};

export type GmailSendResult = {
  messageId: string;
  threadId: string | null;
  from: string;
  to: string[];
  cc: string[];
  sentAt: string;
};

const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;
const MAX_RECIPIENTS = 50;

function validEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function list(value: unknown): string[] {
  const source = Array.isArray(value) ? value.map(String).join('\n') : String(value ?? '');
  const seen = new Set<string>();
  const output: string[] = [];
  for (const candidate of source.split(/[;,\n]+/)) {
    const email = candidate.trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    output.push(email);
  }
  return output;
}

function safeFileName(value: unknown): string {
  const cleaned = String(value ?? '')
    .trim()
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/\.+$/g, '')
    .slice(0, 180);
  const base = cleaned || 'ads.txt';
  return base.toLowerCase().endsWith('.txt') ? base : `${base}.txt`;
}

function normalizeMessage(value: unknown): { message: NormalizedGmailMessage; errors: string[] } {
  const input = value && typeof value === 'object' && !Array.isArray(value)
    ? value as GmailMessageInput
    : {};
  const message: NormalizedGmailMessage = {
    senderName: String(input.senderName ?? '').trim().slice(0, 120),
    to: list(input.to),
    cc: list(input.cc),
    replyTo: String(input.replyTo ?? '').trim().toLowerCase().slice(0, 254),
    subject: String(input.subject ?? '').trim().slice(0, 500),
    body: String(input.body ?? '').slice(0, 100_000),
    bodyFormat: input.bodyFormat === 'html' ? 'html' : 'plain',
    attachmentName: safeFileName(input.attachmentName),
    attachmentContent: String(input.attachmentContent ?? ''),
  };
  const errors: string[] = [];
  if (!message.to.length) errors.push('At least one recipient is required.');
  for (const email of [...message.to, ...message.cc]) {
    if (!validEmail(email)) errors.push(`Recipient email is not valid: ${email}`);
  }
  if (message.replyTo && !validEmail(message.replyTo)) errors.push('Reply-To email is not valid.');
  if (message.to.length + message.cc.length > MAX_RECIPIENTS) {
    errors.push(`To and CC may contain at most ${MAX_RECIPIENTS} recipients combined.`);
  }
  if (!message.subject) errors.push('Subject is required.');
  if (!message.body.trim()) errors.push('Email body is required.');
  if (new TextEncoder().encode(message.attachmentContent).byteLength > MAX_ATTACHMENT_BYTES) {
    errors.push('The ads.txt attachment is larger than 2 MB.');
  }
  return { message, errors: Array.from(new Set(errors)) };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function encodeBase64Url(value: string): string {
  return bytesToBase64(new TextEncoder().encode(value))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function attachmentBase64(value: string): string {
  return bytesToBase64(new TextEncoder().encode(value)).replace(/(.{76})/g, '$1\r\n');
}

function headerValue(value: string): string {
  if (!value) return '';
  return /^[\x20-\x7E]*$/.test(value)
    ? value
    : `=?UTF-8?B?${bytesToBase64(new TextEncoder().encode(value))}?=`;
}

function mimeMessage(fromEmail: string, message: NormalizedGmailMessage): string {
  const filename = message.attachmentName.replace(/["\r\n]/g, '-');
  const boundary = `tessera_${crypto.randomUUID()}`;
  const fromHeader = message.senderName
    ? `${headerValue(message.senderName)} <${fromEmail}>`
    : fromEmail;
  const headers = [
    `From: ${fromHeader}`,
    `To: ${message.to.join(', ')}`,
    ...(message.cc.length ? [`Cc: ${message.cc.join(', ')}`] : []),
    ...(message.replyTo ? [`Reply-To: ${message.replyTo}`] : []),
    `Subject: ${headerValue(message.subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
  ];
  return [
    ...headers,
    `--${boundary}`,
    `Content-Type: ${message.bodyFormat === 'html' ? 'text/html' : 'text/plain'}; charset="UTF-8"`,
    'Content-Transfer-Encoding: 8bit',
    '',
    message.body,
    '',
    `--${boundary}`,
    `Content-Type: text/plain; charset="UTF-8"; name="${filename}"`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment; filename="${filename}"`,
    '',
    attachmentBase64(message.attachmentContent),
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
  if (!response.ok || !payload.access_token) {
    throw new Error(payload.error_description || payload.error || 'Google access token refresh failed.');
  }
  return payload.access_token;
}

export async function sendGmailMessage(
  env: GmailOAuthEnv,
  value: unknown,
): Promise<GmailSendResult> {
  const connection = await getStoredGmailConnection(env);
  if (!connection) throw new Error('Gmail is not connected.');
  if (!env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET || !env.GMAIL_TOKEN_ENCRYPTION_KEY) {
    throw new Error('Gmail OAuth secrets are not configured.');
  }
  const { message, errors } = normalizeMessage(value);
  if (errors.length) throw new Error(errors.join(' '));
  const token = await accessToken(env, connection.refresh_token_encrypted);
  const raw = encodeBase64Url(mimeMessage(connection.email, message));
  const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ raw }),
  });
  const payload = await response.json() as { id?: string; threadId?: string; error?: unknown };
  if (!response.ok || !payload.id) {
    const detail = payload.error ? JSON.stringify(payload.error) : `HTTP ${response.status}`;
    throw new Error(`Gmail API rejected the email. ${detail}`);
  }
  return {
    messageId: payload.id,
    threadId: payload.threadId ?? null,
    from: connection.email,
    to: message.to,
    cc: message.cc,
    sentAt: new Date().toISOString(),
  };
}

export async function sendGmailTest(request: Request, env: GmailOAuthEnv): Promise<Response> {
  let body: { message?: unknown };
  try {
    body = await readJson<{ message?: unknown }>(request);
  } catch (error) {
    return apiError('Gmail test email JSON could not be read.', 400, error instanceof Error ? error.message : String(error));
  }
  try {
    const result = await sendGmailMessage(env, body.message ?? {});
    return json({ ok: true, provider: 'gmail', ...result });
  } catch (error) {
    return apiError('Gmail test email could not be sent.', 502, error instanceof Error ? error.message : String(error));
  }
}
