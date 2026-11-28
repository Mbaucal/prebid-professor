export const TEST_SITE = 'test-site';
export const TEST_DATABASE = 'd27843e4-a53c-403a-baed-04a193f6d5c6';
export const TEST_BUCKET = 'prebid-professor-test-builds';
export const TEST_WORKER = 'prebid-professor-test';
export class WorkspaceError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function workspaceBoundary(request, env) {
  const url = new URL(request.url);
  // Never accept a production/branch-preview/custom-domain hostname by guessing.
  if (url.protocol !== 'https:' || url.hostname !== 'prebid-professor-test.mbaucal.workers.dev' || url.port) {
    throw new WorkspaceError(404, 'Test workspace not found.');
  }
  if (env.TEST_WORKSPACE_ENABLED !== 'true' || env.TEST_PUBLIC_ORIGIN !== url.origin
      || env.TEST_WORKER_NAME !== TEST_WORKER || env.TEST_DATABASE_ID !== TEST_DATABASE || env.TEST_BUCKET_NAME !== TEST_BUCKET) {
    throw new WorkspaceError(503, 'Test workspace is not activated. Production is unchanged.');
  }
  if (typeof env.TEST_ADMIN_EMAIL !== 'string' || !env.TEST_ADMIN_EMAIL.trim()
      || typeof env.TEST_ADMIN_PASSWORD !== 'string' || env.TEST_ADMIN_PASSWORD.length < 12
      || typeof env.TEST_SESSION_SECRET !== 'string' || env.TEST_SESSION_SECRET.length < 32) {
    throw new WorkspaceError(503, 'Separate test login credentials are not configured.');
  }
  if ((request.headers.get('cookie') || '').length > 8192) throw new WorkspaceError(400, 'Session header is too large.');
  return { origin: url.origin, auth: { ADMIN_EMAIL: env.TEST_ADMIN_EMAIL, ADMIN_PASSWORD: env.TEST_ADMIN_PASSWORD,
    SESSION_SECRET: `tessera-test-session-v1:${env.TEST_SESSION_SECRET}` } };
}
export function sameOrigin(request, origin) {
  if (request.method === 'GET' || request.method === 'HEAD') return;
  const site = request.headers.get('sec-fetch-site');
  if (request.headers.get('origin') !== origin || (site && site !== 'same-origin' && site !== 'none')) {
    throw new WorkspaceError(403, 'Same-origin request required.');
  }
}
export async function boundedText(request, maxBytes = 16384) {
  // Server-selected cap: only the site editor opts into the larger JSON budget.
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 262144) throw new TypeError('Invalid request size limit.');
  const reader = request.body?.getReader();
  if (!reader) throw new WorkspaceError(400, 'Request body is required.');
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new WorkspaceError(413, `Request exceeds ${maxBytes / 1024} KB.`); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new WorkspaceError(400, 'UTF-8 input is required.'); }
}
export async function jsonBody(request, allowed, maxBytes = 16384) {
  if ((request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new WorkspaceError(415, 'JSON body is required.');
  }
  let value;
  const text = await boundedText(request, maxBytes);
  try { value = JSON.parse(text); } catch { throw new WorkspaceError(400, 'Invalid JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new WorkspaceError(422, 'Unknown request field. Source code and uploaded files are not accepted.');
  }
  return value;
}
