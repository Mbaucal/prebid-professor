import test from 'node:test';
import assert from 'node:assert/strict';
import { prebidRequirements, inspectPrebidArtifact, sha256, parsePrebidHeader } from '../../worker/runtime/prebid-artifact-check.mjs';
const input = () => ({ core: { bidders: [{ bidder: 'openx', params: {} }], userSync: { userIds: [] } },
  options: { enablePrebid: true, floors: { enabled: false }, currencyConversion: { enabled: false } } });
const modules = ['openxBidAdapter', 'consentManagementTcf', 'tcfControl'];
const source = (list = modules, version = '11.11.0') => `/* prebid.js v${version}\nModules: ${list.join(', ')} */\nglobalThis.__testPrebidMustNotExecute = true;`;
async function fixture() {
  const bytes = new TextEncoder().encode(source()).buffer;
  const build = { id: 'build-1', publisher_id: 'test-site', version: '11.11.0', status: 'current',
    file_key: 'publishers/test-site/prebid-builds/build-1/prebid.js', modules_json: JSON.stringify(modules) };
  const object = { size: bytes.byteLength, customMetadata: { sha256: await sha256(bytes), version: build.version }, async arrayBuffer() { return bytes; } };
  let reads = 0;
  const bucket = { async get(key) { reads++; assert.equal(key, build.file_key); return object; },
    put() { assert.fail('No writes allowed'); }, delete() { assert.fail('No deletions allowed'); }, list() { assert.fail('No listing allowed'); } };
  const args = { siteId: 'test-site', builds: [build], requirements: prebidRequirements(input()) };
  return { args, build, bucket, object, bytes, reads: () => reads, inspect: () => inspectPrebidArtifact(args, bucket) };
}

