/** Full generated wrappers for the independent native RTD/CMP/GPT audit. */
import {mkdir, writeFile, readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {compileRuntime3211} from '../worker/runtime-3211/compiler.mjs';
import {previewInput} from '../worker/runtime-3211/snapshot.mjs';
import {descriptor} from '../.generated/runtime-3211-manifest.mjs';
import {finalizeJavaScript} from '../worker/runtime/artifact-minifier.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const destination = resolve(root, '.generated/audit3211-wrapper');
await mkdir(destination, {recursive: true});
const snapshot = {
  site: {id: 'audit-wrapper', name: 'Synthetic wrapper audit', domain: 'wrapper-audit.invalid', gam_path: '/999999/audit/'},
  config: {config_json: JSON.stringify({enablePrebid: true,
    userSync: {syncEnabled: false, syncsPerBidder: 0, syncDelay: 0, auctionDelay: 0, userIds: []},
    runtimeControls: {sticky: {bottomAdUnitId: '', topAdUnitId: ''}, floors: {enabled: false}, currencyConversion: {enabled: false},
      contextualSignals: {schemaVersion: 1, enabled: true, sourceKey: 'category', gam: {enabled: true},
        bidders: [{bidder: 'connectad', taxonomy: 'iab-content-2.2'}],
        mappings: [{value: 'Sports', taxonomies: {'iab-content-2.2': ['483']}},
          {value: 'Books', taxonomies: {'iab-content-2.2': ['42']}}]}}})},
  units: [{code: 'Billboard', type: 'ATF', media_type: 'banner', size_map_key: 'display', enabled: 1, sort_order: 0},
    {code: 'P1', type: 'BTF', media_type: 'banner', size_map_key: 'display', enabled: 1, sort_order: 1}],
  bidders: [{bidder: 'connectad', params_json: '{"networkId":999999,"siteId":999999}', enabled: 1}], overrides: [],
  maps: [{name: 'display', map_json: '[{"viewport":[0,0],"sizes":[[300,250]]},{"viewport":[768,0],"sizes":[[300,600],[300,250]]}]'},
    {name: 'naslovna_display', map_json: '[{"viewport":[0,0],"sizes":[[300,100]]},{"viewport":[768,0],"sizes":[[300,250]]}]'}],
  rules: [{rule_key: '__DEFAULT__', rule_json: JSON.stringify({refresh: {enabled: false}, conditionalMappings: [
    {id: 'unmatched', name: 'Unmatched category', enabled: true, priority: 100, match: 'all',
      conditions: [{id: 'category', key: 'category', operator: 'equals', value: 'Gallery'}], sizeMapKey: null, slotAction: 'disable'},
  ]})},
    {rule_key: '__ATF__', rule_json: '{"lazy":{"enabled":false,"fetchMarginPx":0,"renderMarginPx":0},"timeout":700}'},
    {rule_key: '__BTF__', rule_json: '{"lazy":{"enabled":true,"fetchMarginPx":300,"renderMarginPx":0},"timeout":700}'}],
  prebidBuilds: [],
};
const input = previewInput(snapshot, descriptor, '20261112_120000');
const compiled = compileRuntime3211(input);
const final = await finalizeJavaScript(compiled.adsJs, {cleanComments: true});
const sha256 = value => createHash('sha256').update(value).digest('hex');
const files = {};
for (const [name, source] of [['ads.js', final.adsJs], ['ads.min.js', final.adsMinJs]]) {
  await writeFile(resolve(destination, name), source);
  files[name] = sha256(source);
}
await writeFile(resolve(destination, 'manifest.json'), JSON.stringify({schemaVersion: 1, runtimeVersion: '3.21.1',
  descriptor, files, contextualSourceSha256: sha256(await readFile(resolve(root, 'worker/runtime-3211/browser-contextual.mjs'))),
  scope: 'Compiler-generated full wrapper; synthetic inventory, categories and demand. Native RTD/CMP/GPT integration is verified separately.'}, null, 2) + '\n');
console.log('Prepared independent generated 3.21.1 contextual wrapper fixtures.');
