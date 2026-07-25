import { apiError, getActor, json } from './http';
import type { DatabaseEnv } from './publishers';

export interface GmailOAuthEnv extends DatabaseEnv {
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GOOGLE_OAUTH_CLIENT_SECRET?: string;
  GMAIL_TOKEN_ENCRYPTION_KEY?: string;
}

type GmailConnectionRow = {
  email: string;
  refresh_token_encrypted: string;
  scope: string;
  connected_by: string | null;
  connected_at: string;
  updated_at: string;
};

const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
const STATE_TTL_MS = 10 * 60 * 1000;

async function ensureTables(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS gmail_oauth_states (
      state TEXT PRIMARY KEY,
      actor TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS gmail_connections (
      id TEXT PRIMARY KEY CHECK (id = 'primary'),
      email TEXT NOT NULL,
      refresh_token_encrypted TEXT NOT NULL,
      scope TEXT NOT NULL,
      connected_by TEXT,
      connected_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`),
  ]);
}

function requiredSecrets(env: GmailOAuthEnv): string[] {
  const missing: string[] = [];
  if (!env.GOOGLE_OAUTH_CLIENT_ID) missing.push('GOOGLE_OAUTH_CLIENT_ID');
  if (!env.GOOGLE_OAUTH_CLIENT_SECRET) missing.push('GOOGLE_OAUTH_CLIENT_SECRET');
  if (!env.GMAIL_TOKEN_ENCRYPTION_KEY) missing.push('GMAIL_TOKEN_ENCRYPTION_KEY');
  return missing;
}

async function encryptionKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptToken(secret: string, value: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await encryptionKey(secret), new TextEncoder().encode(value));
  const bytes = new Uint8Array(iv.byteLength + encrypted.byteLength);
  bytes.set(iv, 0);
  bytes.set(new Uint8Array(encrypted), iv.byteLength);
  return btoa(String.fromCharCode(...bytes));
}

export async function decryptToken(secret: string, value: string): Promise<string> {
  const bytes = Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
  const iv = bytes.slice(0, 12);
  const ciphertext = bytes.slice(12);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, await encryptionKey(secret), ciphertext);
  return new TextDecoder().decode(decrypted);
}

export async function getGmailStatus(env: GmailOAuthEnv): Promise<Response> {
  if (!env.DB) return apiError('D1 database binding is not configured.', 503);
  await ensureTables(env.DB);
  const missingSecrets = requiredSecrets(env);
  const row = await env.DB.prepare(`SELECT email, scope, connected_by, connected_at, updated_at FROM gmail_connections WHERE id = 'primary' LIMIT 1`).first<Omit<GmailConnectionRow, 'refresh_token_encrypted'>>();
  return json({
    ok: true,
    configured: missingSecrets.length === 0,
    missingSecrets,
    connected: Boolean(row),
    account: row ? {
      email: row.email,
      scope: row.scope,
      connectedBy: row.connected_by,
      connectedAt: row.connected_at,
      updatedAt: row.updated_at,
    } : null,
  });
}

export async function startGmailConnect(request: Request, env: GmailOAuthEnv): Promise<Response> {
  if (!env.DB) return apiError('D1 database binding is not configured.', 503);
  const missing = requiredSecrets(env);
  if (missing.length) return apiError('Gmail OAuth secrets are not configured.', 503, missing);
  await ensureTables(env.DB);
  const actor = getActor(request);
  const origin = new URL(request.url).origin;
  const redirectUri = `${origin}/api/integrations/gmail/callback`;
  const state = crypto.randomUUID();
  const now = new Date();
  await env.DB.prepare(`INSERT INTO gmail_oauth_states (state, actor, redirect_uri, expires_at, created_at) VALUES (?, ?, ?, ?, ?)`)
    .bind(state, actor, redirectUri, new Date(now.getTime() + STATE_TTL_MS).toISOString(), now.toISOString()).run();
  const authorize = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authorize.searchParams.set('client_id', env.GOOGLE_OAUTH_CLIENT_ID!);
  authorize.searchParams.set('redirect_uri', redirectUri);
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('scope', GMAIL_SCOPE);
  authorize.searchParams.set('access_type', 'offline');
  authorize.searchParams.set('prompt', 'consent');
  authorize.searchParams.set('include_granted_scopes', 'true');
  authorize.searchParams.set('state', state);
  return Response.redirect(authorize.toString(), 302);
}

export async function finishGmailConnect(request: Request, env: GmailOAuthEnv): Promise<Response> {
  if (!env.DB) return apiError('D1 database binding is not configured.', 503);
  const missing = requiredSecrets(env);
  if (missing.length) return apiError('Gmail OAuth secrets are not configured.', 503, missing);
  await ensureTables(env.DB);
  const url = new URL(request.url);
  const error = url.searchParams.get('error');
  if (error) return Response.redirect(`${url.origin}/?gmail=error&reason=${encodeURIComponent(error)}`, 302);
  const code = url.searchParams.get('code') ?? '';
  const state = url.searchParams.get('state') ?? '';
  if (!code || !state) return apiError('Gmail OAuth callback is missing code or state.', 400);
  const stateRow = await env.DB.prepare(`SELECT actor, redirect_uri, expires_at FROM gmail_oauth_states WHERE state = ? LIMIT 1`).bind(state).first<{ actor: string; redirect_uri: string; expires_at: string }>();
  if (!stateRow || new Date(stateRow.expires_at).getTime() < Date.now()) return apiError('Gmail OAuth state is invalid or expired.', 400);
  await env.DB.prepare('DELETE FROM gmail_oauth_states WHERE state = ?').bind(state).run();

  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_OAUTH_CLIENT_ID!,
      client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET!,
      redirect_uri: stateRow.redirect_uri,
      grant_type: 'authorization_code',
    }),
  });
  const tokenPayload = await tokenResponse.json() as { access_token?: string; refresh_token?: string; scope?: string; error?: string; error_description?: string };
  if (!tokenResponse.ok || !tokenPayload.access_token || !tokenPayload.refresh_token) {
    return apiError('Google token exchange failed.', 502, tokenPayload.error_description || tokenPayload.error || tokenPayload);
  }
  const profileResponse = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
    headers: { authorization: `Bearer ${tokenPayload.access_token}` },
  });
  const profile = await profileResponse.json() as { emailAddress?: string; error?: unknown };
  if (!profileResponse.ok || !profile.emailAddress) return apiError('Connected Gmail account could not be identified.', 502, profile.error ?? profile);
  const now = new Date().toISOString();
  const encrypted = await encryptToken(env.GMAIL_TOKEN_ENCRYPTION_KEY!, tokenPayload.refresh_token);
  await env.DB.prepare(`INSERT INTO gmail_connections (id, email, refresh_token_encrypted, scope, connected_by, connected_at, updated_at)
    VALUES ('primary', ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET email = excluded.email, refresh_token_encrypted = excluded.refresh_token_encrypted, scope = excluded.scope, connected_by = excluded.connected_by, connected_at = excluded.connected_at, updated_at = excluded.updated_at`)
    .bind(profile.emailAddress.toLowerCase(), encrypted, tokenPayload.scope || GMAIL_SCOPE, stateRow.actor, now, now).run();
  return Response.redirect(`${url.origin}/?gmail=connected`, 302);
}

export async function disconnectGmail(env: GmailOAuthEnv): Promise<Response> {
  if (!env.DB) return apiError('D1 database binding is not configured.', 503);
  await ensureTables(env.DB);
  await env.DB.prepare(`DELETE FROM gmail_connections WHERE id = 'primary'`).run();
  return json({ ok: true, connected: false });
}

export async function getStoredGmailConnection(env: GmailOAuthEnv): Promise<GmailConnectionRow | null> {
  if (!env.DB) return null;
  await ensureTables(env.DB);
  return env.DB.prepare(`SELECT email, refresh_token_encrypted, scope, connected_by, connected_at, updated_at FROM gmail_connections WHERE id = 'primary' LIMIT 1`).first<GmailConnectionRow>();
}
