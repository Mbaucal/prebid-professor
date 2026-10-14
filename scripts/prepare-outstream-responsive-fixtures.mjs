import {mkdir,writeFile} from 'node:fs/promises';
import {positionFixture} from '../tests/support/position-runtime-fixture.mjs';
import {finalizeJavaScript} from '../worker/runtime/artifact-minifier.mjs';
const stable=process.argv.includes('--stable');
const compile=stable?(await import('../worker/runtime-316/compiler.mjs')).compileRuntime316:(await import('../worker/runtime-revenue-v3/compiler.mjs')).compileRevenue;
const {previewInput}=await import(stable?'../worker/runtime-316/snapshot.mjs':'../worker/runtime-revenue-v3/snapshot.mjs');
const {descriptor}=await import(stable?'../.generated/runtime-316-manifest.mjs':'../.generated/runtime-revenue-v3-manifest.mjs');
const out=new URL(stable?'../.generated/stable-outstream-responsive-evidence/':'../.generated/outstream-responsive-evidence/',import.meta.url);
await mkdir(out,{recursive:true});
for(const name of ['responsive','responsive-only','responsive-lazy']) {
 const snapshot=positionFixture(true),config=JSON.parse(snapshot.config.config_json);
 delete config.runtimeControls.adPositions;config.timeout=1500;
 snapshot.units=snapshot.units.filter(unit=>unit.code==='Billboard');
 snapshot.units[0].type=name==='responsive-lazy'?'BTF':'ATF';snapshot.overrides=[];
 snapshot.rules.forEach(row=>{const rule=JSON.parse(row.rule_json);rule.timeout=1500;row.rule_json=JSON.stringify(rule);});
 snapshot.maps=[{name:'display',map_json:JSON.stringify([
  {viewport:[0,0],sizes:[[300,250]]},
  {viewport:[768,0],sizes:[[728,90],[640,360],[800,450]]},
  {viewport:[1600,0],sizes:[]}
 ])},{name:'article_display',map_json:JSON.stringify([{viewport:[0,0],sizes:[[320,180]]},{viewport:[768,0],sizes:[[800,450]]},{viewport:[1600,0],sizes:[]}])}];
 snapshot.bidders.forEach(bidder=>bidder.params_json='{"publisherId":"156209","adSlot":"fixture"}');
 snapshot.prebidBuilds=[{version:'11.34.0',modules_json:'["pubmaticBidAdapter","consentManagementTcf","tcfControl"]'}];
 config.runtimeControls.outstream={schemaVersion:1,units:{Billboard:{format:name==='responsive-only'?'outstream':'banner-outstream',playerSizing:'size-map',playerSizes:{'display@768x0':[640,360]},minDuration:5,maxDuration:30,
  playbackMethod:2,placement:3,plcmt:4,partner:{bidder:'pubmatic',adapter:'pubmatic',outstreamAU:'fixture_renderer',activationConfirmed:true},cacheUrl:'https://prebid.adnxs.com/pbc/v1/cache'}}};
 snapshot.config.config_json=JSON.stringify(config);
 const input=previewInput(snapshot,descriptor,'20261014_010000'),compiled=compile(input),final=await finalizeJavaScript(compiled.adsJs,{cleanComments:true});
 await writeFile(new URL(name+'.js',out),final.adsJs);await writeFile(new URL(name+'.min.js',out),final.adsMinJs);
 await writeFile(new URL(name+'.config.json',out),JSON.stringify({core:input.core,outstream:input.outstream},null,2));
}
console.log('Prepared responsive Outstream fixtures: actual generated readable/minified output, synthetic demand only.');
