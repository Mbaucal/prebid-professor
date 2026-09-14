import { sha256 } from './prebid-artifact-check.mjs';

// Storage adapter only. NOT imported by a Worker HTTP route. No env.DB/BUILDS fallback.
// The caller must supply an explicitly isolated store, the authenticated actor,
// and a server-generated candidate. This is not a browser artifact upload API.
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const HASH = /^[a-f0-9]{64}$/;
const SITE = /^[a-z0-9][a-z0-9-]{0,97}$/;
const ID = /^builtin-draft-[a-f0-9]{64}$/;
const REQUIRED = ['README.txt','ads.js','ads.min.js','config.json','div-export.csv',
  'implementation.html','manifest.json','min-height.css','sticky.css'];
const MAX_FILE = 8 * 1024 * 1024;
const MAX_PACKAGE = 12 * 1024 * 1024;
const record = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const json = (bytes) => JSON.parse(decoder.decode(bytes));
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const requireThat = (ok, message) => { if (!ok) throw new Error(message); };
const fileKey = (siteId, id, name) => `publishers/${siteId}/releases/${id}/${name}`;
function contentType(name) {
  return name.endsWith('.js') ? 'application/javascript; charset=utf-8'
    : name.endsWith('.json') ? 'application/json; charset=utf-8'
    : name.endsWith('.css') ? 'text/css; charset=utf-8'
    : name.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8';
}
function scope(siteId, releaseId) {
  requireThat(typeof siteId === 'string' && SITE.test(siteId), 'Invalid site ID.');
  if (releaseId !== undefined) requireThat(typeof releaseId === 'string' && ID.test(releaseId), 'Invalid built-in draft ID.');
}
function bindings(store) {
  requireThat(store?.isolation === 'explicit-test-store' && store.db && store.bucket,
    'An explicit isolated draft store is required. Production bindings are never selected automatically.');
  requireThat(typeof store.db.withSession === 'function', 'A sequentially consistent D1 session is required.');
  return { db: store.db.withSession('first-primary'), bucket: store.bucket };
}

/** Copy before the first await, then check every file against the serialized manifest.
 * The caller's mutable manifest object and R2 metadata are NOT trusted as file hashes.
 */
