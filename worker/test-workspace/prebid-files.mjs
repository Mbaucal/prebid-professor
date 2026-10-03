/** TEST-only immutable Prebid upload library. Uploaded code is never executed,
 * rewritten, fetched from a URL, selected or published by uploading it. */
import { parsePrebidHeader, sha256 } from '../runtime/prebid-artifact-check.mjs';
import { WorkspaceError, TEST_SITE } from './boundary.mjs';
export const MAX_PREBID_UPLOAD = 8 * 1024 * 1024;
export const PREBID_ID = /^test-pb-[a-f0-9]{64}$/;
const headerLimit = 500000;
const columns = 'id,publisher_id,version,file_key,modules_json,status,uploaded_at';
const keyFor = (id) => `publishers/${TEST_SITE}/prebid-builds/${id}/prebid.js`;
const fail = (status, message) => { throw new WorkspaceError(status, message); };
function storage(store) {
  if (store?.isolation !== 'explicit-test-store' || typeof store.db?.withSession !== 'function'
      || typeof store.bucket?.get !== 'function' || typeof store.bucket?.put !== 'function') {
    fail(503, 'The isolated Prebid file storage is unavailable.');
  }
  return { db: store.db.withSession('first-primary'), bucket: store.bucket };
}
export async function readPrebidUpload(request) {
  if ((request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase() !== 'application/javascript'
      || request.headers.get('x-tessera-upload') !== 'prebid-test-file') fail(415, 'Select a Prebid.js file using this upload form.');
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_PREBID_UPLOAD)) {
    await request.body?.cancel(); fail(413, 'Prebid.js must be no larger than 8 MiB.');
  }
  const reader = request.body?.getReader();
  if (!reader) fail(400, 'Select a non-empty Prebid.js file.');
  const parts = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > MAX_PREBID_UPLOAD) { await reader.cancel(); fail(413, 'Prebid.js must be no larger than 8 MiB.'); }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  if (!size) fail(400, 'Select a non-empty Prebid.js file.');
  const bytes = new Uint8Array(size); let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes;
}
export async function inspectUpload(input) {
  if (!(input instanceof Uint8Array) || !input.byteLength || input.byteLength > MAX_PREBID_UPLOAD) fail(413, 'Prebid.js must be between 1 byte and 8 MiB.');
  const bytes = input.slice();
  let header;
  try {
    const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (source.trimStart().startsWith('<')) fail(422, 'Select JavaScript, not an HTML page.');
    header = parsePrebidHeader(source.slice(0, headerLimit));
    if(header.version.length>64||header.modules.some(m=>m.length>120))fail(422,'Prebid header declarations exceed the supported length.');
  } catch (error) {
    if (error instanceof WorkspaceError) throw error;
    fail(422, 'The file needs a readable Prebid.js version and Modules header. Upload the original build file.');
  }
  const checksum = await sha256(bytes), id = `test-pb-${checksum}`;
  return { bytes, id, key: keyFor(id), sha256: checksum, version: header.version, modules: header.modules, byteSize: bytes.byteLength };
}
function validRecord(row) {
  if (!row || !PREBID_ID.test(row.id) || row.publisher_id !== TEST_SITE || row.file_key !== keyFor(row.id)
      || !['archived', 'current'].includes(row.status) || typeof row.uploaded_at !== 'string') fail(409, 'The stored Prebid file record needs review.');
  let modules;
  try { modules = JSON.parse(row.modules_json); } catch { fail(409, 'Stored Prebid module metadata needs review.'); }
  if (!Array.isArray(modules) || !modules.length || modules.length > 1000 || modules.some((s) => typeof s !== 'string' || s.length>120 || !/^[A-Za-z][A-Za-z0-9_]*$/.test(s))
      || JSON.stringify([...new Set(modules)].sort()) !== row.modules_json || (row.version.length>64||!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9._-]+)?$/.test(row.version))) fail(409, 'Stored Prebid version or module metadata needs review.');
  return modules;
}
function publicFile(row) {
  return { id: row.id, version: row.version, modules: validRecord(row), sha256: row.id.slice(8), status: row.status, uploadedAt: row.uploaded_at };
}
export async function listPrebidFiles(store) {
  const { db } = storage(store);
  const rows = await db.prepare(`SELECT ${columns} FROM prebid_builds WHERE publisher_id=? ORDER BY uploaded_at DESC,id LIMIT 51`).bind(TEST_SITE).all();
  if (rows.success !== true || rows.results.length > 50) fail(409, 'The TEST library has reached its 50-file limit. Existing files are retained.');
  return rows.results.map(publicFile);
}
export async function readPrebidFile(store, id) {
  if (!PREBID_ID.test(id)) fail(422, 'Choose a file from this TEST library.');
  const { db, bucket } = storage(store);
  const row = await db.prepare(`SELECT ${columns} FROM prebid_builds WHERE id=? AND publisher_id=?`).bind(id, TEST_SITE).first();
  if (!row) fail(409, 'The selected Prebid file is no longer available. Reload saved settings.');
  validRecord(row);
  let object;
  try { object = await bucket.get(row.file_key); }
  catch { fail(503, 'The saved Prebid file could not be read. Retry the same file.'); }
  if (!object || !Number.isSafeInteger(object.size) || object.size < 1 || object.size > MAX_PREBID_UPLOAD) fail(409, 'The stored Prebid file is missing or has an invalid size.');
  let buffer;
  try { buffer = await object.arrayBuffer(); }
  catch { fail(503, 'The saved Prebid file body could not be read. Retry the same file.'); }
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength !== object.size) fail(409, 'The stored Prebid file length does not match its metadata.');
  const checked = await inspectUpload(new Uint8Array(buffer));
  if (checked.id !== row.id || object.customMetadata?.sha256 !== checked.sha256) fail(409, 'The saved Prebid bytes do not match the upload checksum. No replacement was made.');
  if (checked.version !== row.version || object.customMetadata?.version !== checked.version) fail(409, 'The saved Prebid version differs from its stored metadata. No replacement was made.');
  if (JSON.stringify(checked.modules) !== row.modules_json) fail(409, 'The saved Prebid module header differs from its stored metadata. No replacement was made.');
  return { row, checked };
}
export async function storePrebidFile(store, input, actor) {
  const { db, bucket } = storage(store);
  if (typeof actor !== 'string' || !actor.trim() || actor.length > 320 || /[\r\n]/.test(actor)) fail(422, 'An authenticated TEST actor is required.');
  const item = await inspectUpload(input);
  const exists = await db.prepare(`SELECT ${columns} FROM prebid_builds WHERE id=? AND publisher_id=?`).bind(item.id, TEST_SITE).first();
  if (exists) {
    const verified = await readPrebidFile(store, item.id);
    return { created: false, file: publicFile(verified.row), byteSize: item.byteSize, selectionChanged: false, publishable: false };
  }
  const count = await db.prepare('SELECT COUNT(*) AS n FROM prebid_builds WHERE publisher_id=?').bind(TEST_SITE).first();
  if (count.n >= 50) fail(409, 'The TEST library has reached its 50-file limit. Existing files are retained.');
  // If transport fails after PUT or commit, keep the object. The same content-ID
  // can be retried; never delete data that a concurrent successful request uses.
  await bucket.put(item.key, item.bytes, { onlyIf: new Headers({ 'If-None-Match': '*' }), sha256: item.sha256,
    httpMetadata: { contentType: 'application/javascript; charset=utf-8', cacheControl: 'private, no-store' },
    customMetadata: { sha256: item.sha256, version: item.version, kind: 'test-prebid-file' } });
  const object = await bucket.get(item.key);
  if (!object || object.size !== item.byteSize || object.customMetadata?.sha256 !== item.sha256 || object.customMetadata?.version !== item.version) fail(409, 'The Prebid upload could not be verified. Retry this same file.');
  const stored = await object.arrayBuffer();
  if (stored.byteLength !== item.byteSize || await sha256(stored) !== item.sha256) fail(409, 'Stored Prebid bytes do not match. No existing file was replaced.');
  const aid = crypto.randomUUID(), stamp = new Date().toISOString();
  try {
    const result = await db.batch([
      db.prepare(`INSERT INTO builtin_draft_assertions(id,valid) VALUES (?,CASE WHEN EXISTS(SELECT 1 FROM prebid_builds WHERE id=? AND publisher_id=?) OR (SELECT COUNT(*) FROM prebid_builds WHERE publisher_id=?)<50 THEN 1 ELSE 0 END)`).bind(aid, item.id, TEST_SITE, TEST_SITE),
      db.prepare(`INSERT INTO prebid_builds(id,publisher_id,version,file_key,modules_json,status,uploaded_by,uploaded_at) VALUES (?,?,?,?,?,'archived',?,?) ON CONFLICT(id) DO NOTHING`).bind(item.id, TEST_SITE, item.version, item.key, JSON.stringify(item.modules), actor, stamp),
      db.prepare(`INSERT INTO audit_log(id,actor,action,publisher_id,details_json) VALUES (?,?,'test_workspace.prebid_uploaded',?,?) ON CONFLICT(id) DO NOTHING`).bind(`audit-${item.id}`, actor, TEST_SITE, JSON.stringify({id:item.id,sha256:item.sha256,version:item.version,byteSize:item.byteSize,publishable:false})),
      db.prepare('DELETE FROM builtin_draft_assertions WHERE id=?').bind(aid),
    ]);
    if (result.some((r) => r.success !== true)) throw Error('Unconfirmed registration');
    const verified = await readPrebidFile(store, item.id);
    return { created: result[1].meta.changes === 1, file: publicFile(verified.row), byteSize: item.byteSize, selectionChanged: false, publishable: false };
  } catch (error) {
    if (error instanceof WorkspaceError) throw error;
    fail(503, 'The upload result could not be confirmed. Reload the file list or retry the same file. Nothing was published.');
  }
}
