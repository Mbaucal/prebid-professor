import {mkdir,writeFile} from 'node:fs/promises';
import {dealsRuntimeFixture} from '../tests/support/deals-runtime-fixture.mjs';
import {positionFixture} from '../tests/support/position-runtime-fixture.mjs';
import {OUTSTREAM_PILOT} from '../shared/outstream/catalog.mjs';
import {finalizeJavaScript} from '../worker/runtime/artifact-minifier.mjs';
const stable=process.argv.includes('--stable');
const compile=stable?(await import('../worker/runtime-316/compiler.mjs')).compileRuntime316:(await import('../worker/runtime-revenue-v1/compiler.mjs')).compileRevenue;
const {previewInput}=await import(stable?'../worker/runtime-316/snapshot.mjs':'../worker/runtime-revenue-v1/snapshot.mjs');
const {descriptor}=await import(stable?'../.generated/runtime-316-manifest.mjs':'../.generated/runtime-revenue-manifest.mjs');
const out=new URL(stable?'../.generated/stable-revenue-evidence/':'../.generated/revenue-evidence/',import.meta.url);
await mkdir(out,{recursive:true});
for(const name of ['prebid','gam','outstream','outstream-only']) {
  const snapshot=name.startsWith('outstream')?positionFixture(true):dealsRuntimeFixture(name!=='gam');
  if(name.startsWith('outstream')) {
    const config=JSON.parse(snapshot.config.config_json);
    // This acceptance fixture exercises the adapter/cache/creative handoff, not
    // the short-deadline regression. Give intercepted browser I/O the normal
    // 1500ms auction window; expiry and consent guards remain independently tested.
    config.timeout=1500;
    snapshot.rules.forEach(row=>{const rule=JSON.parse(row.rule_json);rule.timeout=1500;row.rule_json=JSON.stringify(rule);});
    delete config.runtimeControls.adPositions;
    snapshot.units=snapshot.units.filter(unit=>unit.code==='Billboard');
    snapshot.overrides=[];
    snapshot.bidders.forEach(bidder=>bidder.params_json='{"publisherId":"156209","adSlot":"fixture"}');
    snapshot.prebidBuilds=[{version:'11.34.0',modules_json:'["pubmaticBidAdapter","consentManagementTcf","tcfControl"]'}];
    config.runtimeControls.outstream={schemaVersion:1,units:{Billboard:{
      format:name==='outstream-only'?'outstream':'banner-outstream',playerSize:[300,250],minDuration:5,maxDuration:30,
      playbackMethod:2,placement:3,plcmt:4,partner:{bidder:'pubmatic',adapter:'pubmatic',outstreamAU:'fixture_renderer',activationConfirmed:true},cacheUrl:OUTSTREAM_PILOT.cacheUrl,
    }}};
    config.runtimeControls.deals={schemaVersion:1,entries:[{id:'video-deal',name:'Synthetic video deal',bidder:'pubmatic',dealId:'0000199',positions:['Billboard'],startsAt:'2026-01-01T00:00:00.000Z',endsAt:'2027-01-01T00:00:00.000Z',enabled:true,mode:'price'}]};
    snapshot.config.config_json=JSON.stringify(config);
  }
  const input=previewInput(snapshot,descriptor,'20261011_140000');
  const compiled=compile(input);
  const final=await finalizeJavaScript(compiled.adsJs,{cleanComments:true});
  await writeFile(new URL(name+'.js',out),final.adsJs);
  await writeFile(new URL(name+'.min.js',out),final.adsMinJs);
}
console.log('Prepared synthetic revenue fixtures: Deals, GAM-only and PubMatic Outstream.');
