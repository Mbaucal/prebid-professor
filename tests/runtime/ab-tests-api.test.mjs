/** The A/B tests API (worker/experiments/ab-tests-api.mjs) on the strict memory R2 fake, with
 * an injected readVersion and listVersions over tiny synthetic TEST drafts. Covers every route,
 * the request reader (400, 413, 415, 422), 404, 405, the dry run (a refusal is 200), the
 * package-missing mapping and the plain-words error bodies. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {unzipSync} from 'fflate';
import {memoryR2} from '../support/memory-r2.mjs';
import {syntheticDraft, versionReader} from '../support/ab-synthetic-drafts.mjs';
import {abTestsResponse} from '../../worker/experiments/ab-tests-api.mjs';
import {abPrefix} from '../../worker/experiments/ab-store.mjs';

const BASE = '/test-api/ab-tests', ORIGIN = 'https://workspace.example.invalid', SITE = 'test-site', P = abPrefix(SITE);
const HEADERS = {'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff'};
const ACTOR = {email: 'tester@example.invalid'};
const UNEXPECTED = 'The A/B test could not be read or saved. Retry.';
const NOT_SAVED = 'The A/B test could not be saved. Retry with the same values.';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const D = {};
test.before(async () => {
  D.A = await syntheticDraft({runtimeVersion: '9.0.0', script: 'window.arm = "A";\n', note: 'Bid cache off'});
  D.B = await syntheticDraft({runtimeVersion: '9.0.1', script: 'window.arm = "B";\n', note: 'Bid cache on'});
  D.gam = await syntheticDraft({prebid: false, script: 'window.arm = "GAM";\n', note: ''});
});

function api({r2 = memoryR2(), drafts = [D.A, D.B, D.gam], readVersion} = {}) {
  const reader = versionReader(drafts);
  const versions = drafts.map(d => ({id: d.release.id, name: d.release.note || 'Generated package', createdAt: '2026-11-15T10:00:00.000Z', runtimeVersion: d.release.runtime.runtimeVersion, prebidVersion: d.files['prebid.js'] ? '11.34.0' : null}));
  const options = {bucket: r2.bucket, site: SITE, actor: ACTOR, base: BASE, headers: HEADERS, testOnly: true,
    readVersion: readVersion ?? reader.readVersion, listVersions: async () => versions, current: () => null, defaults: {trafficBPercent: 50}};
  async function call(method, path, body, {contentType = 'application/json', raw} = {}) {
    const init = {method, headers: body === undefined && raw === undefined ? {} : {'content-type': contentType}};
    if (raw !== undefined) init.body = raw; else if (body !== undefined) init.body = JSON.stringify(body);
    const response = await abTestsResponse(new Request(ORIGIN + path, init), options);
    if (response === null) return null;
    const type = response.headers.get('content-type') ?? '';
    const bytes = new Uint8Array(await response.arrayBuffer());
    return {status: response.status, headers: response.headers, bytes, json: type.startsWith('application/json') && bytes.length ? JSON.parse(new TextDecoder().decode(bytes)) : null};
  }
  return {r2, reader, versions, call, options};
}
const create = (over = {}) => ({name: 'Bid cache', testId: 'test_site_1', a: D.A.release.id, b: D.B.release.id, trafficBPercent: 50, ...over});
function refusal(result, status, error, code) {
  assert.equal(result.status, status, JSON.stringify(result.json));
  assert.equal(result.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(result.headers.get('cache-control'), 'private, no-store');
  if (error instanceof RegExp) assert.match(result.json.error, error); else assert.equal(result.json.error, error);
  assert.doesNotMatch(result.json.error, /at .*\.mjs|Error:|undefined|null/, 'plain words only');
  if (code !== undefined) assert.equal(result.json.code, code);
  return result.json;
}

test('only the base path and its known sub-paths are routed', async () => {
  const {call} = api();
  for (const path of ['/test-api/ab-testsx', '/test-api/other', '/test-api', `${BASE}/`, `${BASE}/check/x`, `${BASE}/abx-123`, `${BASE}/abx-${'a'.repeat(64)}/other`, `${BASE}/abx-${'A'.repeat(64)}`])
    assert.equal(await call('GET', path), null, path);
});

test('GET lists the defaults, the proposed TestId, the saved versions and the saved tests', async () => {
  const {call, versions} = api();
  const empty = await call('GET', BASE);
  assert.equal(empty.status, 200);
  assert.equal(empty.headers.get('cache-control'), 'private, no-store');
  assert.equal(empty.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(empty.json, {supported: true, site: SITE, testOnly: true, defaults: {trafficBPercent: 50}, proposedTestId: 'test_site_1', current: null,
    versions, tests: [], deleted: [], nextCursor: null, limits: {tests: 100, name: 60}});
  assert.equal((await call('POST', BASE, create())).status, 201);
  const listed = await call('GET', `${BASE}?cursor=abc_DEF%3D%2B%2F.-`);
  assert.equal(listed.status, 200);
  assert.equal(listed.json.proposedTestId, 'test_site_2');
  assert.deepEqual(listed.json.tests.map(t => [t.name, t.testId, t.deletedAt, t.arms.A.name, t.arms.B.name]), [['Bid cache', 'test_site_1', null, 'Bid cache off', 'Bid cache on']]);
});

test('queries other than one valid cursor are refused with 400', async () => {
  const {call} = api();
  for (const query of ['?x=1', '?cursor=', '?cursor=a%20b', `?cursor=${'a'.repeat(1025)}`, '?cursor=a&cursor=b', '?cursor=a&x=1'])
    refusal(await call('GET', BASE + query), 400, 'Unknown query.');
  refusal(await call('POST', `${BASE}/check?dryRun=1`, {a: D.A.release.id, b: D.B.release.id}), 400, 'Unknown query.');
  refusal(await call('POST', `${BASE}?x=1`, create()), 400, 'Unknown query.');
  refusal(await call('GET', `${BASE}/abx-${'a'.repeat(64)}?x=1`), 400, 'Unknown query.');
});

test('other methods on a known path get 405 JSON', async () => {
  const {call} = api(), id = `abx-${'a'.repeat(64)}`;
  for (const [method, path, allow] of [['PUT', BASE, 'GET, POST'], ['DELETE', BASE, 'GET, POST'], ['GET', `${BASE}/check`, 'POST'], ['PATCH', `${BASE}/${id}`, 'GET, PUT, DELETE'],
    ['POST', `${BASE}/${id}`, 'GET, PUT, DELETE'], ['DELETE', `${BASE}/${id}/download`, 'GET'], ['POST', `${BASE}/${id}/record`, 'GET'], ['GET', `${BASE}/${id}/events`, 'POST']]) {
    const result = await call(method, path);
    refusal(result, 405, 'Method not allowed.');
    assert.equal(result.headers.get('allow'), allow);
  }
});

test('the body reader refuses non-JSON, oversized, invalid and unknown-field bodies in plain words', async () => {
  const {call, r2} = api();
  for (const path of [`${BASE}/check`, BASE]) {
    refusal(await call('POST', path, create(), {contentType: 'text/plain'}), 415, 'JSON body is required.');
    refusal(await call('POST', path, undefined, {contentType: 'application/json', raw: ''}), 400, 'Invalid JSON.');
    refusal(await call('POST', path, undefined, {raw: '{"a":'}), 400, 'Invalid JSON.');
    refusal(await call('POST', path, undefined, {raw: new Uint8Array([0x7b, 0xff, 0x7d])}), 400, 'UTF-8 input is required.');
    refusal(await call('POST', path, create({name: 'x'.repeat(4096)})), 413, 'Request exceeds 4 KB.');
    refusal(await call('POST', path, ['a']), 422, 'Unknown request field. Source code and uploaded files are not accepted.');
    refusal(await call('POST', path, create({script: 'alert(1)'})), 422, 'Unknown request field. Source code and uploaded files are not accepted.');
  }
  refusal(await call('POST', BASE, undefined, {contentType: 'application/json; charset=utf-8', raw: 'null'}), 422, /^Unknown request field/);
  assert.deepEqual(r2.log.puts, []);
});

test('POST /check: compatible, refused (still 200), malformed ids and missing versions', async () => {
  const {call, reader, r2} = api();
  const ok = await call('POST', `${BASE}/check`, {a: D.A.release.id, b: D.B.release.id, name: 'ignored', testId: 'ignored', trafficBPercent: 7});
  assert.equal(ok.status, 200);
  assert.equal(ok.json.compatible, true);
  assert.equal(ok.json.refusal, null);
  assert.deepEqual(ok.json.arms, {A: {id: D.A.release.id, name: 'Bid cache off', runtimeVersion: '9.0.0'}, B: {id: D.B.release.id, name: 'Bid cache on', runtimeVersion: '9.0.1'}});
  assert.deepEqual(ok.json.warnings.map(w => w.code), ['runtime-differs']);
  assert.deepEqual(ok.json.configDiff.map(d => d.field), ['runtimeVersion']);
  const refused = await call('POST', `${BASE}/check`, {a: D.gam.release.id, b: D.A.release.id});
  assert.equal(refused.status, 200);
  assert.equal(refused.json.compatible, false);
  assert.equal(refused.json.refusal.code, 'prebid-differs');
  assert.equal(refused.json.arms.A.name, 'Generated package');
  const aa = await call('POST', `${BASE}/check`, {a: D.A.release.id, b: D.A.release.id});
  assert.equal(aa.json.compatible, true);
  assert.deepEqual(aa.json.arms.A, aa.json.arms.B);
  assert.equal(reader.reads.filter(id => id === D.A.release.id).length, 3, 'A/A reads the version once');
  for (const body of [{a: 'builtin-draft-123', b: D.B.release.id}, {a: D.A.release.id}, {a: `builtin-release-${'a'.repeat(64)}`, b: D.B.release.id}, {a: 1, b: 2}])
    assert.equal(refusal(await call('POST', `${BASE}/check`, body), 400, 'Choose a saved version for A and B.').code, 'invalid-request');
  reader.remove(D.B.release.id);
  const missing = await call('POST', `${BASE}/check`, {a: D.A.release.id, b: D.B.release.id});
  assert.equal(missing.status, 200);
  assert.deepEqual(missing.json, {compatible: false, refusal: {code: 'package-missing', check: 'packages',
    message: 'Version B is no longer in Saved versions. Choose another saved version. Saved A/B tests keep their own copies.'},
  checks: [], warnings: [], configDiff: null, arms: {A: {id: D.A.release.id, name: 'Bid cache off', runtimeVersion: '9.0.0'}, B: null}});
  assert.deepEqual(r2.log.puts, [], 'a dry run never writes');
});

test('a read error other than 404 is a 503 that names the version', async () => {
  const {call} = api({readVersion: async () => { throw Object.assign(new Error('D1 unavailable'), {status: 500}); }});
  refusal(await call('POST', `${BASE}/check`, {a: D.A.release.id, b: D.B.release.id}), 503, 'Version A could not be read. Nothing was saved. Retry.');
  refusal(await call('POST', BASE, create()), 503, 'Version A could not be read. Nothing was saved. Retry.');
});

test('POST creates once (201), returns the same test again (200) and refuses in plain words', async () => {
  const {call, reader, r2} = api();
  const created = await call('POST', BASE, create({name: '  Bid cache  '}));
  assert.equal(created.status, 201);
  assert.deepEqual(Object.keys(created.json), ['created', 'record', 'recordSha256']);
  assert.equal(created.json.created, true);
  assert.equal(created.json.record.name, 'Bid cache', 'the name is trimmed');
  assert.equal(created.json.record.createdBy, ACTOR.email);
  const again = await call('POST', BASE, create());
  assert.equal(again.status, 200);
  assert.deepEqual(again.json, {created: false, record: created.json.record, recordSha256: created.json.recordSha256, deletedAt: null});
  for (const name of ['Bid\ncache', 'Bid\tcache', 'Bid\u0000cache', 'Bid\u007fcache', 'Bid\u0085cache'])
    assert.equal(refusal(await call('POST', BASE, create({name, testId: 'other_1'})), 400, 'Use a test name without line breaks, tabs or other control characters.').code, 'invalid-request');
  refusal(await call('POST', BASE, create({name: '   ', testId: 'other_1'})), 400, 'Give the test a name of 1 to 60 characters.', 'invalid-request');
  refusal(await call('POST', BASE, create({name: 'x'.repeat(61), testId: 'other_1'})), 400, 'Give the test a name of 1 to 60 characters.', 'invalid-request');
  refusal(await call('POST', BASE, create({testId: 'Bad-Id'})), 400, /^Use a TestId of 1 to 24/, 'invalid-request');
  refusal(await call('POST', BASE, create({trafficBPercent: 101, testId: 'other_1'})), 400, /^Use a whole number from 0 to 100/, 'invalid-request');
  refusal(await call('POST', BASE, create({a: undefined})), 400, 'Choose a saved version for A and B.', 'invalid-request');
  const incompatible = refusal(await call('POST', BASE, create({a: D.gam.release.id, testId: 'other_1'})), 422, /^Version B loads Prebid\.js and version A is GAM only\./, 'prebid-differs');
  assert.equal(incompatible.check, 'prebid');
  refusal(await call('POST', BASE, create({name: 'Another test'})), 409, /^TestId test_site_1 is already used by another A\/B test on this site\./, 'testid-taken');
  reader.remove(D.B.release.id);
  const missing = refusal(await call('POST', BASE, create({testId: 'other_2', name: 'Missing B'})), 422,
    'Version B is no longer in Saved versions. Choose another saved version. Saved A/B tests keep their own copies.', 'package-missing');
  assert.equal(missing.check, 'packages');
  assert.equal([...r2.objects.keys()].filter(k => k.includes('/records/')).length, 1);
});

test('GET item, ZIP download and record download serve the verified stored bytes', async () => {
  const {call, r2} = api();
  const {record, recordSha256} = (await call('POST', BASE, create())).json, id = record.id;
  const item = await call('GET', `${BASE}/${id}`);
  assert.equal(item.status, 200);
  assert.deepEqual(item.json, {record, recordSha256, deletedAt: null, events: []});
  const zip = await call('GET', `${BASE}/${id}/download`);
  assert.equal(zip.status, 200);
  assert.equal(zip.headers.get('content-type'), 'application/zip');
  assert.equal(zip.headers.get('content-disposition'), `attachment; filename="ab-test_site_1-${id.slice(-8)}.zip"`);
  assert.equal(zip.headers.get('x-package-sha256'), record.bundle.zipSha256);
  assert.equal(zip.headers.get('cache-control'), 'private, no-store');
  assert.equal(hash(zip.bytes), record.bundle.zipSha256);
  assert.deepEqual(Object.keys(unzipSync(zip.bytes)).sort(), record.bundle.files.map(f => f.path).sort());
  const saved = await call('GET', `${BASE}/${id}/record`);
  assert.equal(saved.status, 200);
  assert.equal(saved.headers.get('content-type'), 'application/json');
  assert.equal(saved.headers.get('content-disposition'), `attachment; filename="ab-test_site_1-${id.slice(-8)}.json"`);
  assert.equal(saved.headers.get('x-record-sha256'), recordSha256);
  assert.equal(hash(saved.bytes), recordSha256);
  assert.deepEqual(saved.bytes, r2.objects.get(`${P}records/${id}.json`).bytes);
  const unknown = `abx-${'0'.repeat(64)}`;
  for (const path of [`${BASE}/${unknown}`, `${BASE}/${unknown}/download`, `${BASE}/${unknown}/record`]) refusal(await call('GET', path), 404, 'A/B test not found.');
  // A changed ZIP is never served.
  r2.objects.get(`${P}zips/${id}.zip`).bytes[30] ^= 1;
  refusal(await call('GET', `${BASE}/${id}/download`), 409, 'ZIP differs from its record.', 'zip-unverified');
  // A changed record is never served.
  r2.objects.get(`${P}records/${id}.json`).customMetadata.summary = '{}';
  for (const path of [`${BASE}/${id}`, `${BASE}/${id}/record`]) refusal(await call('GET', path), 409, /^This saved A\/B test does not match its stored record\./, 'record-unverified');
});

test('DELETE trashes and PUT restores only with the exact confirmation', async () => {
  const {call} = api();
  const {record} = (await call('POST', BASE, create())).json, id = record.id, confirm = {confirmId: id, sha256: record.bundle.zipSha256};
  refusal(await call('DELETE', `${BASE}/${id}`, {confirmId: id, sha256: '0'.repeat(64)}), 422, 'Confirm the exact saved version before deleting or restoring.');
  refusal(await call('DELETE', `${BASE}/${id}`, {confirmId: id}), 422, 'Confirm the exact saved version before deleting or restoring.');
  refusal(await call('DELETE', `${BASE}/${id}`, {...confirm, reason: 'x'}), 422, /^Unknown request field/);
  refusal(await call('DELETE', `${BASE}/abx-${'0'.repeat(64)}`, confirm), 404, 'A/B test not found.');
  const deleted = await call('DELETE', `${BASE}/${id}`, confirm);
  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.json, {ok: true, id, deleted: true});
  let list = (await call('GET', BASE)).json;
  assert.deepEqual([list.tests.length, list.deleted.map(t => t.id)], [0, [id]]);
  assert.ok((await call('GET', `${BASE}/${id}`)).json.deletedAt);
  assert.equal((await call('GET', `${BASE}/${id}/download`)).status, 200, 'a deleted test stays downloadable');
  const restored = await call('PUT', `${BASE}/${id}`, confirm);
  assert.deepEqual([restored.status, restored.json], [200, {ok: true, id, deleted: false}]);
  list = (await call('GET', BASE)).json;
  assert.deepEqual([list.tests.map(t => t.id), list.deleted.length], [[id], 0]);
});

test('POST events: 201, out of order 409, unknown type 422', async () => {
  const {call} = api();
  const {record} = (await call('POST', BASE, create())).json, id = record.id;
  refusal(await call('POST', `${BASE}/${id}/events`, {type: 'marked-stopped'}), 409, 'Mark the test live before you mark it stopped.');
  refusal(await call('POST', `${BASE}/${id}/events`, {type: 'paused'}), 422, 'Mark the test live or stopped.');
  refusal(await call('POST', `${BASE}/${id}/events`, {type: 'marked-live', at: '2020-01-01'}), 422, /^Unknown request field/);
  const live = await call('POST', `${BASE}/${id}/events`, {type: 'marked-live'});
  assert.equal(live.status, 201);
  assert.deepEqual(Object.keys(live.json), ['event']);
  assert.deepEqual([live.json.event.seq, live.json.event.type, live.json.event.by], [1, 'marked-live', ACTOR.email]);
  refusal(await call('POST', `${BASE}/${id}/events`, {type: 'marked-live'}), 409, 'This A/B test is already marked live.');
  assert.equal((await call('POST', `${BASE}/${id}/events`, {type: 'marked-stopped'})).status, 201);
  assert.deepEqual((await call('GET', `${BASE}/${id}`)).json.events.map(e => e.type), ['marked-live', 'marked-stopped']);
  refusal(await call('POST', `${BASE}/abx-${'0'.repeat(64)}/events`, {type: 'marked-live'}), 404, 'A/B test not found.');
});

test('an unexpected failure is a 503 with a plain message and no detail', async () => {
  const {call, r2} = api();
  r2.faults.list = () => { throw new Error('R2 list failed: internal detail'); };
  refusal(await call('GET', BASE), 503, UNEXPECTED);
  r2.faults.list = null;
  r2.faults.beforePut = () => { throw new Error('R2 put failed: internal detail'); };
  refusal(await call('POST', BASE, create()), 503, NOT_SAVED);
});

test('a save that fails after the TestId claim says so: retry with the same values, and the TestId is reserved, not used', async () => {
  const {call, r2} = api();
  // The claim is stored, then the first bundle file put fails: something was changed, so the answer never says otherwise.
  let n = 0;
  r2.faults.beforePut = key => { if (key.includes('/files/') && n++ === 0) throw new Error('R2 down'); };
  const failed = refusal(await call('POST', BASE, create()), 503, NOT_SAVED);
  assert.doesNotMatch(failed.error, /Nothing was changed/);
  assert.deepEqual([...r2.objects.keys()].map(k => k.slice(P.length)), ['test-ids/test_site_1.json']);
  r2.faults.beforePut = null;
  const listing = await call('GET', BASE);
  assert.deepEqual([listing.json.tests.length, listing.json.proposedTestId], [0, 'test_site_2']);
  // Another test with that TestId: no saved test has it, so it is reserved, not "used by another A/B test".
  refusal(await call('POST', BASE, create({name: 'Bid cache on'})), 409,
    'TestId test_site_1 is reserved by an A/B test whose save has not finished. Each TestId is used once. Choose another TestId.', 'testid-taken');
  // The same values save the test.
  assert.equal((await call('POST', BASE, create())).status, 201);
  refusal(await call('POST', BASE, create({name: 'Bid cache on'})), 409, /^TestId test_site_1 is already used by another A\/B test on this site\./, 'testid-taken');
});
