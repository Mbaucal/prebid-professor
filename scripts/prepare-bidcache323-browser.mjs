import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {runtimeCatalog, buildArtifactCandidate} from '../worker/test-workspace/runtime-catalog.mjs';
import {pinRuntime} from '../worker/runtime/version-pin.mjs';
import {prebidRequirements, inspectPrebidArtifact, sha256} from '../worker/runtime/prebid-artifact-check.mjs';
import {previewInput} from '../worker/runtime-323/snapshot.mjs';
import {bidCacheSite} from '../tests/runtime/bid-cache323-site.mjs';

// Saved 3.23.0 packages for scripts/verify-bidcache323-browser.py, generated through
// the TEST workspace Generate path from a synthetic, non-Tanjug site, with the
// vendored Prebid.js 11.34.0 file as the site's Prebid build. Each scenario keeps the
// package's ads.js, ads.min.js, prebid.js and config.json; nothing is deployed.
const output = new URL('../.generated/bidcache323-browser/', import.meta.url);
const vendor = new URL('../vendor/prebid/tanjug-11.34.0/', import.meta.url);
const stamp = '20261115_120000';
const descriptor = runtimeCatalog.find(release => release.id === 'tessera-3.23.0');
if (!descriptor) throw Error('Register Tessera 3.23.0 before preparing the bid cache browser check.');
const scenarios = {
  on: {enabled: true, maxBidAgeSeconds: 60},
  off: {enabled: false, maxBidAgeSeconds: 60},
  override: {enabled: true, maxBidAgeSeconds: 60, positionOverrides: {Billboard: false}},
};
const bytes = await readFile(new URL('prebid.js', vendor));
const modules = JSON.parse(await readFile(new URL('prebid-config.json', vendor), 'utf8')).modules;
const files = {};
await mkdir(output, {recursive: true});
for (const [name, cache] of Object.entries(scenarios)) {
  const snapshot = bidCacheSite({cache}), config = JSON.parse(snapshot.config.config_json);
  const requirements = prebidRequirements(previewInput(snapshot, descriptor, stamp), config);
  const build = {id: 'vendored', publisher_id: snapshot.site.id, status: 'current', version: '11.34.0',
    file_key: `publishers/${snapshot.site.id}/prebid-builds/vendored/prebid.js`, modules_json: JSON.stringify(modules)};
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const object = {size: bytes.byteLength, customMetadata: {sha256: await sha256(buffer), version: '11.34.0'}, async arrayBuffer() { return buffer; }};
  const report = await inspectPrebidArtifact({siteId: snapshot.site.id, builds: [build], requirements}, {async get() { return object; }});
  const candidate = await buildArtifactCandidate({snapshot, pin: pinRuntime(descriptor), buildTimestamp: stamp, prebid: {bytes: buffer, report}});
  await mkdir(new URL(name + '/', output), {recursive: true});
  for (const file of ['ads.js', 'ads.min.js', 'prebid.js', 'config.json']) {
    const data = candidate.files[file];
    if (!data) throw Error(`The ${name} package has no ${file}.`);
    await writeFile(new URL(`${name}/${file}`, output), data);
    files[`${name}/${file}`] = createHash('sha256').update(data).digest('hex');
  }
  const saved = JSON.parse(new TextDecoder().decode(candidate.files['config.json']));
  if (saved.runtime.runtimeVersion !== '3.23.0') throw Error('Expected a 3.23.0 package.');
  if (files[`${name}/prebid.js`] !== createHash('sha256').update(bytes).digest('hex')) throw Error('The package must ship the vendored Prebid.js bytes.');
}
await writeFile(new URL('manifest.json', output), JSON.stringify({runtime: {id: descriptor.id, codeSha256: descriptor.codeSha256}, scenarios, files}, null, 2) + '\n');
console.log(`Prepared ${Object.keys(scenarios).length} generated 3.23.0 packages for the bid cache browser check.`);
