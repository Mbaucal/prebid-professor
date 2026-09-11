import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { buildArtifactCandidate } from '../../worker/runtime/artifact-candidate.mjs';
import { finalizeJavaScript, MINIFIER } from '../../worker/runtime/artifact-minifier.mjs';
import { stickyStyles, installSharedStickyStyles, placeholderStyles } from '../../worker/runtime/artifact-styles.mjs';
import { runtimeDescriptor, generatePreview } from '../../worker/runtime/builtin-preview-service.mjs';
import { previewInput, digest } from '../../worker/runtime/preview-snapshot.mjs';
import { sha256 } from '../../worker/runtime/prebid-artifact-check.mjs';
import { fixture, configure, takeOver, checkedFixture, pin, TS } from './artifact-fixture.mjs';
const decode = (bytes) => new TextDecoder().decode(bytes);
async function candidate(snapshot = fixture(), options = {}) {
  return buildArtifactCandidate({ snapshot, takeOver: takeOver(), pin: pin(), buildTimestamp: TS, prebid: await checkedFixture(snapshot), ...options });
}

test('emits the full review file set, not a stored or published release', async () => {
  const result = await candidate();
  assert.deepEqual(Object.keys(result.files).sort(), ['README.txt','ads.js','ads.min.js','config.json','div-export.csv','implementation.html','manifest.json','min-height.css','prebid.js','sticky.css'].sort());
  assert.equal(result.manifest.completeRelease, false); assert.equal(result.manifest.kind, 'builtin-runtime-candidate');
});
test('all payload hashes and sizes are calculated from exact output bytes', async () => {
  const { files, manifest } = await candidate();
  for (const [name, meta] of Object.entries(manifest.files)) {
    assert.equal(await sha256(files[name]), meta.sha256, name); assert.equal(files[name].byteLength, meta.byteSize, name);
  }
  assert.deepEqual(JSON.parse(decode(files['manifest.json'])), manifest);
});
test('deterministic output at a pinned timestamp and configuration', async () => {
  assert.deepEqual(await candidate(), await candidate());
});
test('does not mutate site configuration or the supplied artifact', async () => {
  const snapshot = fixture(); const before = JSON.stringify(snapshot); const prebid = await checkedFixture(snapshot); const hash = await sha256(prebid.bytes);
  await candidate(snapshot, { prebid }); assert.equal(JSON.stringify(snapshot), before); assert.equal(await sha256(prebid.bytes), hash);
});
test('pins runtime source, configuration and Prebid bytes independently', async () => {
  const snapshot = fixture(); const {manifest} = await candidate(snapshot);
  assert.deepEqual(manifest.runtime, pin()); assert.equal(manifest.configHash, await digest(snapshot));
  assert.equal(manifest.prebidBuild.sha256, (await checkedFixture(snapshot)).report.build.sha256);
});
test('both outputs parse and minified output is genuinely smaller', async () => {
  const {files} = await candidate(); new vm.Script(decode(files['ads.js'])); new vm.Script(decode(files['ads.min.js']));
  assert(files['ads.min.js'].length < files['ads.js'].length * .8);
  assert.equal(MINIFIER.mangle, false); assert.equal(MINIFIER.compress, false);
});
test('declared minifier version matches the installed dependency', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../../node_modules/terser/package.json', import.meta.url)));
  assert.equal(packageJson.version, MINIFIER.version);
});
test('a different runtime pin fails rather than upgrading silently', async () => {
  await assert.rejects(() => candidate(fixture(), { pin: { ...pin(), runtimeSha256: '0'.repeat(64) } }), /Pinned runtime/);
});
test('a JavaScript syntax error fails without fallback to regex stripping', async () => {
  await assert.rejects(() => finalizeJavaScript('function bad( {'), /parser validation/);
});
test('string/comment markers and regular expressions preserve meaning', async () => {
  const source = 'var url="https://example.invalid/a//b"; var str="/*keep*/"; var re=/a\\/\\/b/; /*remove*/ globalThis.result=[url,str,re.test("a//b")];';
  const js = await finalizeJavaScript(source);
  const a = {}, b = {}; vm.runInNewContext(source, a); vm.runInNewContext(js.adsMinJs, b);
  assert.equal(JSON.stringify(a.result), JSON.stringify(b.result)); assert(!js.adsMinJs.includes('/*remove*/'));
});
test('multiline template strings are not line-trimmed by the minifier', async () => {
  const source = 'globalThis.value=`line with two spaces  \n\n\nlast`;'; const compact = await finalizeJavaScript(source);
  const a = {},b = {}; vm.runInNewContext(source,a);vm.runInNewContext(compact.adsMinJs,b);assert.equal(a.value,b.value);
});
test('comment retention only affects readable source', async () => {
  const snapshot = configure(fixture(), (c) => { c.runtimeControls.output.cleanComments = false; });
  const result = await candidate(snapshot); assert(decode(result.files['ads.js']).includes('TAKEOVER MODULE')); assert(!decode(result.files['ads.min.js']).includes('TAKEOVER MODULE'));
});
test('invalid output flag is not coerced to a hidden default', async () => {
  await assert.rejects(() => candidate(configure(fixture(), (c) => { c.runtimeControls.output.cleanComments = 'false'; })), /boolean/);
});
test('same sticky CSS is injected and exported exactly', async () => {
  const snapshot = configure(fixture(), (c) => { c.runtimeControls.output.cleanComments = false; });
  const result = await candidate(snapshot); const css = decode(result.files['sticky.css']);
  const source = decode(result.files['ads.js']); assert(source.includes(`tag.textContent=${JSON.stringify(css)};`));
});
test('missing sticky injection marker is an error not an unpatched output', () => {
  assert.throws(() => installSharedStickyStyles('unrecognized', 'x'), /insertion point/);
});
test('sticky never receives a placeholder min-height from its request-size map', async () => {
  const result = await candidate(); assert(!decode(result.files['min-height.css']).includes('#Sticky'));
  assert(!decode(result.files['min-height.css']).includes('takeover'));
});
test('zero-height breakpoint resets previous reserved spacing', () => {
  const snapshot = fixture(); snapshot.maps[0].map_json = '[{"minViewPort":[0,0],"sizes":[[300,250]]},{"minViewPort":[768,0],"sizes":[]}]';
  assert.match(placeholderStyles(previewInput(snapshot,runtimeDescriptor,TS)), /@media\(min-width:768px\)\{#Billboard\{min-height:0px;\}\}/);
});
test('fluid-only breakpoints do not inherit a numeric placeholder', () => {
  const snapshot = fixture(); snapshot.maps[0].map_json = '[{"minViewPort":[0,0],"sizes":[[300,250]]},{"minViewPort":[768,0],"sizes":["fluid"]}]';
  assert.match(placeholderStyles(previewInput(snapshot,runtimeDescriptor,TS)), /min-width:768px.*min-height:0/);
});
test('height-dependent breakpoints fail before emitting inconsistent runtime/CSS', async () => {
  const snapshot = fixture(); snapshot.maps[0].map_json = '[{"minViewPort":[0,300],"sizes":[[300,250]]}]';
  await assert.rejects(() => candidate(snapshot), /Height-based/);
});
test('duplicate breakpoint widths are not silently reordered', async () => {
  const snapshot = fixture(); snapshot.maps[0].map_json = '[{"minViewPort":[0,0],"sizes":[[300,250]]},{"minViewPort":[0,0],"sizes":[[728,90]]}]';
  await assert.rejects(() => candidate(snapshot), /Duplicate size-map/);
});
test('unsafe CSS identifiers are rejected and colon identifiers escaped', () => {
  assert.throws(() => stickyStyles('bad}body{'), /Invalid/); assert(stickyStyles('Sticky:Right').startsWith('#Sticky\\:Right{'));
});
test('explicit disabled Sticky emits no active stylesheet or phantom ID', async () => {
  const snapshot = configure(fixture(), (c) => { c.runtimeControls.sticky.bottomAdUnitId = ''; });
  const result = await candidate(snapshot); assert.match(decode(result.files['sticky.css']), /disabled/);
  assert.match(decode(result.files['ads.js']), /STICKY_TARGET_ID = ""/);
});
test('GPT-only bundle has neither Prebid payload nor HTML loader', async () => {
  const snapshot = configure(fixture(), (c) => { c.enablePrebid = false; });
  const {files, manifest} = await candidate(snapshot); assert(!Object.hasOwn(files,'prebid.js'));
  assert(!decode(files['implementation.html']).includes('src="./prebid.js"')); assert.equal(manifest.prebidBuild, null);
});
test('only normalized runtime settings enter the exported config', async () => {
  const snapshot = configure(fixture(), (c) => { c.privateAdminToken='DO_NOT_EXPORT'; c.cmsConnection={token:'DO_NOT_EXPORT'}; });
  const {files} = await candidate(snapshot);for (const file of Object.values(files)) assert(!decode(file).includes('DO_NOT_EXPORT'));
});
test('unverified and cross-site Prebid input is not accepted', async () => {
  const snapshot = fixture();const pb = await checkedFixture(snapshot);pb.report.siteId='other';
  await assert.rejects(() => candidate(snapshot,{prebid:pb}), /checked Prebid/);
  await assert.rejects(() => candidate(snapshot,{prebid:null}), /checked Prebid/);
});
test('artifact changed after checking fails the bundle', async () => {
  const snapshot = fixture();const pb = await checkedFixture(snapshot);new Uint8Array(pb.bytes)[0]=0;
  await assert.rejects(() => candidate(snapshot,{prebid:pb}), /changed after verification/);
});
test('mismatched module requirement set cannot reuse another review', async () => {
  const snapshot = fixture();const pb = await checkedFixture(snapshot);pb.report.requiredModules=['wrong'];
  await assert.rejects(() => candidate(snapshot,{prebid:pb}), /requirements differ/);
});
test('bundles reject unexpected Prebid bytes in GPT-only mode', async () => {
  const snapshot = fixture(); const pb=await checkedFixture(snapshot); configure(snapshot,(c)=>{c.enablePrebid=false;});
  await assert.rejects(() => candidate(snapshot,{prebid:pb}), /GPT-only/);
});
test('site names are escaped in the integration example', async () => {
  const snapshot=fixture();snapshot.site.name='</title><script>alert(1)</script>';
  const {files}=await candidate(snapshot);assert(decode(files['implementation.html']).includes('&lt;/title&gt;'));
});
test('integration example loads exactly one wrapper, keeps GPT and required Prebid', async () => {
  const {files}=await candidate();const html=decode(files['implementation.html']);
  assert(html.includes('./ads.min.js'));assert(!html.includes('src="./ads.js"'));
  assert(html.indexOf('./prebid.js') < html.indexOf('./ads.min.js'));assert(!html.includes('id="Sticky"'));
  assert(!html.includes('id="TakeOver"'));assert(html.includes('approved CMP'));
});
test('unsupported per-slot overlays and top sticky still fail, not silently discarded', async () => {
  const top = configure(fixture(), (c)=>{c.runtimeControls.sticky.topAdUnitId='Billboard';});
  await assert.rejects(() => candidate(top), /Top sticky/);
  const lazy=fixture();lazy.rules=[{rule_key:'P1',rule_json:'{"lazy":{"enabled":true}}'}];
  await assert.rejects(() => candidate(lazy), /lazy settings/);
});
