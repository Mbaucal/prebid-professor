import {mkdir, readdir, readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {dirname, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runtimeCatalog, buildArtifactCandidate, previewInput} from '../worker/test-workspace/runtime-catalog.mjs';
import {pinRuntime} from '../worker/runtime/version-pin.mjs';
import {prebidRequirements, inspectPrebidArtifact, sha256} from '../worker/runtime/prebid-artifact-check.mjs';
import {describeCandidate} from '../worker/runtime/draft-release-store.mjs';
import {composeAbBundle} from '../worker/experiments/ab-bundle.mjs';
import {AA_RELEASE, instrumentFullRuntime, staticAALoader} from '../worker/experiments/static-aa-v1.mjs';
import {PAGES_HEADERS} from './pages-release-verification.mjs';
import {bidCacheSite} from '../tests/runtime/bid-cache323-site.mjs';

// Fixtures for scripts/verify-ab-loader-browser.py (MBA-416 P1). Two saved versions of the
// synthetic, non-Tanjug bid cache site are generated through the TEST workspace Generate path,
// as scripts/prepare-bidcache323-browser.mjs does: A is 3.21.2, B is 3.23.0 with bid cache on,
// both with the same Prebid.js file. composeAbBundle then builds the publisher-ab-v1 bundles
// the browser check serves. Nothing is saved, uploaded or deployed.
//
// node scripts/prepare-ab-loader-browser.mjs <output> [--prebid <dir>]
//   <output>: an empty or new folder outside the repository, for example "$RUNNER_TEMP/ab-loader".
//   --prebid: a folder with prebid.js and prebid-config.json ({version, modules}).
//     Default: the vendored Prebid.js 11.34.0 (vendor/prebid/tanjug-11.34.0).
// Output:
//   bundles/<name>/bundle.zip and record.json: ab (B 50%), aa (A/A), b0 and b100.
//   direct/: version A as a normal publisher-scripts-v1 deployment (ads.js = ads.min.js).
//   pilot/: the Tanjug pilot loader (static-aa-v1) with version A's runtime instrumented for it.
//   manifest.json: the sha256 of every file above, the release ids and the Prebid version.
const USAGE = 'Usage: node scripts/prepare-ab-loader-browser.mjs <output folder outside the repository> [--prebid <dir>]';
const args = process.argv.slice(2), root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let out = null, prebidDir = resolve(root, 'vendor/prebid/tanjug-11.34.0');
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--prebid' && args[i + 1]) prebidDir = resolve(args[++i]);
  else if (!out && !args[i].startsWith('--')) out = resolve(args[i]);
  else throw Error(USAGE);
}
if (!out) throw Error(USAGE);
// Generated bundles are test fixtures, never repository files.
if (out === root || out.startsWith(root + sep)) throw Error('Choose an output folder outside the repository, for example "$RUNNER_TEMP/ab-loader".');
if ((await readdir(out).catch(() => [])).length) throw Error(`${out} is not empty. Choose a new or empty folder.`);

