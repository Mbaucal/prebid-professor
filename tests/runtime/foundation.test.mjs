import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertBuildTimestamp, extractReference391 } from '../../scripts/extract-reference391.mjs';
import { validateRuntimeDescriptor, pinRuntime, assertPinnedRuntime } from '../../worker/runtime/version-pin.mjs';

// Synthetic descriptors only: these are not released Tessera versions.
const fixture = (changes = {}) => ({ id: 'fixture', version: '1.0.0', codeSha256: 'a'.repeat(64),
  channel: 'stable', configSchemaVersion: 1, capabilities: ['banner', 'takeover'], ...changes });
const requirements = { configSchemaVersion: 1, capabilities: ['banner'] };

test('pin stores exact version, bundle hash and schema without channel alias', () => {
  const pin = pinRuntime(fixture());
  assert.equal(pin.runtimeVersion, '1.0.0');
  assert.equal(pin.runtimeSha256, 'a'.repeat(64));
  assert.equal('channel' in pin, false);
});
test('stable descriptor and pin are immutable copies', () => {
  const input = fixture();
  const descriptor = validateRuntimeDescriptor(input);
  const pin = pinRuntime(input);
  input.capabilities.push('newFeature');
  assert.equal(descriptor.capabilities.length, 2);
  assert.equal(pin.capabilities.length, 2);
  assert.throws(() => pin.capabilities.push('newFeature'), TypeError);
});
test('preview selection is explicit', () => {
  const preview = fixture({ version: '1.1.0-preview.1', channel: 'preview' });
  assert.throws(() => pinRuntime(preview), /explicit opt-in/);
  assert.throws(() => pinRuntime(preview, { allowPreview: 'false' }), /explicit opt-in/);
  assert.equal(pinRuntime(preview, { allowPreview: true }).runtimeVersion, '1.1.0-preview.1');
});
test('an already selected preview remains pinned when promoted to stable', () => {
  const preview = fixture({ channel: 'preview' });
  assert.doesNotThrow(() => assertPinnedRuntime(pinRuntime(preview, { allowPreview: true }), fixture(), requirements));
});
test('latest/stable/range aliases cannot become exact version pins', () => {
  for (const version of ['latest', 'stable', '^1.0.0', '1.x', '']) {
    assert.throws(() => pinRuntime(fixture({ version })), /exact runtime version/);
  }
});
test('changing default stable does not upgrade an existing pin', () => {
  const pin = pinRuntime(fixture());
  assert.throws(() => assertPinnedRuntime(pin, fixture({ version: '1.1.0' }), requirements), /Explicit upgrade/);
});
test('reusing version name with different bundled code is rejected', () => {
  assert.throws(() => assertPinnedRuntime(pinRuntime(fixture()), fixture({ codeSha256: 'b'.repeat(64) }), requirements), /Explicit upgrade/);
});
test('schema mismatch is rejected', () => {
  assert.throws(() => assertPinnedRuntime(pinRuntime(fixture()), fixture(), { ...requirements, configSchemaVersion: 2 }), /incompatible/);
});
test('missing advanced capabilities are not silently dropped', () => {
  assert.throws(() => assertPinnedRuntime(pinRuntime(fixture()), fixture(), { ...requirements, capabilities: ['sequenceRefresh'] }), /sequenceRefresh/);
});
test('capability declarations cannot drift for the same pin', () => {
  assert.throws(() => assertPinnedRuntime(pinRuntime(fixture()), fixture({ capabilities: ['banner'] }), requirements), /Explicit upgrade/);
});
test('malformed hashes, capabilities and versions fail validation', () => {
  for (const input of [fixture({ codeSha256: '123' }), fixture({ capabilities: ['banner', 'banner'] }),
    fixture({ configSchemaVersion: 0 }), fixture({ capabilities: [''] }), null]) {
    assert.throws(() => validateRuntimeDescriptor(input));
  }
});
test('timestamp is supplied explicitly and is calendar-valid', () => {
  assert.equal(assertBuildTimestamp('20260911_090000'), '20260911_090000');
  assert.equal(assertBuildTimestamp('20240229_235959'), '20240229_235959');
  for (const bad of [undefined, '', '20260229_000000', '20260931_090000', '20261301_000000', '20260911_240000']) {
    assert.throws(() => assertBuildTimestamp(bad));
  }
});
test('extractor refuses source that is not the approved reference', () => {
  assert.throws(() => extractReference391(new TextEncoder().encode('function buildScript() {}')), /checksum mismatch/);
  assert.throws(() => extractReference391('not bytes'), TypeError);
});