export async function describeCandidate(siteId, candidate) {
  scope(siteId);
  requireThat(record(candidate?.files), 'A server-generated candidate is required.');
  const names = Object.keys(candidate.files).sort();
  requireThat(same(names, REQUIRED) || same(names, [...REQUIRED, 'prebid.js'].sort()), 'Unexpected candidate file set.');
  const files = Object.create(null); let byteSize = 0;
  for (const name of names) {
    const bytes = candidate.files[name];
    requireThat(bytes instanceof Uint8Array && bytes.byteLength > 0 && bytes.byteLength <= MAX_FILE, 'Invalid candidate file size.');
    byteSize += bytes.byteLength;
    requireThat(byteSize <= MAX_PACKAGE, 'Candidate package exceeds 12 MB.');
    files[name] = bytes.slice();
  }
  const manifest = json(files['manifest.json']);
  requireThat(manifest?.schemaVersion === 1 && manifest.kind === 'builtin-runtime-candidate'
    && manifest.completeRelease === false && manifest.siteId === siteId && HASH.test(manifest.configHash), 'Invalid candidate manifest.');
  requireThat(record(manifest.files) && same(Object.keys(manifest.files).sort(), names.filter((n) => n !== 'manifest.json')), 'Manifest file inventory differs from candidate.');
  const config = json(files['config.json']);
  const runtime = manifest.runtime;
  requireThat(record(runtime) && runtime.schemaVersion === 1 && runtime.configSchemaVersion === 1
    && typeof runtime.runtimeId === 'string' && typeof runtime.runtimeVersion === 'string'
    && /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(runtime.runtimeVersion)
    && HASH.test(runtime.runtimeSha256) && Array.isArray(runtime.capabilities), 'Missing exact runtime pin.');
  requireThat(config?.schemaVersion === 1 && config.siteId === siteId && same(config.runtime,runtime), 'Configuration/runtime identity mismatch.');
  requireThat(typeof config.options?.enablePrebid === 'boolean', 'Explicit Prebid mode is required.');
  const enabled = config.options.enablePrebid;
  requireThat(Boolean(files['prebid.js']) === enabled && same(config.prebidBuild,manifest.prebidBuild), 'Prebid mode/pin mismatch.');
  const inventory = [];
  for (const name of names) {
    const entry = { name, byteSize: files[name].byteLength, sha256: await sha256(files[name]) };
    if (name !== 'manifest.json') requireThat(manifest.files[name]?.byteSize === entry.byteSize
      && manifest.files[name]?.sha256 === entry.sha256, 'Candidate file checksum mismatch.');
    inventory.push(entry);
  }
  if (enabled) {
    const pb = inventory.find((entry) => entry.name === 'prebid.js');
    requireThat(record(manifest.prebidBuild) && manifest.prebidBuild.sha256 === pb.sha256
      && manifest.prebidBuild.byteSize === pb.byteSize && typeof manifest.prebidBuild.id === 'string'
      && typeof manifest.prebidBuild.version === 'string' && Array.isArray(manifest.prebidBuild.modules), 'Prebid artifact pin differs from package bytes.');
  } else requireThat(manifest.prebidBuild === null, 'GPT-only must not retain a Prebid pin.');
  // Package identity includes the site, exact file manifest and its bytes.
  const packageSha256 = await sha256(encoder.encode(JSON.stringify({ siteId, inventory })));
  const releaseId = `builtin-draft-${packageSha256}`;
  const descriptor = { schemaVersion: 1, kind: 'builtin-stored-draft', completeRelease: false,
    siteId, releaseId, version: releaseId, packageSha256, byteSize,
    configHash: manifest.configHash, runtime, prebidBuild: manifest.prebidBuild, files: inventory };
  return { descriptor, files };
}

async function intent(db, siteId, releaseId) {
  return db.prepare('SELECT * FROM builtin_draft_uploads WHERE publisher_id = ? AND release_id = ?')
    .bind(siteId, releaseId).first();
}
function publicDraft(row, descriptor) {
  return { id: row.release_id, siteId: row.publisher_id, status: 'draft', storageState: row.state,
    completeRelease: false, publishable: false, version: descriptor.version,
    packageSha256: descriptor.packageSha256, byteSize: descriptor.byteSize,
    fileCount: descriptor.files.length, runtime: descriptor.runtime, prebidBuild: descriptor.prebidBuild,
    createdAt: row.created_at, createdBy: row.created_by, note: row.note };
}
async function verifiedObject(bucket, key, entry) {
  const object = await bucket.get(key);
  if (!object) return null;
  requireThat(object.size === entry.byteSize && object.size <= MAX_FILE, 'Stored file length mismatch.');
  const bytes = new Uint8Array(await object.arrayBuffer());
  requireThat(bytes.byteLength === entry.byteSize && await sha256(bytes) === entry.sha256, 'Stored file checksum mismatch.');
  return bytes;
}
async function immutablePut(bucket, key, bytes, entry) {
  if (await verifiedObject(bucket,key,entry)) return;
  // If a concurrent call created the same key, put returns null; never overwrite it.
  await bucket.put(key,bytes,{
    onlyIf: new Headers({ 'If-None-Match': '*' }), sha256: entry.sha256,
    httpMetadata: { contentType: contentType(entry.name), cacheControl: 'private, no-store' },
    customMetadata: { sha256: entry.sha256, kind: 'builtin-draft' },
  });
  requireThat(await verifiedObject(bucket,key,entry), 'The draft file was not stored.');
}
function assertSQL(db, id, sql, params) {
  return db.prepare(`INSERT INTO builtin_draft_assertions (id, valid) VALUES (?, CASE WHEN (${sql}) THEN 1 ELSE 0 END)`)
    .bind(id,...params);
}
function releaseAssertion(db, assertionId, row, descriptor) {
  const { siteId, releaseId, configHash } = descriptor;
  return assertSQL(db,assertionId,`EXISTS (SELECT 1 FROM releases WHERE id = ? AND publisher_id = ?
    AND version = ? AND status = 'draft' AND config_hash = ? AND ads_js_key = ? AND ads_min_js_key = ?
    AND prebid_js_key IS ? AND config_key = ? AND manifest_key = ? AND notes IS ?
    AND created_by = ? AND created_at = ? AND published_at IS NULL)`,
  [releaseId, siteId, releaseId, configHash, fileKey(siteId,releaseId,'ads.js'),fileKey(siteId,releaseId,'ads.min.js'),
    descriptor.prebidBuild ? fileKey(siteId,releaseId,'prebid.js') : null,
    fileKey(siteId,releaseId,'config.json'),fileKey(siteId,releaseId,'manifest.json'),row.note,row.created_by,row.created_at]);
}

