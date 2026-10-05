import assert from 'node:assert/strict';
import {minify} from 'terser';
import {zipSync, unzipSync} from 'fflate';
import {configurePreparedArm, preparePackageTemplates, templateLoader} from '../worker/experiments/configurable-cache-v1.mjs';
import {validatePackageSettings} from '../worker/experiments/package-settings-v1.mjs';
import {sha256, integrity} from './static-aa-package.mjs';

export const CONFIGURABLE_PROFILE = 'tanjug-configurable-ab-v1';
const PRIOR_SHA = 'bd0d9a6973903a3ec585f88e4b815eefb7a061ec8a32593f671b53ce211dfb1e';
const BASE_SHA = '0faec2eccdcedbd29153357c7a94c879cdec4a8d037b16593a94a7884f242e2b';
const PREBID_SHA = '384daae36c4fb334e16229d7f3e4b7a2c2caf9c0344580bdca7b185c756bb10b';
const SENTINEL = 'tanjug-ab-2.0.0-' + '0'.repeat(64);
const compact = async source => Buffer.from((await minify(source, {
  ecma: 2020, compress: true, mangle: true, sourceMap: false, format: {comments: false},
})).code + '\n');

/** Pure build: pinned inputs in, exact immutable assets out. No hosted reads/writes. */
export async function buildConfigurableABPackage({base, previousArchive, settings: input, preparedTemplates}) {
  const settings = validatePackageSettings(input);
  assert.equal(sha256(base), BASE_SHA, 'Use the reviewed readable runtime.');
  assert.equal(sha256(previousArchive), PRIOR_SHA, 'Use the accepted CMP package.');
  const previous = unzipSync(previousArchive);
  assert.equal(sha256(previous['prebid.js']), PREBID_SHA);
  const recipe=preparedTemplates??preparePackageTemplates(Buffer.from(base).toString());
  const loader=config=>templateLoader(recipe.loader,config);
  const context = {baseRuntime: '3.9.1-tessera.preview.2', prebidVersion: '11.34.0',
    positions: ['Billboard','Billboard_2','Billboard_3','Branding_Left','Branding_Right',
      ...Array.from({length:8},(_,i)=>`P${i+1}`), ...Array.from({length:5},(_,i)=>`InText_${i+1}`), 'Sticky']};
  // Hash compiled bytes and loader profile, not just user settings: compiler or
  // minifier changes must never silently reuse an existing release identifier.
  const templates = {};
  for (const variant of ['A', 'B']) templates[variant] = await compact(configurePreparedArm(settings.arms[variant].mode==='fresh-only'?recipe.fresh:recipe.cached,variant,settings,SENTINEL));
  const identity = sha256(Buffer.concat([
    Buffer.from(JSON.stringify({profile: CONFIGURABLE_PROFILE, settings, context, base: BASE_SHA, previous: PRIOR_SHA})),
    templates.A, templates.B, Buffer.from(recipe.compilerSource),
    // Include inherited loader implementation and compiler/minifier output.
    await compact(loader({release: SENTINEL, settings, arms: {A: {}, B: {}}, positions: []})),
  ]));
  const release = 'tanjug-ab-2.0.0-' + identity;
  const folder = `releases/${release}/`;
  const arms = Object.fromEntries(Object.entries(templates).map(([v, b]) => [v, Buffer.from(b.toString().replaceAll(SENTINEL, release))]));
  const config = {
    release, settings, ...context,
    prebidPath: folder + 'prebid.js', prebidIntegrity: integrity(previous['prebid.js']),
    arms: Object.fromEntries(Object.entries(arms).map(([v,b]) => [v,{path: folder + v + '.js', sha256: sha256(b), integrity: integrity(b)}])),
  };
  const files = Object.fromEntries(['prebid.js','sticky.css','min-height.css','_headers','404.html'].map(n => [n,previous[n]]));
  files['ads.js'] = await compact(loader(config));
  files[config.prebidPath] = files['prebid.js'];
  for (const v of ['A','B']) files[config.arms[v].path] = arms[v];
  const manifest = {schemaVersion: 1, kind: CONFIGURABLE_PROFILE, release, config, settings,
    key: 'Variant', values: ['A','B'], allocation: `${100-settings.trafficBPercent}/${settings.trafficBPercent} per document`,
    baseReadableSha256: BASE_SHA, previousArchiveSha256: PRIOR_SHA,
    files: Object.fromEntries(Object.keys(files).sort().map(n => [n,{bytes: files[n].length, sha256: sha256(files[n])}]))};
  const archive = zipSync(Object.fromEntries(Object.keys(files).sort().map(n => [n,[files[n],{level:6,mtime:new Date(1980,0,1)}]])),{level:6});
  return {release, manifest, files, archive, archiveSha256: sha256(archive)};
}
