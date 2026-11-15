/** The immutable A/B test store (worker/experiments/ab-store.mjs) on the strict memory R2 fake,
 * with tiny synthetic TEST drafts. Covers the key set, record and summary verification, create
 * order (every refusal before the first put), idempotency, races, caps, trash and events. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {memoryR2} from '../support/memory-r2.mjs';
import {syntheticDraft} from '../support/ab-synthetic-drafts.mjs';
import {composeAbBundle, abTestIdentity} from '../../worker/experiments/ab-bundle.mjs';
import {MAX_ZIP} from '../../worker/test-workspace/deployment-contract.mjs';
import {PAGES_HEADERS as SHARED_HEADERS} from '../../shared/pages/headers.mjs';
import {PAGES_HEADERS as SCRIPT_HEADERS} from '../../scripts/pages-release-verification.mjs';
import {deliveryHeaders, ARCHIVE_LAYOUT} from '../../worker/test-workspace/delivery-layout.mjs';
import {AB_LIMITS, abPrefix, abSummary, createAbTest, listAbTests, readAbTest, readAbZip, readAbRecordBytes,
  changeAbTestDeletion, addAbTestEvent, proposeTestId} from '../../worker/experiments/ab-store.mjs';

const SITE = 'test-site', P = abPrefix(SITE), ACTOR = {email: 'tester@example.invalid'};
const NOW = new Date('2026-11-15T12:00:00.000Z');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const text = bytes => new TextDecoder().decode(bytes);
const utf8 = value => Buffer.byteLength(value);
const D = {};
test.before(async () => {
  D.A = await syntheticDraft({runtimeVersion: '9.0.0', script: 'window.arm = "A";\n', note: 'Bid cache off'});
  D.B = await syntheticDraft({runtimeVersion: '9.0.1', script: 'window.arm = "B";\n', note: 'Bid cache on'});
  D.gam = await syntheticDraft({prebid: false, script: 'window.arm = "GAM";\n', note: 'GAM only'});
});
const input = (over = {}) => ({site: SITE, actor: ACTOR, a: D.A, b: D.B, name: 'Bid cache', testId: 'test_site_1', trafficBPercent: 50, now: NOW, ...over});
async function rejects(promise, status, code) {
  const error = await promise.then(() => assert.fail('expected a refusal'), e => e);
  assert.equal(error.status, status, error.stack);
  if (code !== undefined) assert.equal(error.code, code);
  return error;
}
const keysOf = r2 => [...r2.objects.keys()].sort();

test('PAGES_HEADERS: the shared module, the release script and the archive-v1 delivery headers are the same bytes', () => {
  assert.equal(SHARED_HEADERS, SCRIPT_HEADERS);
  assert.equal(SHARED_HEADERS, deliveryHeaders(ARCHIVE_LAYOUT));
  // The shared module has no imports, so a Worker can bundle it without the Node release scripts.
  assert.doesNotMatch(readFileSync(new URL('../../shared/pages/headers.mjs', import.meta.url), 'utf8'), /\bimport\b/);
});

test('size limits equal the TEST delivery limits', () => {
  assert.equal(AB_LIMITS.zip, MAX_ZIP);
  const contract = readFileSync(new URL('../../worker/test-workspace/deployment-contract.mjs', import.meta.url), 'utf8');
  assert.match(contract, /entry\.originalSize <= 8\*1024\*1024 && total <= 12\*1024\*1024/);
  assert.equal(AB_LIMITS.file, 8 * 1024 * 1024);
  assert.equal(AB_LIMITS.bundle, 12 * 1024 * 1024);
  assert.equal(AB_LIMITS.record, 256 * 1024);
});

test('create stores exactly the record, the bundle files, the ZIP and the TestId claim, all create-only and private', async () => {
  const r2 = memoryR2(), bundle = await composeAbBundle({site: SITE, a: D.A, b: D.B, trafficBPercent: 50, testId: 'test_site_1', name: 'Bid cache'});
  const result = await createAbTest(r2.bucket, input());
  const id = bundle.id;
  assert.equal(result.created, true);
  assert.deepEqual(result.record, {...bundle.record, createdBy: ACTOR.email, createdAt: NOW.toISOString()});
  assert.deepEqual(keysOf(r2), [
    `${P}files/${id}/_headers`, `${P}files/${id}/ads.js`, `${P}files/${id}/prebid.js`,
    ...[D.A, D.B].map(d => `${P}files/${id}/r/${d.release.id}/ads.js`).sort(),
    `${P}records/${id}.json`, `${P}test-ids/test_site_1.json`, `${P}zips/${id}.zip`].sort());
  for (const [path, bytes] of Object.entries(bundle.files)) {
    const stored = r2.objects.get(`${P}files/${id}/${path}`);
    assert.deepEqual(stored.bytes, bytes);
    assert.deepEqual(stored.customMetadata, {kind: 'ab-bundle-file', sha256: hash(bytes)});
  }
  const zip = r2.objects.get(`${P}zips/${id}.zip`);
  assert.deepEqual(zip.bytes, bundle.zip);
  assert.deepEqual(zip.customMetadata, {kind: 'ab-bundle-zip', sha256: bundle.zipSha256, zipByteSize: String(bundle.zip.length)});
  const record = r2.objects.get(`${P}records/${id}.json`);
  assert.equal(result.recordSha256, hash(record.bytes));
  assert.deepEqual(Object.keys(record.customMetadata), ['kind', 'sha256', 'summary']);
  assert.equal(record.customMetadata.kind, 'ab-test-record');
  assert.equal(record.customMetadata.sha256, result.recordSha256);
  assert.deepEqual(JSON.parse(record.customMetadata.summary), abSummary(result.record));
  assert.deepEqual(JSON.parse(text(r2.objects.get(`${P}test-ids/test_site_1.json`).bytes)), {schemaVersion: 1, site: SITE, testId: 'test_site_1', id});
  for (const stored of r2.objects.values()) assert.equal(stored.httpMetadata.cacheControl, 'private, no-store');
  // The record is written last: it is the commit point.
  assert.equal(r2.log.puts.at(-1), `${P}records/${id}.json`);
  assert.deepEqual(abSummary(result.record), {id, name: 'Bid cache', testId: 'test_site_1', trafficBPercent: 50, createdAt: NOW.toISOString(), createdBy: ACTOR.email,
    zipSha256: bundle.zipSha256, prebidVersion: '11.34.0', fileCount: 5,
    arms: {A: {release: D.A.release.id, runtimeVersion: '9.0.0', name: 'Bid cache off'}, B: {release: D.B.release.id, runtimeVersion: '9.0.1', name: 'Bid cache on'}}});
  const read = await readAbTest(r2.bucket, SITE, id);
  assert.deepEqual(read, {record: result.record, recordSha256: result.recordSha256, deletedAt: null, events: []});
  assert.deepEqual((await readAbRecordBytes(r2.bucket, SITE, id)).bytes, record.bytes);
  assert.deepEqual((await readAbZip(r2.bucket, SITE, id)).bytes, bundle.zip);
});

test('an idempotent re-save makes no write and returns the first record', async () => {
  const r2 = memoryR2();
  const first = await createAbTest(r2.bucket, input());
  const puts = r2.log.puts.length;
  const again = await createAbTest(r2.bucket, input({now: new Date('2027-01-01T00:00:00.000Z'), actor: {email: 'other@example.invalid'}}));
  assert.equal(r2.log.puts.length, puts, 'a re-save must not put anything');
  assert.deepEqual(again, {created: false, record: first.record, recordSha256: first.recordSha256, deletedAt: null});
});

test('a concurrent identical create stores one record', async () => {
  const r2 = memoryR2();
  const results = await Promise.all([createAbTest(r2.bucket, input()), createAbTest(r2.bucket, input({now: new Date(NOW.getTime() + 1)}))]);
  assert.deepEqual(results.map(r => r.created).sort(), [false, true]);
  assert.equal(results[0].record.id, results[1].record.id);
  assert.equal(keysOf(r2).filter(k => k.startsWith(P + 'records/')).length, 1);
  const stored = await readAbTest(r2.bucket, SITE, results[0].record.id);
  for (const r of results) assert.deepEqual(r.record, stored.record);
});

test('a TestId race between two different tests gives one create and one 409', async () => {
  const r2 = memoryR2();
  const outcomes = await Promise.allSettled([createAbTest(r2.bucket, input({name: 'First'})), createAbTest(r2.bucket, input({name: 'Second'}))]);
  assert.equal(outcomes.filter(o => o.status === 'fulfilled' && o.value.created).length, 1);
  const refused = outcomes.filter(o => o.status === 'rejected').map(o => o.reason);
  assert.equal(refused.length, 1);
  assert.equal(refused[0].status, 409);
  assert.equal(refused[0].code, 'testid-taken');
  assert.match(refused[0].message, /^TestId test_site_1 is already used by another A\/B test on this site\./);
  assert.equal(keysOf(r2).filter(k => k.startsWith(P + 'records/')).length, 1);
  // A claim is never released: a later test with the same TestId is refused too.
  await rejects(createAbTest(r2.bucket, input({name: 'Third'})), 409, 'testid-taken');
});

test('an R2 failure before the record leaves only a claim this exact test can reuse', async () => {
  const r2 = memoryR2();
  r2.faults.beforePut = key => { if (key.includes('/records/')) throw new Error('R2 temporary write failure'); };
  const error = await createAbTest(r2.bucket, input()).then(() => assert.fail('expected a failure'), e => e);
  assert.equal(error.status, undefined);
  assert.equal(keysOf(r2).some(k => k.includes('/records/')), false);
  r2.faults.beforePut = null;
  await rejects(createAbTest(r2.bucket, input({name: 'Another test'})), 409, 'testid-taken');
  const retry = await createAbTest(r2.bucket, input());
  assert.equal(retry.created, true);
});

test('bundles over the delivery limits are refused before any put', async () => {
  const r2 = memoryR2(), big = 'x'.repeat(6.5 * 1024 * 1024);
  const a = await syntheticDraft({adsMin: `window.arm = "A";/*${big}*/\n`, note: 'Large A'});
  const b = await syntheticDraft({adsMin: `window.arm = "B";/*${big}*/\n`, runtimeVersion: '9.0.1', note: 'Large B'});
  const error = await rejects(createAbTest(r2.bucket, input({a, b})), 422, 'bundle-too-large');
  assert.match(error.message, /too large to store/);
  assert.deepEqual(r2.log.puts, []);
});

test('the worst-case API names fit the summary; names-too-long still refuses before any put, with no claim', async () => {
  // Control characters are allowed in version names and escape to six bytes each in the summary JSON. The API allows
  // 60 characters of test name without control characters and the sign-in email is at most 254 characters.
  const a = await syntheticDraft({note: '\u0001'.repeat(160)});
  const b = await syntheticDraft({runtimeVersion: '9.0.1', script: 'window.arm = "B";\n', note: '😀'.repeat(80)});
  {
    const r2 = memoryR2();
    const result = await createAbTest(r2.bucket, input({a, b, name: '中'.repeat(60), testId: 'a'.repeat(24), actor: {email: 'a'.repeat(242) + '@example.org'}}));
    assert.equal(result.created, true);
    assert.ok(utf8(r2.objects.get(`${P}records/${result.record.id}.json`).customMetadata.summary) <= 1800);
  }
  // Only inputs the API never passes (a control-character test name and a 600-character actor) reach the guard.
  const r2 = memoryR2();
  const error = await rejects(createAbTest(r2.bucket, input({a, b, name: '\u0001'.repeat(60), actor: {email: 'a'.repeat(600) + '@example.org'}})), 422, 'names-too-long');
  assert.equal(error.message, 'The test name is too long to store. Shorten the test name and try again.');
  assert.deepEqual(r2.log.puts, []);
  assert.deepEqual(keysOf(r2), []);
});

test('version names cannot overflow the summary: they are cut by their JSON-escaped size', async () => {
  // A control character is one byte raw and six escaped (\u0001). The test name is one character, so only the
  // version names could be too long, and the operator cannot shorten them after saving.
  const r2 = memoryR2();
  const a = await syntheticDraft({note: '\u0002'.repeat(160)});
  const b = await syntheticDraft({runtimeVersion: '9.0.1', script: 'window.arm = "B";\n', note: '\u0001'.repeat(160)});
  const result = await createAbTest(r2.bucket, input({a, b, name: 'x', actor: {email: 'a'.repeat(242) + '@example.org'}}));
  assert.equal(result.created, true);
  const summary = r2.objects.get(`${P}records/${result.record.id}.json`).customMetadata.summary;
  assert.ok(utf8(summary) <= 1800, `summary is ${utf8(summary)} bytes`);
  for (const side of ['A', 'B']) {
    const cut = JSON.parse(summary).arms[side].name;
    assert.equal(result.record.arms[side].name.length, 160, 'the record keeps the full name');
    assert.ok(cut.endsWith('…') && result.record.arms[side].name.startsWith(cut.slice(0, -1)));
    assert.ok(utf8(JSON.stringify(cut.slice(0, -1))) - 2 <= 150, `${side}: escaped ${utf8(JSON.stringify(cut.slice(0, -1))) - 2} bytes`);
  }
});

test('the largest valid names give a summary of at most 1800 bytes, arm names cut on a code-point boundary', async () => {
  const cases = [
    ['😀'.repeat(80), 'a' + '😀'.repeat(79)],
    ['"'.repeat(160), '\\'.repeat(160)],
    ['中'.repeat(160), 'é'.repeat(160)],
  ];
  for (const [noteA, noteB] of cases) {
    const r2 = memoryR2();
    const a = await syntheticDraft({note: noteA}), b = await syntheticDraft({runtimeVersion: '9.0.1', script: 'window.arm = "B";\n', note: noteB});
    const result = await createAbTest(r2.bucket, input({a, b, name: '中'.repeat(60), testId: 'a'.repeat(24), actor: {email: 'a'.repeat(242) + '@example.org'}}));
    assert.equal(result.created, true);
    const summary = r2.objects.get(`${P}records/${result.record.id}.json`).customMetadata.summary;
    assert.ok(utf8(summary) <= 1800, `summary is ${utf8(summary)} bytes`);
    for (const [side, full] of [['A', noteA], ['B', noteB]]) {
      assert.equal(result.record.arms[side].name, full, 'the record keeps the full name');
      const cut = JSON.parse(summary).arms[side].name;
      assert.ok(cut.endsWith('…'));
      const kept = cut.slice(0, -1);
      const escaped = utf8(JSON.stringify(kept)) - 2;
      assert.ok(full.startsWith(kept) && escaped <= 150 && escaped > 146, `${side}: kept ${escaped} escaped bytes`);
      assert.doesNotMatch(kept, /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/, 'no lone surrogate');
      assert.equal(Buffer.from(kept).toString(), kept);
    }
  }
  // A short name is kept as it is.
  assert.equal(abSummary({...(await composeAbBundle({site: SITE, a: D.A, b: D.B, trafficBPercent: 1, testId: 'x', name: 'n'})).record}).arms.A.name, 'Bid cache off');
});

test('the lifetime cap of 100 is counted across pages; a race may overshoot and every record is still listed', async () => {
  const r2 = memoryR2({pageCap: 40});
  for (let i = 1; i <= 99; i++) await createAbTest(r2.bucket, input({name: `Test ${i}`, testId: `t_${i}`, now: new Date(NOW.getTime() + i * 1000)}));
  // Three creates count 99 before any of them writes its record, so all three are accepted.
  let waiting = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  r2.faults.beforePut = async key => { if (key.includes('/records/')) { if (++waiting === 3) release(); await gate; } };
  const raced = await Promise.all([100, 101, 102].map(i => createAbTest(r2.bucket, input({name: `Test ${i}`, testId: `t_${i}`, now: new Date(NOW.getTime() + i * 1000)}))));
  r2.faults.beforePut = null;
  assert.deepEqual(raced.map(r => r.created), [true, true, true]);
  const listed = await listAbTests(r2.bucket, SITE);
  assert.equal(listed.tests.length, 102);
  assert.equal(new Set(listed.tests.map(t => t.id)).size, 102);
  assert.deepEqual(listed.tests.map(t => t.createdAt), [...listed.tests.map(t => t.createdAt)].sort().reverse(), 'newest first');
  assert.ok(r2.log.lists.some(l => l.prefix === P + 'records/' && l.cursor), 'the listing followed the cursor');
  const puts = r2.log.puts.length;
  const error = await rejects(createAbTest(r2.bucket, input({name: 'Over the cap', testId: 't_103'})), 409, 'limit');
  assert.equal(error.message, 'This TEST site has reached its lifetime limit of 100 A/B tests. Deleted tests still count, because their bytes are kept.');
  assert.equal(r2.log.puts.length, puts, 'no claim and no file for a refused test');
  // Deleted tests still count.
  const first = listed.tests.at(-1);
  await changeAbTestDeletion(r2.bucket, SITE, first.id, ACTOR, {confirmId: first.id, sha256: first.zipSha256}, true);
  await rejects(createAbTest(r2.bucket, input({name: 'Over the cap', testId: 't_103'})), 409, 'limit');
});

test('paging with two objects per page lists every test and proposes the next TestId', async () => {
  const r2 = memoryR2({pageCap: 2});
  assert.equal(await proposeTestId(r2.bucket, SITE), 'test_site_1');
  for (let i = 1; i <= 5; i++) await createAbTest(r2.bucket, input({name: `Test ${i}`, testId: `test_site_${i * 2}`, now: new Date(NOW.getTime() + i)}));
  const lists = r2.log.lists.length, listed = await listAbTests(r2.bucket, SITE);
  assert.deepEqual(listed.tests.map(t => t.name), ['Test 5', 'Test 4', 'Test 3', 'Test 2', 'Test 1']);
  assert.deepEqual(listed.deleted, []);
  assert.deepEqual(r2.log.lists.slice(lists).filter(l => l.prefix === P + 'records/').map(l => Boolean(l.cursor)), [false, true, true]);
  assert.equal(await proposeTestId(r2.bucket, SITE), 'test_site_11');
  assert.equal(await proposeTestId(memoryR2().bucket, 'news-portal.example'.replace('.', '-')), 'news_portal_exampl_1');
});

test('a tampered record, summary, ZIP or ZIP size is refused', async () => {
  const fresh = async () => { const r2 = memoryR2(); const r = await createAbTest(r2.bucket, input()); return {r2, id: r.record.id, key: `${P}records/${r.record.id}.json`}; };
  const unverifiedRecord = async (mutate) => {
    const {r2, id, key} = await fresh();
    mutate(r2.objects.get(key), r2);
    for (const read of [readAbTest, readAbZip, readAbRecordBytes]) await rejects(read(r2.bucket, SITE, id), 409, 'record-unverified');
    await rejects(addAbTestEvent(r2.bucket, SITE, id, ACTOR, 'marked-live', NOW), 409, 'record-unverified');
  };
  // Bytes differ from their sha256 metadata.
  await unverifiedRecord(stored => { stored.bytes = Buffer.from(text(stored.bytes).replace('"Bid cache"', '"Bid cachf"')); });
  // The sha256 metadata follows the changed bytes, but the id no longer matches the identity.
  await unverifiedRecord(stored => { stored.bytes = Buffer.from(text(stored.bytes).replace('"trafficBPercent": 50', '"trafficBPercent": 51')); stored.customMetadata.sha256 = hash(stored.bytes); });
  // The summary differs from the record.
  await unverifiedRecord(stored => { stored.customMetadata.summary = stored.customMetadata.summary.replace('"Bid cache on"', '"Bid cache ON"'); });
  // Wrong kind.
  await unverifiedRecord(stored => { stored.customMetadata.kind = 'ab-bundle-file'; });
  // A malformed summary is refused by the list.
  {
    const {r2, key} = await fresh();
    r2.objects.get(key).customMetadata.summary = '{"id":"abx-1"}';
    await rejects(listAbTests(r2.bucket, SITE), 409, 'record-unverified');
    r2.objects.get(key).customMetadata.summary = 'not json';
    await rejects(listAbTests(r2.bucket, SITE), 409, 'record-unverified');
  }
  // The ZIP: changed bytes, changed size metadata, missing.
  for (const mutate of [
    zip => { zip.bytes = zip.bytes.slice(); zip.bytes[40] ^= 1; },
    zip => { zip.customMetadata.zipByteSize = String(zip.bytes.length + 1); },
    zip => { zip.bytes = zip.bytes.slice(0, -1); zip.customMetadata.zipByteSize = String(zip.bytes.length); },
    zip => { zip.customMetadata.kind = 'ab-bundle-file'; },
  ]) {
    const {r2, id} = await fresh();
    mutate(r2.objects.get(`${P}zips/${id}.zip`));
    const error = await rejects(readAbZip(r2.bucket, SITE, id), 409, 'zip-unverified');
    assert.equal(error.message, 'ZIP differs from its record.');
  }
  {
    const {r2, id} = await fresh();
    r2.objects.delete(`${P}zips/${id}.zip`);
    await rejects(readAbZip(r2.bucket, SITE, id), 409, 'zip-unverified');
    // A re-save of a verified record does not repair or rewrite anything.
    assert.equal((await createAbTest(r2.bucket, input())).created, false);
  }
  {
    const {r2, id} = await fresh();
    await rejects(readAbTest(r2.bucket, SITE, id.replace(/.$/, c => c === '0' ? '1' : '0')), 404);
    await rejects(readAbTest(r2.bucket, SITE, 'abx-not-an-id'), 404);
    // A tampered record blocks a re-save instead of being silently overwritten.
    const stored = r2.objects.get(`${P}records/${id}.json`);
    stored.customMetadata.summary = stored.customMetadata.summary.replace('"Bid cache on"', '"Bid cache ON"');
    const puts = r2.log.puts.length;
    await rejects(createAbTest(r2.bucket, input()), 409, 'record-unverified');
    assert.equal(r2.log.puts.length, puts);
  }
  // The identity function is what the id is checked against.
  const {r2, id} = await fresh();
  assert.equal('abx-' + hash(abTestIdentity((await readAbTest(r2.bucket, SITE, id)).record)), id);
});

test('an R2 read error on a record is a storage fault (503), never 409 record-unverified', async () => {
  // A body stream that fails says nothing about the stored bytes: the API maps a status-less error to 503 Retry.
  const flaky = (r2, when) => {
    const get = r2.bucket.get;
    r2.bucket.get = async key => {
      const object = await get(key);
      if (object && key.includes('/records/') && when()) object.arrayBuffer = async () => { throw new Error('Network connection lost.'); };
      return object;
    };
    return () => { r2.bucket.get = get; };
  };
  const transient = async promise => {
    const error = await promise.then(() => assert.fail('expected a failure'), e => e);
    assert.equal(error.status, undefined, `${error.status} ${error.code}: ${error.message}`);
    assert.notEqual(error.code, 'record-unverified');
  };
  {
    const r2 = memoryR2(), {record} = await createAbTest(r2.bucket, input());
    flaky(r2, () => true);
    await transient(readAbTest(r2.bucket, SITE, record.id));
    await transient(readAbZip(r2.bucket, SITE, record.id));
    await transient(readAbRecordBytes(r2.bucket, SITE, record.id));
    await transient(createAbTest(r2.bucket, input()));
  }
  {
    // The record put succeeds and only its read-back fails: a retry returns the stored test through the idempotent path.
    const r2 = memoryR2();
    const restore = flaky(r2, () => r2.log.puts.some(key => key.includes('/records/')));
    await transient(createAbTest(r2.bucket, input()));
    restore();
    const retry = await createAbTest(r2.bucket, input());
    assert.equal(retry.created, false);
    assert.deepEqual((await readAbTest(r2.bucket, SITE, retry.record.id)).record, retry.record);
  }
});

test('trash and restore need the exact confirmation and never delete bytes', async () => {
  const r2 = memoryR2();
  const {record} = await createAbTest(r2.bucket, input());
  const id = record.id, zipSha256 = record.bundle.zipSha256, before = keysOf(r2);
  for (const body of [{confirmId: id}, {confirmId: id, sha256: '0'.repeat(64)}, {confirmId: 'abx-' + '0'.repeat(64), sha256: zipSha256}, {confirmId: id, sha256: zipSha256, extra: 1}, null]) {
    const error = await rejects(changeAbTestDeletion(r2.bucket, SITE, id, ACTOR, body, true), 422);
    assert.equal(error.message, 'Confirm the exact saved version before deleting or restoring.');
  }
  assert.deepEqual(keysOf(r2), before);
  await rejects(changeAbTestDeletion(r2.bucket, SITE, 'abx-' + '0'.repeat(64), ACTOR, {confirmId: id, sha256: zipSha256}, true), 404);
  assert.deepEqual(await changeAbTestDeletion(r2.bucket, SITE, id, ACTOR, {confirmId: id, sha256: zipSha256}, true), {ok: true, id, deleted: true});
  assert.deepEqual(keysOf(r2), [...before, `${P}deleted/${id}.json`].sort());
  const marker = JSON.parse(text(r2.objects.get(`${P}deleted/${id}.json`).bytes));
  assert.equal(marker.deletedBy, ACTOR.email);
  let listed = await listAbTests(r2.bucket, SITE);
  assert.deepEqual(listed.tests, []);
  assert.deepEqual(listed.deleted.map(t => [t.id, t.deletedAt]), [[id, marker.deletedAt]]);
  assert.equal((await readAbTest(r2.bucket, SITE, id)).deletedAt, marker.deletedAt);
  assert.deepEqual((await readAbZip(r2.bucket, SITE, id)).zipSha256, zipSha256, 'a deleted test stays downloadable');
  assert.equal((await createAbTest(r2.bucket, input())).deletedAt, marker.deletedAt, 'a re-save reports the trash state');
  assert.deepEqual(await changeAbTestDeletion(r2.bucket, SITE, id, ACTOR, {confirmId: id, sha256: zipSha256}, false), {ok: true, id, deleted: false});
  assert.deepEqual(keysOf(r2), before);
  assert.deepEqual(r2.log.deletes, [`${P}deleted/${id}.json`]);
  listed = await listAbTests(r2.bucket, SITE);
  assert.deepEqual(listed.tests.map(t => [t.id, t.deletedAt]), [[id, null]]);
});

test('events: marked live first, then alternating, at most 50, never on a deleted test', async () => {
  const r2 = memoryR2();
  const {record} = await createAbTest(r2.bucket, input());
  const id = record.id;
  await rejects(addAbTestEvent(r2.bucket, SITE, id, ACTOR, 'marked-paused', NOW), 422);
  let error = await rejects(addAbTestEvent(r2.bucket, SITE, id, ACTOR, 'marked-stopped', NOW), 409);
  assert.equal(error.message, 'Mark the test live before you mark it stopped.');
  const live = await addAbTestEvent(r2.bucket, SITE, id, ACTOR, 'marked-live', NOW);
  assert.deepEqual(live, {schemaVersion: 1, id, seq: 1, type: 'marked-live', at: NOW.toISOString(), by: ACTOR.email});
  assert.deepEqual(r2.objects.get(`${P}events/${id}/0001.json`).customMetadata, {kind: 'ab-test-event', sha256: hash(r2.objects.get(`${P}events/${id}/0001.json`).bytes)});
  error = await rejects(addAbTestEvent(r2.bucket, SITE, id, ACTOR, 'marked-live', NOW), 409);
  assert.equal(error.message, 'This A/B test is already marked live.');
  for (let seq = 2; seq <= 50; seq++) await addAbTestEvent(r2.bucket, SITE, id, ACTOR, seq % 2 ? 'marked-live' : 'marked-stopped', NOW);
  const read = await readAbTest(r2.bucket, SITE, id);
  assert.deepEqual(read.events.map(e => e.seq), Array.from({length: 50}, (_, i) => i + 1));
  assert.equal(read.events.at(-1).type, 'marked-stopped');
  error = await rejects(addAbTestEvent(r2.bucket, SITE, id, ACTOR, 'marked-live', NOW), 409);
  assert.match(error.message, /already has 50 live and stopped marks/);
  // A deleted test takes no new event.
  const r3 = memoryR2(), other = (await createAbTest(r3.bucket, input())).record;
  await changeAbTestDeletion(r3.bucket, SITE, other.id, ACTOR, {confirmId: other.id, sha256: other.bundle.zipSha256}, true);
  error = await rejects(addAbTestEvent(r3.bucket, SITE, other.id, ACTOR, 'marked-live', NOW), 409);
  assert.equal(error.message, 'This A/B test is deleted. Restore it before you mark it live or stopped.');
  assert.equal(keysOf(r3).some(k => k.includes('/events/')), false);
  await rejects(addAbTestEvent(r3.bucket, SITE, 'abx-' + '1'.repeat(64), ACTOR, 'marked-live', NOW), 404);
  // A tampered event is refused on read.
  r2.objects.get(`${P}events/${id}/0002.json`).bytes[5] ^= 1;
  await rejects(readAbTest(r2.bucket, SITE, id), 409, 'record-unverified');
});

test('two concurrent "marked live" clicks give one event and one 409', async () => {
  const r2 = memoryR2();
  const {record} = await createAbTest(r2.bucket, input());
  const outcomes = await Promise.allSettled([1, 2].map(() => addAbTestEvent(r2.bucket, SITE, record.id, ACTOR, 'marked-live', NOW)));
  assert.equal(outcomes.filter(o => o.status === 'fulfilled').length, 1);
  const [refused] = outcomes.filter(o => o.status === 'rejected').map(o => o.reason);
  assert.equal(refused.status, 409);
  assert.equal(refused.message, 'Someone else changed this test. Reload A/B tests.');
  assert.deepEqual((await readAbTest(r2.bucket, SITE, record.id)).events.map(e => e.type), ['marked-live']);
});

test('the store writes only create-only objects under its own site prefix', async () => {
  const r2 = memoryR2({prefix: P});
  await createAbTest(r2.bucket, input());
  assert.ok(keysOf(r2).every(k => k.startsWith(P)));
  assert.throws(() => abPrefix('Bad Site'), TypeError);
  await assert.rejects(createAbTest(r2.bucket, input({actor: {}})), TypeError);
  // Composer refusals keep their status, code and check.
  const gam = await rejects(createAbTest(r2.bucket, input({b: D.gam, testId: 'gam_1'})), 422, 'prebid-differs');
  assert.equal(gam.check, 'prebid');
  await rejects(createAbTest(r2.bucket, input({testId: 'Bad-Id'})), 400, 'invalid-request');
});