/** Retry the EXACT same server-generated candidate to resume an interrupted upload.
 * D1 records an intent before R2 writes. Registration+audit commit as one SQL batch.
 * On uncertain outcomes retain files/intent; deleting could corrupt a successful save.
 */
export async function saveDraftRelease(store, { siteId, candidate, actor, note = '' }) {
  const { db, bucket } = bindings(store);
  requireThat(typeof actor === 'string' && actor.length > 0 && actor.length <= 320 && !/[\r\n]/.test(actor), 'Authenticated actor is required.');
  requireThat(typeof note === 'string' && note.length <= 160, 'Draft note must be at most 160 characters.');
  const { descriptor, files } = await describeCandidate(siteId,candidate);
  const id = descriptor.releaseId;
  const descriptorText = JSON.stringify(descriptor);
  requireThat(await db.prepare('SELECT id FROM publishers WHERE id = ?').bind(siteId).first(), 'Site not found in isolated store.');
  await db.prepare(`INSERT INTO builtin_draft_uploads
    (release_id,publisher_id,package_sha256,descriptor_json,state,created_by,created_at,note)
    VALUES (?,?,?,?,'uploading',?,?,?) ON CONFLICT (publisher_id,package_sha256) DO NOTHING`)
    .bind(id,siteId,descriptor.packageSha256,descriptorText,actor,new Date().toISOString(),note.trim() || null).run();
  const row = await intent(db,siteId,id);
  requireThat(row && row.descriptor_json === descriptorText, 'Draft reservation could not be verified.');
  // Even an already stored draft must pass byte verification before reporting success.
  // A missing file in a ready draft is corruption; do not silently regenerate/repair it.
  for (const entry of descriptor.files) {
    const key = fileKey(siteId,id,entry.name);
    if (row.state === 'stored') requireThat(await verifiedObject(bucket,key,entry), 'Stored draft file is missing.');
    else await immutablePut(bucket,key,files[entry.name],entry);
  }
  const assertionId = crypto.randomUUID();
  const values = [id,siteId,id,descriptor.configHash,fileKey(siteId,id,'ads.js'),fileKey(siteId,id,'ads.min.js'),
    descriptor.prebidBuild ? fileKey(siteId,id,'prebid.js') : null, fileKey(siteId,id,'config.json'),
    fileKey(siteId,id,'manifest.json'),row.note,row.created_by,row.created_at];
  const result = await db.batch([
    assertSQL(db,assertionId,`EXISTS (SELECT 1 FROM builtin_draft_uploads WHERE release_id = ? AND publisher_id = ?
      AND descriptor_json = ? AND created_by = ? AND created_at = ? AND note IS ?)`,
      [id,siteId,descriptorText,row.created_by,row.created_at,row.note]),
    db.prepare(`INSERT INTO releases (id,publisher_id,version,status,config_hash,ads_js_key,ads_min_js_key,
      prebid_js_key,config_key,manifest_key,notes,created_by,created_at)
      VALUES (?,?,?,'draft',?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`).bind(...values),
    db.prepare('DELETE FROM builtin_draft_assertions WHERE id = ?').bind(assertionId),
    releaseAssertion(db,assertionId,row,descriptor),
    db.prepare(`INSERT INTO audit_log (id,actor,action,publisher_id,entity_type,entity_id,details_json,created_at)
      VALUES (?,?,'builtin_draft.stored',?,'release',?,?,?) ON CONFLICT(id) DO NOTHING`)
      .bind(`audit-${id}`,row.created_by,siteId,id,JSON.stringify({ packageSha256: descriptor.packageSha256,
        runtimeVersion: descriptor.runtime.runtimeVersion, fileCount: descriptor.files.length, publishable: false }),row.created_at),
    db.prepare("UPDATE builtin_draft_uploads SET state = 'stored' WHERE release_id = ? AND publisher_id = ?").bind(id,siteId),
    db.prepare('DELETE FROM builtin_draft_assertions WHERE id = ?').bind(assertionId),
  ]);
  return { created: result[1].meta.changes === 1, draft: publicDraft({ ...row, state: 'stored' },descriptor) };
}

