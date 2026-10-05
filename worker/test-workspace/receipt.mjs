import { WorkspaceError, TEST_SITE } from './boundary.mjs';
const encoder = new TextEncoder();
const HASH = /^[a-f0-9]{64}$/;
const fields = ['v','audience','actor','siteId','configHash','runtimeHash','buildTimestamp','takeOverEnabled','packageHash','issuedAt','expiresAt'].sort();
const fail = () => { throw new WorkspaceError(409, 'The reviewed package is invalid or expired. Generate and review a new package.'); };
function encode(bytes) { return btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,''); }
function decode(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return fail();
  const raw = atob(value.replaceAll('-','+').replaceAll('_','/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
async function key(secret, usage) {
  if (typeof secret !== 'string' || secret.length < 32) return fail();
  return crypto.subtle.importKey('raw',encoder.encode(`tessera-test-review-v1:${secret}`),{ name:'HMAC',hash:'SHA-256' },false,[usage]);
}
function validate(payload, { actor, origin }, now) {
  if (!payload || JSON.stringify(Object.keys(payload).sort()) !== JSON.stringify(fields)
      || payload.v !== 1 || payload.siteId !== TEST_SITE || payload.actor !== actor || payload.audience !== origin
      || ![payload.configHash,payload.runtimeHash,payload.packageHash].every((s) => typeof s === 'string' && HASH.test(s))
      || typeof payload.takeOverEnabled !== 'boolean' || !/^\d{8}_\d{6}$/.test(payload.buildTimestamp)
      || !Number.isSafeInteger(payload.issuedAt) || !Number.isSafeInteger(payload.expiresAt)
      || payload.expiresAt - payload.issuedAt !== 1200000 || payload.issuedAt > now + 30000 || payload.expiresAt <= now) return fail();
  return payload;
}
export async function issueReceipt(values, secret, now = Date.now()) {
  const payload = { v:1, ...values, siteId:TEST_SITE, issuedAt:now, expiresAt:now+1200000 };
  validate(payload,{ actor:values.actor,origin:values.audience },now);
  const encoded = encode(encoder.encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign('HMAC',await key(secret,'sign'),encoder.encode(encoded));
  return `${encoded}.${encode(new Uint8Array(signature))}`;
}
export async function verifyReceipt(token, secret, identity, now = Date.now()) {
  try {
    if (typeof token !== 'string' || token.length > 6000 || token.split('.').length !== 2) return fail();
    const [payload, signature] = token.split('.');
    if (!await crypto.subtle.verify('HMAC',await key(secret,'verify'),decode(signature),encoder.encode(payload))) return fail();
    return validate(JSON.parse(new TextDecoder('utf-8',{ fatal:true }).decode(decode(payload))),identity,now);
  } catch { return fail(); }
}
