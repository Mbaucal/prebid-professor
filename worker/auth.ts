export interface AuthEnv {
  ADMIN_EMAIL?: string;
  ADMIN_PASSWORD?: string;
  SESSION_SECRET?: string;
}

export type AuthUser = {
  email: string;
};

type SessionPayload = {
  version: 1;
  email: string;
  issuedAt: number;
  expiresAt: number;
};

const COOKIE_NAME = '__Host-pp_session';
const SESSION_TTL_SECONDS = 24 * 60 * 60;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function configuredEmails(env: AuthEnv): string[] {
  return Array.from(
    new Set(
      String(env.ADMIN_EMAIL ?? '')
        .split(/[;,\n]+/)
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    ),
  );
}

function configurationIssue(env: AuthEnv): string | null {
  if (!configuredEmails(env).length) return 'ADMIN_EMAIL is not configured.';
  if (String(env.ADMIN_PASSWORD ?? '').length < 12) {
    return 'ADMIN_PASSWORD must contain at least 12 characters.';
  }
  if (String(env.SESSION_SECRET ?? '').length < 32) {
    return 'SESSION_SECRET must contain at least 32 characters.';
  }
  return null;
}

export function authStatus(env: AuthEnv): 'configured' | 'not-configured' {
  return configurationIssue(env) ? 'not-configured' : 'configured';
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function encodePayload(payload: SessionPayload): string {
  return bytesToBase64Url(encoder.encode(JSON.stringify(payload)));
}

function decodePayload(value: string): SessionPayload | null {
  try {
    const parsed = JSON.parse(decoder.decode(base64UrlToBytes(value))) as Partial<SessionPayload>;
    if (
      parsed.version !== 1 ||
      typeof parsed.email !== 'string' ||
      typeof parsed.issuedAt !== 'number' ||
      typeof parsed.expiresAt !== 'number'
    ) {
      return null;
    }
    return parsed as SessionPayload;
  } catch {
    return null;
  }
}

async function hmac(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(value));
  return bytesToBase64Url(new Uint8Array(signature));
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

async function secureTextEqual(left: string, right: string): Promise<boolean> {
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(left)),
    crypto.subtle.digest('SHA-256', encoder.encode(right)),
  ]);
  return constantTimeEqual(new Uint8Array(leftHash), new Uint8Array(rightHash));
}

function readCookie(request: Request, name: string): string | null {
  const cookieHeader = request.headers.get('cookie') ?? '';
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    const key = part.slice(0, separator).trim();
    if (key !== name) continue;
    return part.slice(separator + 1).trim();
  }
  return null;
}

function sessionCookie(token: string): string {
  return [
    `${COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    `Max-Age=${SESSION_TTL_SECONDS}`,
    'Priority=High',
  ].join('; ');
}

function clearSessionCookie(): string {
  return [
    `${COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    'Max-Age=0',
    'Priority=High',
  ].join('; ');
}

function safeNext(value: string | null | undefined): string {
  const candidate = String(value ?? '').trim();
  if (!candidate.startsWith('/') || candidate.startsWith('//')) return '/';
  if (candidate.startsWith('/login') || candidate.startsWith('/api/auth')) return '/';
  return candidate;
}

async function createSession(email: string, secret: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const encodedPayload = encodePayload({
    version: 1,
    email,
    issuedAt: now,
    expiresAt: now + SESSION_TTL_SECONDS,
  });
  return `${encodedPayload}.${await hmac(encodedPayload, secret)}`;
}

export async function getAuthenticatedUser(request: Request, env: AuthEnv): Promise<AuthUser | null> {
  if (configurationIssue(env)) return null;

  const token = readCookie(request, COOKIE_NAME);
  if (!token) return null;

  const separator = token.lastIndexOf('.');
  if (separator <= 0) return null;

  const encodedPayload = token.slice(0, separator);
  const suppliedSignature = token.slice(separator + 1);
  const expectedSignature = await hmac(encodedPayload, String(env.SESSION_SECRET));

  let signatureMatches = false;
  try {
    signatureMatches = constantTimeEqual(
      base64UrlToBytes(suppliedSignature),
      base64UrlToBytes(expectedSignature),
    );
  } catch {
    return null;
  }
  if (!signatureMatches) return null;

  const payload = decodePayload(encodedPayload);
  if (!payload) return null;

  const now = Math.floor(Date.now() / 1000);
  if (payload.expiresAt <= now || payload.issuedAt > now + 60) return null;

  const allowedEmails = configuredEmails(env);
  const normalizedEmail = payload.email.trim().toLowerCase();
  if (!allowedEmails.includes(normalizedEmail)) return null;

  return { email: normalizedEmail };
}

export function isSameOriginMutation(request: Request): boolean {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method.toUpperCase())) return true;

  const requestUrl = new URL(request.url);
  const origin = request.headers.get('origin');
  if (origin && origin !== requestUrl.origin) return false;

  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') return false;

  return true;
}

function loginHeaders(): HeadersInit {
  return {
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'content-type': 'text/html; charset=utf-8',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
  };
}

