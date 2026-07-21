import { apiError, getActor, json, readJson } from './http';
import type { DatabaseEnv } from './publishers';

export type EmailAddress = {
  email: string;
  name?: string;
};

export type EmailSendResult = {
  messageId: string;
};

export type EmailBinding = {
  send(message: {
    to: string | EmailAddress | Array<string | EmailAddress>;
    from: string | EmailAddress;
    subject: string;
    text?: string;
    html?: string;
    cc?: string | EmailAddress | Array<string | EmailAddress>;
    replyTo?: string | EmailAddress;
    attachments?: Array<{
      content: string | ArrayBuffer | ArrayBufferView;
      filename: string;
      type: string;
      disposition: 'attachment' | 'inline';
      contentId?: string;
    }>;
    headers?: Record<string, string>;
  }): Promise<EmailSendResult>;
};

export interface MonitoringEmailSendEnv extends DatabaseEnv {
  EMAIL?: EmailBinding;
}

type MessageInput = {
  senderName?: unknown;
  senderEmail?: unknown;
  replyTo?: unknown;
  to?: unknown;
  cc?: unknown;
  subject?: unknown;
  body?: unknown;
  bodyFormat?: unknown;
  attachmentName?: unknown;
  attachmentContent?: unknown;
};

type NormalizedMessage = {
  senderName: string;
  senderEmail: string;
  replyTo: string;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  bodyFormat: 'plain' | 'html';
  attachmentName: string;
  attachmentContent: string;
};

const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;
const MAX_RECIPIENTS = 50;

function text(value: unknown, maxLength: number): string {
  return String(value ?? '').trim().slice(0, maxLength);
}

function validEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function addresses(value: unknown): string[] {
  const source = Array.isArray(value) ? value.map(String).join('\n') : String(value ?? '');
  const seen = new Set<string>();
  const result: string[] = [];
  for (const candidate of source.split(/[;,\n]+/)) {
    const email = candidate.trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    result.push(email);
  }
  return result;
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

function normalizeMessage(value: unknown): { message: NormalizedMessage; errors: string[] } {
  const input = value && typeof value === 'object' && !Array.isArray(value)
    ? value as MessageInput
    : {};
  const message: NormalizedMessage = {
    senderName: text(input.senderName, 120),
    senderEmail: text(input.senderEmail, 254).toLowerCase(),
    replyTo: text(input.replyTo, 254).toLowerCase(),
    to: addresses(input.to),
    cc: addresses(input.cc),
    subject: text(input.subject, 500),
    body: text(input.body, 100_000),
    bodyFormat: input.bodyFormat === 'html' ? 'html' : 'plain',
    attachmentName: safeFileName(input.attachmentName),
    attachmentContent: String(input.attachmentContent ?? ''),
  };

  const errors: string[] = [];
  if (!message.senderEmail) errors.push('Sender email is required.');
  else if (!validEmail(message.senderEmail)) errors.push('Sender email is not valid.');
  if (message.replyTo && !validEmail(message.replyTo)) errors.push('Reply-To email is not valid.');
  if (!message.to.length) errors.push('At least one recipient is required.');
  for (const email of [...message.to, ...message.cc]) {
    if (!validEmail(email)) errors.push(`Recipient email is not valid: ${email}`);
  }
  if (message.to.length + message.cc.length > MAX_RECIPIENTS) {
    errors.push(`To and CC may contain at most ${MAX_RECIPIENTS} recipients combined.`);
  }
  if (!message.subject) errors.push('Subject is required.');
  if (!message.body) errors.push('Email body is required.');
  const attachmentBytes = new TextEncoder().encode(message.attachmentContent).byteLength;
  if (attachmentBytes > MAX_ATTACHMENT_BYTES) errors.push('The ads.txt attachment is larger than 2 MB.');
  return { message, errors: Array.from(new Set(errors)) };
}

function utf8ToBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function plainTextFromHtml(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function siteExists(db: D1Database, siteId: string): Promise<boolean> {
  const row = await db.prepare('SELECT id FROM publishers WHERE id = ? LIMIT 1').bind(siteId).first<{ id: string }>();
  return Boolean(row);
}

async function writeAudit(
  db: D1Database,
  actor: string,
  action: string,
  siteId: string,
  details: Record<string, unknown>,
): Promise<void> {
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO audit_log (
      id, actor, action, publisher_id, entity_type, entity_id, details_json, created_at
    ) VALUES (?, ?, ?, ?, 'monitoring_email', ?, ?, ?)`)
    .bind(crypto.randomUUID(), actor, action, siteId, siteId, JSON.stringify(details), now)
    .run();
}

export async function sendMonitoringTestEmail(
  request: Request,
  env: MonitoringEmailSendEnv,
  siteId: string,
): Promise<Response> {
  if (!env.DB) return apiError('D1 database binding is not configured.', 503);
  if (!(await siteExists(env.DB, siteId))) return apiError('Site not found.', 404);
  if (!env.EMAIL) {
    return apiError(
      'Cloudflare EMAIL binding is not configured.',
      503,
      'Onboard a sender domain in Cloudflare Email Service and add a send_email binding named EMAIL.',
    );
  }

  let body: { message?: unknown };
  try {
    body = await readJson<{ message?: unknown }>(request);
  } catch (error) {
    return apiError('Test email JSON could not be read.', 400, error instanceof Error ? error.message : String(error));
  }

  const { message, errors } = normalizeMessage(body.message);
  if (errors.length) return apiError('Test email is not valid.', 422, errors);

  const actor = getActor(request);
  try {
    const result = await env.EMAIL.send({
      to: message.to,
      from: message.senderName
        ? { email: message.senderEmail, name: message.senderName }
        : message.senderEmail,
      subject: message.subject,
      ...(message.bodyFormat === 'html'
        ? { html: message.body, text: plainTextFromHtml(message.body) || 'HTML email from Tessera.' }
        : { text: message.body }),
      ...(message.cc.length ? { cc: message.cc } : {}),
      ...(message.replyTo ? { replyTo: message.replyTo } : {}),
      attachments: [
        {
          content: utf8ToBase64(message.attachmentContent),
          filename: message.attachmentName,
          type: 'text/plain; charset=utf-8',
          disposition: 'attachment',
        },
      ],
      headers: {
        'X-Tessera-Message-Type': 'ads-txt-manual-test',
        'X-Tessera-Site-Id': siteId,
      },
    });

    await writeAudit(env.DB, actor, 'monitoring.email_test.sent', siteId, {
      messageId: result.messageId,
      senderEmail: message.senderEmail,
      toCount: message.to.length,
      ccCount: message.cc.length,
      subjectLength: message.subject.length,
      bodyFormat: message.bodyFormat,
      attachmentName: message.attachmentName,
      attachmentBytes: new TextEncoder().encode(message.attachmentContent).byteLength,
    }).catch(() => undefined);

    return json({
      ok: true,
      mode: 'manual-test',
      messageId: result.messageId,
      sentAt: new Date().toISOString(),
      recipients: message.to,
      cc: message.cc,
      attachmentName: message.attachmentName,
    });
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    const errorCode = error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code ?? '')
      : '';

    await writeAudit(env.DB, actor, 'monitoring.email_test.failed', siteId, {
      senderEmail: message.senderEmail,
      toCount: message.to.length,
      ccCount: message.cc.length,
      attachmentName: message.attachmentName,
      error: messageText,
      errorCode: errorCode || null,
    }).catch(() => undefined);

    return apiError('Test email could not be sent.', 502, {
      message: messageText,
      code: errorCode || null,
    });
  }
}
