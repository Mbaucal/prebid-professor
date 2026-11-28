/** Integration-risk fixtures: literal GAM IDs plus viewport/category/GEO rules. No live demand. */
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const root = resolve(process.argv[2] || '.');
const output = resolve(process.argv[3] || '.generated/qa-runtime3201');
const version = process.argv[4] || '3201';
const from = path => import(pathToFileURL(resolve(root, path)).href);
const {descriptor} = await from(`.generated/runtime-${version}-manifest.mjs`);
const {buildArtifactCandidate} = await from(`worker/runtime-${version}/artifact-candidate.mjs`);
const {previewInput} = await from(`worker/runtime-${version}/snapshot.mjs`);
const {pinRuntime} = await from('worker/runtime/version-pin.mjs');
const {prebidRequirements, inspectPrebidArtifact, sha256} = await from('worker/runtime/prebid-artifact-check.mjs');
const row = (width, height, sizes) => ({viewport: [width, height], sizes});
const noMatch = [row(768, 1000, [[728, 90]])];
const height = [row(0, 0, [[300, 250]]), row(768, 0, [[300, 600]]), row(768, 1000, [[970, 90]])];
const home = [row(0, 0, [[320, 50]]), row(768, 1000, [[728, 90]])];
const codes = ['m.box_3', '__proto__', 'constructor', '1Banner', 'slot"\\<:!()*'];
const unit = (code, enabled = 1) => ({code, type: enabled ? 'ATF' : 'DRAFT', enabled, media_type: 'banner', size_map_key: 'base'});
function snapshot(code, rows) {
  return {
    site: {id: 'qa-combined', name: 'Combined QA', domain: 'example.invalid', gam_path: '/123/test/'},
    config: {config_json: JSON.stringify({enablePrebid: true, userSync: {syncEnabled: false, userIds: []}, runtimeControls: {sticky: {bottomAdUnitId: ''}, floors: {enabled: false}, currencyConversion: {enabled: false}, output: {cleanComments: true}}})},
    units: [unit(code)],
    maps: [{name: 'base', map_json: JSON.stringify(rows)}, {name: 'home', map_json: JSON.stringify(home)}],
    rules: [{rule_key: '__DEFAULT__', rule_json: JSON.stringify({refresh: {enabled: false}, lazy: {enabled: false}})}],
    bidders: [{bidder: 'ix', enabled: 1, params_json: '{"siteId":"fixture"}'}],
    overrides: [{bidder: 'ix', scope_type: 'adunit', scope_key: code, enabled: 1, params_json: JSON.stringify({siteId: 'exact-' + code})}],
  };
}
function configure(s, fn) {const c = JSON.parse(s.config.config_json); fn(c); s.config.config_json = JSON.stringify(c);}
function mapping(conditions, extra = {}) {return {id: 'conditional', name: 'Conditional QA', enabled: true, priority: 100, match: 'all', conditions, sizeMapKey: 'home', slotAction: 'inherit', ...extra};}
const cases = [];
for (const code of codes) {
  for (const pendingCmp of [false, true]) cases.push({name: `resume-${cases.length}`, code, s: snapshot(code, noMatch), rows: noMatch, pendingCmp, requireResizeStart: true});
  for (const category of ['Naslovna', 'Article']) {
    const s = snapshot(code, height);
    s.rules.push({rule_key: code, rule_json: JSON.stringify({conditionalMappings: [mapping([{key: 'category', operator: 'equals', value: 'Naslovna'}])]})});
    cases.push({name: `category-${cases.length}`, code, s, rows: category === 'Naslovna' ? home : height, keywords: {category}});
  }
}
for (const code of ['m.box_3', '__proto__']) for (const country of ['RS', 'DE', 'unknown', 'timeout']) {
  const s = snapshot(code, height);
  s.rules.push({rule_key: code, rule_json: JSON.stringify({conditionalMappings: [mapping([{key: 'geo_country', operator: 'notEquals', value: 'RS'}, {key: 'geo_country', operator: 'notExists'}], {match: 'any', sizeMapKey: null, slotAction: 'disable'})]})});
  cases.push({name: `geo-${cases.length}`, code, s, rows: height, country, disabled: country !== 'RS'});
}
for (const code of ['m.Sticky', '__proto__', 'sticky"\\<:!()*']) for (const closed of [false, true]) {
  const s = snapshot(code, noMatch); configure(s, c => {c.runtimeControls.sticky.bottomAdUnitId = code;});
  cases.push({name: `sticky-${cases.length}`, code, s, rows: noMatch, sticky: true, closeAfterInitial: closed, requireResizeStart: !closed});
}
// Inactive exact overrides are retained in saved input but omitted from emitted inventory.
// Re-enabling must restore both exact code and exact bidder override.
for (const enabled of [false, true]) {
  const code = '__proto__', s = snapshot(code, noMatch);
  s.units[0] = unit(code, enabled ? 1 : 0);
  s.units.push({...unit('Control'), size_map_key: 'home'});
  cases.push({name: `inactive-${enabled}`, code, s, rows: noMatch, disabled: !enabled, requireResizeStart: enabled});
}
await mkdir(output, {recursive: true});
const results = [];
for (const c of cases) {
  const {s, ...metadata} = c;
  try {
    const before = JSON.stringify(s), input = previewInput(s, descriptor, '20261110_120000', {enabled: false}, 'test');
    const requirements = prebidRequirements(input, JSON.parse(s.config.config_json));
    assert.deepEqual(requirements.issues, []);
    const bytes = new TextEncoder().encode(`/* prebid.js v11.11.0\nModules: ${requirements.modules.join(', ')} */\nvoid 0;`).buffer;
    const build = {id: 'fixture', publisher_id: s.site.id, status: 'current', version: '11.11.0', file_key: `publishers/${s.site.id}/prebid-builds/fixture/prebid.js`, modules_json: JSON.stringify(requirements.modules)};
    const object = {size: bytes.byteLength, customMetadata: {sha256: await sha256(bytes), version: '11.11.0'}, async arrayBuffer() {return bytes;}};
    const report = await inspectPrebidArtifact({siteId: s.site.id, builds: [build], requirements}, {async get() {return object;}});
    assert.equal(report.status, 'checked', JSON.stringify(report.issues));
    const artifact = await buildArtifactCandidate({snapshot: s, pin: pinRuntime(descriptor, {allowPreview: true}), prebid: {bytes, report}, buildTimestamp: '20261110_120000', countryTarget: 'test'});
    assert.equal(JSON.stringify(s), before, 'Generation mutated saved configuration');
    const config = JSON.parse(new TextDecoder().decode(artifact.files['config.json']));
    const expectedCodes = s.units.filter(u => u.enabled && u.type !== 'DRAFT').map(u => u.code);
    assert.deepEqual(config.core.explicitUnits.map(u => u.id), expectedCodes, 'Public IDs changed');
    const dir = resolve(output, c.name); await mkdir(dir, {recursive: true});
    for (const [name, content] of Object.entries(artifact.files)) await writeFile(resolve(dir, name), content);
    results.push({...metadata, pass: true});
  } catch (error) {results.push({...metadata, pass: false, error: error.stack});}
}
const result = {version, descriptor, commit: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim(), cases: results};
await writeFile(resolve(output, 'cases.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({cases: results.length, failures: results.filter(c => !c.pass)}, null, 2));
if (results.some(c => !c.pass)) process.exitCode = 1;