test('uses normalized bidder requirements and CMP modules', () => assert.deepEqual(prebidRequirements(input()).modules, [...modules].sort()));
test('requires explicit normalized input rather than guessed settings', () => assert.throws(() => prebidRequirements({}), /Normalized/));
test('explicitly disabled floors/currency do not add unused modules', () => {
  const result = prebidRequirements(input()); assert(!result.modules.includes('priceFloors')); assert(!result.modules.includes('currency'));
});
test('floors and currency add modules when enabled', () => {
  const value = input(); value.options.floors.enabled = true; value.options.currencyConversion.enabled = true;
  const result = prebidRequirements(value); assert(result.modules.includes('priceFloors')); assert(result.modules.includes('currency'));
});
test('User IDs add the userId core and exact known system module', () => {
  const value = input(); value.core.userSync.userIds = [{ name: 'id5Id' }, { name: 'sharedId' }];
  const result = prebidRequirements(value); assert(result.modules.includes('id5IdSystem')); assert(result.modules.includes('userId'));
});
test('an explicit custom User ID module code is usable', () => {
  const value = input(); value.core.userSync.userIds = [{ name: 'customIdentity' }];
  const result = prebidRequirements(value, { userIdConfig: { modules: [{ name: 'customIdentity', moduleCode: 'customIdentityIdSystem', enabled: true }] } });
  assert(result.modules.includes('customIdentityIdSystem')); assert.equal(result.issues.length, 0);
});
test('wrong explicit known User ID mapping is not accepted', () => {
  const value = input(); value.core.userSync.userIds = [{ name: 'id5Id' }];
  const result = prebidRequirements(value, { userIdConfig: { modules: [{ name: 'id5Id', moduleCode: 'sharedIdSystem', enabled: true }] } });
  assert.equal(result.issues[0].code, 'unmapped_user_id');
});
test('unknown bidder cannot produce a false checked result', async () => {
  const f = await fixture(); const value = input(); value.core.bidders = [{ bidder: 'unknownAlias' }];
  f.args.requirements = prebidRequirements(value); assert.equal((await f.inspect()).status, 'blocked');
});
test('Object prototype names are not module mappings', () => {
  const value = input(); value.core.bidders = [{ bidder: 'constructor' }]; value.core.userSync.userIds = [{ name: 'toString' }];
  assert.deepEqual(prebidRequirements(value).issues.map((i) => i.code), ['unmapped_bidder', 'unmapped_user_id']);
});
test('GPT-only mode never touches R2', async () => {
  const f = await fixture(); const value = input(); value.options.enablePrebid = false; f.args.requirements = prebidRequirements(value);
  const report = await inspectPrebidArtifact(f.args, { get() { assert.fail('GPT-only must not read R2'); } });
  assert.equal(report.status, 'not_required'); assert.deepEqual(report.requiredModules, []);
});
test('checks bytes and declarations without executing source or calling the network', async () => {
  const f = await fixture(); const originalFetch = globalThis.fetch;
  globalThis.fetch = () => assert.fail('No external network');
  try { const report = await f.inspect(); assert.equal(report.status, 'checked'); assert.equal(report.completeRelease, false); assert.equal(report.build.sha256, await sha256(f.bytes)); assert.equal(globalThis.__testPrebidMustNotExecute, undefined); }
  finally { globalThis.fetch = originalFetch; }
});
for (const builds of [[], [{}, {}]]) test(`requires exactly one current build (${builds.length})`, async () => {
  const f = await fixture(); f.args.builds = builds; assert.equal((await f.inspect()).issues[0].code, 'current_build_missing_or_ambiguous'); assert.equal(f.reads(), 0);
});
for (const field of ['publisher_id', 'status']) test(`rejects wrong ${field} before storage access`, async () => {
  const f = await fixture(); f.build[field] = 'wrong'; assert.equal((await f.inspect()).issues[0].code, 'build_site_mismatch'); assert.equal(f.reads(), 0);
});
test('rejects a foreign file path without reading R2', async () => {
  const f = await fixture(); f.build.file_key = 'publishers/other/prebid-builds/build-1/prebid.js';
  assert.equal((await f.inspect()).issues[0].code, 'unverified_build_path'); assert.equal(f.reads(), 0);
});
test('does not use arbitrary remote file_url values', async () => {
  const f = await fixture(); f.build.file_url = 'https://example.invalid/no-fetch'; assert.equal((await f.inspect()).status, 'checked'); assert.equal(f.reads(), 1);
});
test('missing adapter is explicitly listed', async () => {
  const f = await fixture(); f.args.requirements.modules.push('pubmaticBidAdapter'); const report = await f.inspect();
  assert.equal(report.status, 'blocked'); assert(report.missingModules.includes('pubmaticBidAdapter'));
});
test('metadata module list cannot disagree with the actual file header', async () => {
  const f = await fixture(); f.build.modules_json = JSON.stringify([...modules, 'currency']);
  assert.equal((await f.inspect()).issues.at(-1).code, 'module_metadata_mismatch');
});
test('checks the full file checksum', async () => {
  const f = await fixture(); f.object.customMetadata.sha256 = '0'.repeat(64);
  assert.equal((await f.inspect()).issues.at(-1).code, 'checksum_mismatch');
});
test('missing upload checksum blocks verification before body read', async () => {
  const f = await fixture(); delete f.object.customMetadata.sha256; f.object.arrayBuffer = () => assert.fail('Body must not be read');
  assert.equal((await f.inspect()).issues.at(-1).code, 'checksum_missing');
});
test('version mismatch is not accepted', async () => {
  const f = await fixture(); f.build.version = '11.12.0'; assert.equal((await f.inspect()).issues.at(-1).code, 'version_mismatch');
});
test('HTML stored as JS cannot pass', async () => {
  const f = await fixture(); const bytes = new TextEncoder().encode('<html><!--not javascript--></html>').buffer;
  f.object.size = bytes.byteLength; f.object.customMetadata.sha256 = await sha256(bytes); f.object.arrayBuffer = async () => bytes;
  assert.equal((await f.inspect()).issues.at(-1).code, 'invalid_build_content');
});
test('unreadable UTF-8 fails explicitly', async () => {
  const f = await fixture(); const bytes = new Uint8Array([0xff, 0xff]).buffer;
  f.object.size = bytes.byteLength; f.object.customMetadata.sha256 = await sha256(bytes); f.object.arrayBuffer = async () => bytes;
  assert.equal((await f.inspect()).issues.at(-1).code, 'invalid_build_header');
});
for (const size of [0, 20 * 1024 * 1024 + 1]) test(`invalid R2 object size ${size} is not downloaded`, async () => {
  const f = await fixture(); f.object.size = size; f.object.arrayBuffer = () => assert.fail('Body must not be read');
  assert.equal((await f.inspect()).issues.at(-1).code, 'invalid_build_size');
});
test('a body/size mismatch is rejected', async () => {
  const f = await fixture(); f.object.size++; assert.equal((await f.inspect()).issues.at(-1).code, 'build_size_mismatch');
});
test('missing R2 file is reported', async () => {
  const f = await fixture(); f.bucket.get = async () => null; assert.equal((await f.inspect()).issues.at(-1).code, 'build_file_missing');
});
test('R2 failure does not expose internal key/error details', async () => {
  const f = await fixture(); f.bucket.get = async () => { throw new Error('sensitive-service-details'); }; const report = await f.inspect();
  assert.equal(report.issues.at(-1).code, 'storage_read_failed'); assert(!JSON.stringify(report).includes('sensitive-service-details'));
});
test('invalid modules metadata is not silently treated as empty', async () => {
  const f = await fixture(); f.build.modules_json = 'oops'; assert.equal((await f.inspect()).issues[0].code, 'invalid_module_metadata'); assert.equal(f.reads(), 0);
});
test('module names in header must be plain identifiers', () => {
  assert.throws(() => parsePrebidHeader(source(['openxBidAdapter', '<script>']))); assert.throws(() => parsePrebidHeader('// prebid.js v11.11.0 Modules: x'));
});
