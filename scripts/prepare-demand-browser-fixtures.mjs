import {mkdir,writeFile} from 'node:fs/promises';
import {positionFixture} from '../tests/support/position-runtime-fixture.mjs';
import {previewInput} from '../worker/runtime-demand-v1/snapshot.mjs';
import {compileDemand} from '../worker/runtime-demand-v1/compiler.mjs';
import {finalizeJavaScript} from '../worker/runtime/artifact-minifier.mjs';
import {descriptor} from '../.generated/runtime-demand-manifest.mjs';
const out=new URL('../.generated/demand-evidence/',import.meta.url);
await mkdir(out,{recursive:true});
const wire=process.argv.includes('--wire');
const noIds=process.argv.includes('--no-ids');
for(const enabled of [true,false]){
  const s=positionFixture(enabled),c=JSON.parse(s.config.config_json);
  c.runtimeControls.sticky.bottomAdUnitId='Sticky';
  s.units.push({code:'Sticky',type:'ATF',media_type:'banner',size_map_key:'display',enabled:1,sort_order:3});
  s.site.gam_path='/123,456/example/';
  // Native Prebid with synthetic adapters, never a real account/placement.
  if(enabled)s.bidders=['pubmatic','openx','criteo'].map(bidder=>({bidder,params_json:'{"publisherId":"123","adSlot":"456@300x250"}',enabled:1}));
  if(wire&&enabled){
    s.bidders=[['pubmatic',{publisherId:'123',adSlot:'456@300x250'}],['ix',{siteId:'123'}],['rubicon',{accountId:123,siteId:456,zoneId:789}]].map(([bidder,params])=>({bidder,params_json:JSON.stringify(params),enabled:1}));
    s.overrides=[];
    // Supported synthetic banner size for every adapter, including the overlay.
    s.maps.forEach(m=>m.map_json=JSON.stringify([{viewport:[0,0],sizes:[[300,250]]}]));
    c.runtimeControls.demandSignals={gpidOverrides:{P1:'publisher.example/article-inline'}};
    // Prebid's pre-supplied value path: exercises User ID -> EID -> adapter.
    // No real identity provider/account or stored user identifier is contacted.
    c.userSync={syncEnabled:true,syncDelay:999999,userIds:[{name:'id5Id',params:{partner:123},value:{id5id:{uid:'synthetic-id5-wire-test'}}}]};
    if(noIds)c.userSync.userIds=[];
  }
  c.timeout=500;
  s.config.config_json=JSON.stringify(c);
  for(const row of s.rules){const r=JSON.parse(row.rule_json);r.timeout=2500;r.refresh={enabled:true,minSeconds:30,minViewPct:50,maxRefreshes:10};row.rule_json=JSON.stringify(r);}
  const input=previewInput(s,descriptor,'20260923_230000');
  const js=await finalizeJavaScript(compileDemand(input).adsJs,{cleanComments:true});
  const name=(wire?(noIds?'wire-noids-':'wire-'):'')+(enabled?'prebid':'gam');
  await writeFile(new URL(name+'.js',out),js.adsJs);await writeFile(new URL(name+'.min.js',out),js.adsMinJs);
  await writeFile(new URL(name+'.json',out),JSON.stringify(input.demandSignals));
}