const SITE = 'bc-site', STAMP = '20261115_120000';
const bytes = await readFile(resolve(prebidDir, 'prebid.js'));
const {version, modules} = JSON.parse(await readFile(resolve(prebidDir, 'prebid-config.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(version) || !Array.isArray(modules) || !modules.length) throw Error('prebid-config.json needs a version and a module list.');
if (!bytes.includes(Buffer.from(`"v${version}"`))) throw Error(`prebid.js is not Prebid.js ${version}.`);
const hex = data => createHash('sha256').update(data).digest('hex');
const sri = data => 'sha384-' + createHash('sha384').update(data).digest('base64');

/** One saved version, shaped as readPackage returns a TEST draft ({files, release}). */
async function savedVersion(runtimeId, cache, note) {
  const descriptor = runtimeCatalog.find(release => release.id === runtimeId);
  if (!descriptor) throw Error(`Register ${runtimeId} before preparing the A/B browser check.`);
  const snapshot = bidCacheSite({cache}), config = JSON.parse(snapshot.config.config_json);
  const requirements = prebidRequirements(previewInput(snapshot, descriptor, STAMP), config);
  const build = {id: 'synthetic-build', publisher_id: SITE, status: 'current', version,
    file_key: `publishers/${SITE}/prebid-builds/synthetic-build/prebid.js`, modules_json: JSON.stringify(modules)};
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const object = {size: bytes.byteLength, customMetadata: {sha256: await sha256(buffer), version}, async arrayBuffer() { return buffer; }};
  const report = await inspectPrebidArtifact({siteId: SITE, builds: [build], requirements}, {async get() { return object; }});
  const candidate = await buildArtifactCandidate({snapshot, pin: pinRuntime(descriptor), buildTimestamp: STAMP, prebid: {bytes: buffer, report}});
  // The draft id is computed exactly as saveDraftRelease computes it; composeAbBundle checks it again.
  const {descriptor: draft, files} = await describeCandidate(SITE, candidate);
  return {files, release: {id: draft.releaseId, siteId: SITE, note, runtime: draft.runtime, prebidBuild: draft.prebidBuild, packageSha256: draft.packageSha256}};
}
const A = await savedVersion('tessera-3.21.2', undefined, 'Bid cache off');
const B = await savedVersion('tessera-3.23.0', {enabled: true, maxBidAgeSeconds: 60}, 'Bid cache on');
if (A.release.runtime.runtimeVersion !== '3.21.2' || B.release.runtime.runtimeVersion !== '3.23.0') throw Error('Expected versions 3.21.2 and 3.23.0.');

const written = {};
async function put(path, data) {
  const file = resolve(out, path);
  await mkdir(dirname(file), {recursive: true});
  await writeFile(file, data, {flag: 'wx'});
  written[path] = hex(data);
}
const TESTS = {
  ab: {a: A, b: B, trafficBPercent: 50, testId: 'bc_site_1', name: 'Bid cache 3.23.0'},
  aa: {a: A, b: A, trafficBPercent: 50, testId: 'bc_site_2', name: 'A/A 3.21.2'},
  b0: {a: A, b: B, trafficBPercent: 0, testId: 'bc_site_3', name: 'Bid cache 3.23.0 at 0%'},
  b100: {a: A, b: B, trafficBPercent: 100, testId: 'bc_site_4', name: 'Bid cache 3.23.0 at 100%'},
};
const bundles = {};
for (const [name, input] of Object.entries(TESTS)) {
  const bundle = await composeAbBundle({site: SITE, ...input});
  await put(`bundles/${name}/bundle.zip`, bundle.zip);
  await put(`bundles/${name}/record.json`, JSON.stringify(bundle.record, null, 2) + '\n');
  bundles[name] = {id: bundle.id, testId: input.testId, name: input.name, trafficBPercent: input.trafficBPercent, zipSha256: bundle.zipSha256,
    files: Object.keys(bundle.files)};
}
// Version A as it runs without a test: publisher-scripts-v1 serves ads.min.js as ads.js.
await put('direct/ads.js', A.files['ads.min.js']);
await put('direct/prebid.js', A.files['prebid.js']);
await put('direct/_headers', PAGES_HEADERS);
// The Tanjug pilot loader is loadable offline: render it with version A's full runtime as both arms.
const pilotArm = Buffer.from(instrumentFullRuntime(new TextDecoder().decode(A.files['ads.js'])));
const arm = {path: 'releases/aa/runtime.js', integrity: sri(pilotArm)};
await put('pilot/releases/aa/runtime.js', pilotArm);
await put('pilot/ads.js', staticAALoader({release: AA_RELEASE, baseRuntime: '3.21.2', prebidVersion: version, prebidPath: 'prebid.js',
  prebidIntegrity: sri(A.files['prebid.js']), armSha256: hex(pilotArm), positions: ['Billboard', 'P1'], arms: {A: arm, B: arm}}));
const versions = Object.fromEntries([['A', A], ['B', B]].map(([side, v]) => [side, {release: v.release.id, name: v.release.note,
  runtimeVersion: v.release.runtime.runtimeVersion, adsMinSha256: hex(v.files['ads.min.js'])}]));
await writeFile(resolve(out, 'manifest.json'), JSON.stringify({schema: 'tessera-ab-browser-fixtures-1', site: SITE,
  prebid: {version, modules, sha256: hex(bytes)}, versions, bundles, pilot: {release: AA_RELEASE, arm: arm.path}, files: written}, null, 2) + '\n', {flag: 'wx'});
console.log(`Prepared ${Object.keys(bundles).length} A/B bundles of ${SITE} (A 3.21.2, B 3.23.0 with bid cache, Prebid.js ${version}) in ${out}.`);
