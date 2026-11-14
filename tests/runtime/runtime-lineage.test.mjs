import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parse} from 'acorn';
import {runtimeReleaseHistory} from '../../worker/runtime/runtime-release-history.mjs';

// Registry order is insertion order (newest first), not semver. Every stable
// record registered after the audited 3.21.1 correction must carry the complete
// source closure and capabilities of the stable record registered before it, so
// the audit fixes can never be dropped by a later version. Records registered
// before 3.21.1 (TEST 3.22.0 and older) are frozen and exempt.
const BASE = 'tessera-3.21.1';
async function closure(manifest) {
  const source = await readFile(new URL('../../' + manifest, import.meta.url), 'utf8');
  const lists = [];
  (function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'VariableDeclarator' && node.id?.name === 'sourceFiles') lists.push(node.init.elements.map(item => item.value));
    for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(visit); else if (value && typeof value === 'object') visit(value);
  })(parse(source, {ecmaVersion: 'latest', sourceType: 'module'}));
  assert.equal(lists.length, 1, manifest + ' must declare one literal sourceFiles list');
  return new Set(lists[0]);
}
export async function assertBuiltOnAuditCorrections(history) {
  const index = history.findIndex(release => release.id === BASE);
  assert(index >= 0, 'The audited 3.21.1 record must stay registered.');
  // Walk from 3.21.1 towards the newest record; each stable record must cover its stable predecessor.
  let previous = history[index], required = await closure(previous.sourceManifest);
  for (const release of history.slice(0, index).reverse().filter(release => release.channel === 'stable')) {
    const files = await closure(release.sourceManifest);
    assert.deepEqual([...required].filter(path => !files.has(path)), [], `${release.version} must include the ${previous.id} source closure`);
    assert.deepEqual(previous.capabilities.filter(name => !release.capabilities.includes(name)), [], `${release.version} must keep every ${previous.id} capability`);
    previous = release; required = files;
  }
}
test('every stable runtime registered after 3.21.1 is built on the 3.21.1 corrections', () => assertBuiltOnAuditCorrections(runtimeReleaseHistory));
test('a newer stable record built on 3.21.0 is rejected', async () => {
  const forged = {...runtimeReleaseHistory.find(release => release.id === BASE), id: 'tessera-9.9.9', version: '9.9.9', sourceManifest: 'scripts/prepare-runtime321.mjs'};
  await assert.rejects(assertBuiltOnAuditCorrections([forged, ...runtimeReleaseHistory]), /must include the tessera-3\.21\.\d source closure/);
});
test('a newer stable record that drops a 3.21.1 capability is rejected', async () => {
  const top = runtimeReleaseHistory[0];
  const forged = {...top, id: 'tessera-9.9.9', version: '9.9.9', capabilities: top.capabilities.filter(name => name !== 'consent-readiness')};
  await assert.rejects(assertBuiltOnAuditCorrections([forged, ...runtimeReleaseHistory]), /must keep every tessera-3\.21\.\d capability/);
});
test('the newest stable record, the current recommendation, contains every 3.21.1 source file and capability', async () => {
  const current = runtimeReleaseHistory.find(release => release.channel === 'stable'), base = runtimeReleaseHistory.find(release => release.id === BASE);
  const files = await closure(current.sourceManifest), audited = await closure(base.sourceManifest);
  assert.deepEqual([...audited].filter(path => !files.has(path)), [], `${current.version} must include the 3.21.1 source closure`);
  assert.deepEqual(base.capabilities.filter(name => !current.capabilities.includes(name)), []);
  for (const path of ['worker/runtime-3211/browser-storage.mjs', 'worker/runtime-3211/storage-compiler.mjs', 'worker/runtime-3211/compiler.mjs']) assert(files.has(path), path);
});
