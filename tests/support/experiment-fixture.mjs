import { sha256 } from '../../worker/runtime/prebid-artifact-check.mjs';
import { describeCandidate } from '../../worker/runtime/draft-release-store.mjs';
import { EXPERIMENT_PROFILE } from '../../worker/experiments/delivery.mjs';

// Deliberately synthetic: no GPT, CMP, Prebid, publisher IDs or external traffic.
export async function experimentFixture(label = 'same', { prebid = false } = {}) {
  const bytes = text => new TextEncoder().encode(text);
  const runtime = {schemaVersion:1, configSchemaVersion:1, runtimeId:'synthetic-aa',
    runtimeVersion:'0.0.0', runtimeSha256:'a'.repeat(64), capabilities:[]};
  const script = (prebid ? 'if(window.fixturePrebid!=='+JSON.stringify(label)+')throw Error("Wrong dependency");' : '') + 'window.fixtureExecutions=(window.fixtureExecutions||0)+1;window.fixtureLabel=' + JSON.stringify(label) + ';';
  const prebidBytes = bytes('window.pbjs={};window.fixturePrebid='+JSON.stringify(label)+';');
  const prebidBuild = prebid ? {id:'fixture-'+label,version:'0.0.0',modules:[],sha256:await sha256(prebidBytes),byteSize:prebidBytes.length} : null;
  const files = {'ads.js':bytes(script),'ads.min.js':bytes(script), 'README.txt':bytes('Synthetic only'),
    'config.json':bytes(JSON.stringify({schemaVersion:1,siteId:'tanjug-test',runtime,options:{enablePrebid:prebid},prebidBuild})),
    'implementation.html':bytes('<p>Not a publisher implementation</p>'), 'div-export.csv':bytes('code\nfixture'),
    'min-height.css':bytes('/* synthetic */'), 'sticky.css':bytes('/* synthetic */')};
  if(prebid)files['prebid.js']=prebidBytes;
  const inventory = {};
  for (const [name, value] of Object.entries(files)) inventory[name] = {byteSize:value.length,sha256:await sha256(value)};
  files['manifest.json'] = bytes(JSON.stringify({schemaVersion:1,kind:'builtin-runtime-candidate',completeRelease:false,
    siteId:'tanjug-test',configHash:'b'.repeat(64),runtime,prebidBuild,files:inventory}));
  return describeCandidate('tanjug-test',{files});
}

export function experimentConfig(a, b = a, overrides = {}) {
  return {profile:EXPERIMENT_PROFILE,siteId:'tanjug-test',experimentId:'delivery-aa',revision:1,
    enabled:true,trafficB:50,controlPackageSha256:a.descriptor.packageSha256,
    testPackageSha256:b.descriptor.packageSha256,...overrides};
}
