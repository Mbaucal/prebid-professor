import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { zipSync } from 'fflate';
import { runtimeDescriptor } from '../worker/runtime/builtin-preview-service.mjs';
import { pinRuntime } from '../worker/runtime/version-pin.mjs';
import { previewInput } from '../worker/runtime/preview-snapshot.mjs';
import { prebidRequirements, inspectPrebidArtifact, sha256, parsePrebidHeader } from '../worker/runtime/prebid-artifact-check.mjs';
import { buildArtifactCandidate } from '../worker/runtime/artifact-candidate.mjs';
import { describeCandidate } from '../worker/runtime/draft-release-store.mjs';
import { tanjugPreview } from '../worker/pilots/tanjug-preview.mjs';

// Reproducible, offline, independent of every hosted setting and storage binding.
const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root));
const pilot = JSON.parse(read('worker/pilots/tanjug-v1.json'));
const { snapshot, buildTimestamp } = pilot;
const pin = pinRuntime(runtimeDescriptor, { allowPreview: true });
assert.equal(pin.runtimeVersion, pilot.runtimeVersion, 'Pilot requires an explicit runtime upgrade.');
assert.equal(pin.runtimeSha256, pilot.runtimeSha256);
const original = read('vendor/prebid/tanjug-11.34.0/prebid.js');
const bytes = original.buffer.slice(original.byteOffset, original.byteOffset + original.byteLength);
assert.equal(bytes.byteLength, pilot.prebid.byteSize);
assert.equal(await sha256(bytes), pilot.prebid.sha256);
assert.deepEqual(parsePrebidHeader(original.toString()), { version: pilot.prebid.version, modules: pilot.prebid.modules });
const requirements = prebidRequirements(previewInput(snapshot, runtimeDescriptor, buildTimestamp), JSON.parse(snapshot.config.config_json));
assert.deepEqual(requirements.modules, pilot.prebid.modules);
const build = { id: 'tanjug-11-34-0-v1', publisher_id: snapshot.site.id, status: 'current',
  version: pilot.prebid.version, modules_json: JSON.stringify(pilot.prebid.modules) };
build.file_key = `publishers/${snapshot.site.id}/prebid-builds/${build.id}/prebid.js`;
const report = await inspectPrebidArtifact({ siteId: snapshot.site.id, builds: [build], requirements }, {
  async get(key) { assert.equal(key, build.file_key); return { size: bytes.byteLength,
    customMetadata: { sha256: pilot.prebid.sha256, version: pilot.prebid.version }, async arrayBuffer() { return bytes.slice(0); } }; },
});
assert.equal(report.status, 'checked', JSON.stringify(report.issues));
const candidate = await buildArtifactCandidate({ snapshot, buildTimestamp, pin, takeOver: { enabled: false }, prebid: { report, bytes } });
const { descriptor } = await describeCandidate(snapshot.site.id, candidate);
const entries = Object.fromEntries(Object.entries(candidate.files).map(([name, value]) => [name, [value, { level: 0, mtime: new Date(1980, 0, 1, 0, 0, 0) }]]));
const zip = zipSync(entries, { level: 0 });
const directory = new URL('.generated/tanjug-pilot/', root);
mkdirSync(directory, { recursive: true });
for (const [name, value] of Object.entries(candidate.files)) writeFileSync(new URL(name, directory), value);
writeFileSync(new URL(`${pilot.version}.zip`, directory), zip);
const metadata = { version: pilot.version, descriptor, manifest: candidate.manifest, changes: pilot.changes, zipSha256: await sha256(zip) };
const previewHtml = tanjugPreview(candidate.files, snapshot.units, read('tests/runtime/mock-ad-libraries.js').toString());
writeFileSync(new URL('preview.html', directory), previewHtml);
writeFileSync(new URL('metadata.json', directory), JSON.stringify(metadata, null, 2) + '\n');
// Only serialized bytes. The publisher's Prebid code is never imported/executed.
writeFileSync(new URL('.generated/tanjug-pilot.mjs', root),
  `export const metadata=${JSON.stringify(metadata)};\nexport const zipBase64=${JSON.stringify(Buffer.from(zip).toString('base64'))};\nexport const previewHtml=${JSON.stringify(previewHtml)};\nexport const prebidConfig=${JSON.stringify({ version: pilot.prebid.version, modules: pilot.prebid.modules })};\n`);
console.log(`Prepared ${pilot.version}: ${Object.keys(candidate.files).length} files, ${snapshot.units.length} positions, Prebid ${pilot.prebid.version}; no hosted reads or writes.`);
