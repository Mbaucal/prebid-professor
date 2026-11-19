import {createHash} from 'node:crypto';
import {describeCandidate} from '../../worker/runtime/draft-release-store.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const bytesOf = value => typeof value === 'string' ? new TextEncoder().encode(value) : value;

/** A tiny TEST draft from fixed bytes that describeCandidate accepts, shaped as readPackage returns
 * it ({files, release}). No generator is involved (same recipe as the golden draft in
 * tests/runtime/ab-bundle.test.mjs). prebid:false makes a GAM-only version; adsMin replaces only
 * ads.min.js, so a large arm stays within the 12 MB package limit. */
export async function syntheticDraft({siteId = 'test-site', runtimeVersion = '9.0.0', script = 'window.arm = "A";\n', adsMin = null, note = 'Version A', prebid = true, options = {}} = {}) {
  const guarded = value => '(function(){if(window.__TESSERA_RUNTIME_STARTED)return;window.__TESSERA_RUNTIME_STARTED={};\n'+new TextDecoder().decode(bytesOf(value))+'\n})();\n';
  const readable = guarded(script), compact = guarded(adsMin ?? script);
  const files = Object.fromEntries(Object.entries({'README.txt': 'Synthetic package\n', 'ads.js': readable, 'ads.min.js': compact,
    'div-export.csv': 'code\nP1\n', 'implementation.html': '<script src="./ads.js"></script>\n', 'min-height.css': '#P1{min-height:250px}\n',
    'sticky.css': '/* no sticky position */\n', ...(prebid ? {'prebid.js': '/* Prebid.js v11.34.0, synthetic stand-in */\n'} : {})}).map(([name, value]) => [name, bytesOf(value)]));
  const runtime = {schemaVersion: 1, configSchemaVersion: 1, runtimeId: 'synthetic-' + runtimeVersion, runtimeVersion, runtimeSha256: hash(files['ads.min.js']), capabilities: []};
  const prebidBuild = prebid ? {id: 'synthetic-build', version: '11.34.0', sha256: hash(files['prebid.js']), byteSize: files['prebid.js'].length, modules: []} : null;
  files['config.json'] = bytesOf(JSON.stringify({schemaVersion: 1, siteId, runtime, options: {enablePrebid: prebid, ...options}, prebidBuild}));
  const manifest = {schemaVersion: 1, kind: 'builtin-runtime-candidate', completeRelease: false, siteId, configHash: hash(files['config.json']), runtime, prebidBuild,
    files: Object.fromEntries(Object.keys(files).sort().map(name => [name, {byteSize: files[name].length, sha256: hash(files[name])}]))};
  files['manifest.json'] = bytesOf(JSON.stringify(manifest));
  const {descriptor} = await describeCandidate(siteId, {files});
  return {files, release: {id: descriptor.releaseId, siteId, note, runtime}};
}

/** readVersion over a fixed set of drafts: a missing id throws {status: 404}, as readPackage does. */
export function versionReader(drafts) {
  const byId = new Map(drafts.map(d => [d.release.id, d]));
  const reads = [];
  const readVersion = async id => {
    reads.push(id);
    const found = byId.get(id);
    if (!found) throw Object.assign(new Error('Package not found.'), {status: 404});
    return {files: {...found.files}, release: {...found.release}};
  };
  return {readVersion, reads, remove: id => byId.delete(id)};
}