export function renderLoginPage(
  request: Request,
  env: AuthEnv,
  errorMessage: string | null = null,
  status = 200,
): Response {
  const url = new URL(request.url);
  const next = safeNext(url.searchParams.get('next'));
  const setupIssue = configurationIssue(env);
  const error = setupIssue ?? errorMessage;

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Sign in · Prebid Professor</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; color: #e8edf5; background: radial-gradient(circle at 20% 0%, #343b46 0, #171b21 42%, #101319 100%); }
    main { width: min(460px, 100%); }
    .brand { display: flex; align-items: center; gap: 13px; margin-bottom: 18px; }
    .mark { width: 46px; height: 46px; display: grid; place-items: center; border-radius: 12px; color: #1c1510; background: #f2762e; font-weight: 900; }
    .brand strong, .brand span { display: block; }
    .brand strong { color: #fff; font-size: 18px; }
    .brand span { margin-top: 3px; color: #8d97a6; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11px; }
    .card { padding: 28px; border: 1px solid #353d49; border-radius: 18px; background: rgba(29, 34, 42, .96); box-shadow: 0 30px 90px rgba(0, 0, 0, .42); }
    .kicker { color: #f59a63; font-size: 11px; font-weight: 900; letter-spacing: .12em; text-transform: uppercase; }
    h1 { margin: 8px 0 8px; color: #fff; font-size: 28px; }
    p { margin: 0 0 22px; color: #9ba5b4; line-height: 1.55; }
    label { display: block; margin-top: 15px; }
    label span { display: block; margin-bottom: 7px; color: #cbd3df; font-size: 12px; font-weight: 800; }
    input { width: 100%; min-height: 46px; padding: 10px 12px; border: 1px solid #4a5361; border-radius: 9px; color: #fff; background: #15191f; outline: none; }
    input:focus { border-color: #f2762e; box-shadow: 0 0 0 3px rgba(242, 118, 46, .16); }
    button { width: 100%; min-height: 47px; margin-top: 20px; border: 0; border-radius: 9px; color: #20150e; background: #f2762e; font-weight: 900; cursor: pointer; }
    button:hover { background: #ff8843; }
    button:disabled { cursor: not-allowed; opacity: .5; }
    .error { margin: 0 0 18px; padding: 11px 12px; border: 1px solid #86454b; border-radius: 9px; color: #ffd4d8; background: #3a1f24; font-size: 12px; line-height: 1.5; }
    .note { margin-top: 18px; color: #727d8d; text-align: center; font-size: 11px; }
  </style>
</head>
<body>
  <main>
    <div class="brand"><div class="mark">PP</div><div><strong>Prebid Professor</strong><span>Ad-tech control plane</span></div></div>
    <section class="card">
      <span class="kicker">Admin access</span>
      <h1>Sign in</h1>
      <p>Use the administrator credentials configured as encrypted Cloudflare Worker secrets.</p>
      ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
      <form method="post" action="/api/auth/login">
        <input type="hidden" name="next" value="${escapeHtml(next)}" />
        <label><span>Email</span><input name="email" type="email" autocomplete="username" required /></label>
        <label><span>Password</span><input name="password" type="password" autocomplete="current-password" required /></label>
        <button type="submit"${setupIssue ? ' disabled' : ''}>Sign in securely</button>
      </form>
    </section>
    <div class="note">Protected with a signed, HttpOnly, SameSite=Strict session cookie.</div>
  </main>
</body>
</html>`;

  return new Response(html, { status: setupIssue ? 503 : status, headers: loginHeaders() });
}

async function readLoginInput(request: Request): Promise<{ email: string; password: string; next: string }> {
  const contentType = request.headers.get('content-type')?.toLowerCase() ?? '';
  if (contentType.includes('application/json')) {
    const body = (await request.json()) as Record<string, unknown>;
    return {
      email: String(body.email ?? ''),
      password: String(body.password ?? ''),
      next: safeNext(String(body.next ?? '/')),
    };
  }

  const form = await request.formData();
  return {
    email: String(form.get('email') ?? ''),
    password: String(form.get('password') ?? ''),
    next: safeNext(String(form.get('next') ?? '/')),
  };
}

export async function handleLogin(request: Request, env: AuthEnv): Promise<Response> {
  if (request.method !== 'POST') return new Response('Method not allowed.', { status: 405 });
  if (!isSameOriginMutation(request)) return new Response('Cross-site login request blocked.', { status: 403 });

  const issue = configurationIssue(env);
  if (issue) return renderLoginPage(request, env, issue, 503);

  let input: { email: string; password: string; next: string };
  try {
    input = await readLoginInput(request);
  } catch {
    return renderLoginPage(request, env, 'The login form could not be read.', 400);
  }

  const normalizedEmail = input.email.trim().toLowerCase();
  const allowedEmails = configuredEmails(env);
  const emailChecks = await Promise.all(
    allowedEmails.map((allowedEmail) => secureTextEqual(normalizedEmail, allowedEmail)),
  );
  const emailOk = emailChecks.some(Boolean);
  const passwordOk = await secureTextEqual(input.password, String(env.ADMIN_PASSWORD));

  if (!emailOk || !passwordOk) {
    const loginUrl = new URL(request.url);
    loginUrl.pathname = '/login';
    loginUrl.searchParams.set('next', input.next);
    return renderLoginPage(
      new Request(loginUrl.toString(), { headers: request.headers }),
      env,
      'Email or password is incorrect.',
      401,
    );
  }

  const token = await createSession(normalizedEmail, String(env.SESSION_SECRET));
  return new Response(null, {
    status: 303,
    headers: {
      'cache-control': 'no-store',
      location: input.next,
      'set-cookie': sessionCookie(token),
    },
  });
}

export function handleLogout(request: Request): Response {
  if (!isSameOriginMutation(request)) return new Response('Cross-site logout request blocked.', { status: 403 });
  return new Response(null, {
    status: 204,
    headers: {
      'cache-control': 'no-store',
      'set-cookie': clearSessionCookie(),
    },
  });
}

export function redirectToLogin(request: Request): Response {
  const url = new URL(request.url);
  const loginUrl = new URL('/login', url);
  loginUrl.searchParams.set('next', safeNext(`${url.pathname}${url.search}`));
  return new Response(null, {
    status: 303,
    headers: {
      'cache-control': 'no-store',
      location: loginUrl.toString(),
    },
  });
}