/** Does not regenerate anything or require that the historical runtime is current.
 * Read every stored byte and recheck its package identity before returning files.
 */
export async function readDraftRelease(store, { siteId, releaseId }) {
  scope(siteId,releaseId);
  const { db, bucket } = bindings(store);
  const row = await intent(db,siteId,releaseId);
  if (!row || row.state !== 'stored') return null;
  const descriptor = JSON.parse(row.descriptor_json);
  requireThat(descriptor?.schemaVersion === 1 && descriptor.siteId === siteId && descriptor.releaseId === releaseId
    && descriptor.version === releaseId && descriptor.kind === 'builtin-stored-draft' && descriptor.completeRelease === false
    && HASH.test(descriptor.packageSha256) && record(descriptor.runtime), 'Stored draft identity mismatch.');
  const inventory = descriptor.files;
  requireThat(Array.isArray(inventory) && inventory.length >= 9 && inventory.length <= 10, 'Invalid stored inventory.');
  const expectedNames = descriptor.prebidBuild ? [...REQUIRED,'prebid.js'].sort() : REQUIRED;
  requireThat(same(inventory.map((e) => e.name),expectedNames), 'Invalid stored file names.');
  requireThat(inventory.every((entry) => Number.isSafeInteger(entry.byteSize) && entry.byteSize > 0
    && entry.byteSize <= MAX_FILE && HASH.test(entry.sha256)) && inventory.reduce((n,e) => n + e.byteSize,0) <= MAX_PACKAGE,
    'Invalid stored file metadata.');
  // SELECT-only check of the registered release (no assertions-table writes on reads).
  const registered = await db.prepare('SELECT * FROM releases WHERE id = ? AND publisher_id = ?').bind(releaseId,siteId).first();
  const expected = { version: releaseId, status: 'draft', config_hash: descriptor.configHash,
    ads_js_key: fileKey(siteId,releaseId,'ads.js'), ads_min_js_key: fileKey(siteId,releaseId,'ads.min.js'),
    prebid_js_key: descriptor.prebidBuild ? fileKey(siteId,releaseId,'prebid.js') : null,
    config_key: fileKey(siteId,releaseId,'config.json'),manifest_key: fileKey(siteId,releaseId,'manifest.json'),
    notes: row.note,created_by: row.created_by,created_at: row.created_at,published_at: null };
  requireThat(registered && Object.entries(expected).every(([key,value]) => registered[key] === value), 'Registered draft metadata mismatch.');
  const files = Object.create(null);
  for (const entry of inventory) {
    files[entry.name] = await verifiedObject(bucket,fileKey(siteId,releaseId,entry.name),entry);
    requireThat(files[entry.name], 'Stored draft file is missing.');
  }
  const checked = await describeCandidate(siteId,{ files });
  requireThat(same(checked.descriptor,descriptor), 'Stored package identity mismatch.');
  return { draft: publicDraft(row,descriptor), files: checked.files };
}
