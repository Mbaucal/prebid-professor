// Loopback-only synthetic browser fixture. Never imported or deployed by a Worker.
import { createServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { experimentFixture, experimentConfig } from '../tests/support/experiment-fixture.mjs';
import { createExperimentDelivery } from '../worker/experiments/delivery.mjs';
import { buildArtifactCandidate, runtimeDescriptor } from '../worker/runtime-measured/artifact-candidate.mjs';
import { pinRuntime } from '../worker/runtime/version-pin.mjs';
import { describeCandidate } from '../worker/runtime/draft-release-store.mjs';
import { positionFixture } from '../tests/support/position-runtime-fixture.mjs';
import {cacheSelectionFixture} from '../tests/support/cache-selection-fixture.mjs';
import {readDraftRelease} from '../worker/runtime/draft-release-store.mjs';
const [key,cert]=process.argv.slice(2);
if(!key||!cert)throw Error('Local TLS files required');
const a=await experimentFixture('A',{prebid:true}), b=await experimentFixture('B',{prebid:true});
const cases=new Map();
const cacheStore=await cacheSelectionFixture(),cacheState=await cacheStore.api('/test-api/runtime-selection');
await cacheStore.api('/test-api/runtime-selection',{expectedRevision:cacheState.revision,selection:{runtime:cacheState.runtimes.find(r=>r.version==='3.13.0').pin,allowPreview:true,enablePrebid:true,prebidBuildId:cacheState.prebidBuildId,bidCache:{mode:'auction-with-cache',maxAgeSeconds:60}}});
const readyCache=await cacheStore.api('/test-api/site-packages');
const cacheRelease=await cacheStore.api('/test-api/site-packages',{action:'generate',revision:readyCache.revision,notes:'Stored 3.13 A/A'},201);
const storedCache=await readDraftRelease({isolation:'explicit-test-store',db:cacheStore.env.DB,bucket:cacheStore.env.BUILDS},{siteId:'test-site',releaseId:cacheRelease.release.id});
const cachePackage=await describeCandidate('test-site',storedCache);cacheStore.close();
for(const [name,sample] of [['cachea',0.75],['cacheb',0.25]]){
 cases.set(name,await createExperimentDelivery({profile:'experiment-preview-v1',siteId:'test-site',experimentId:'cached-aa',revision:1,enabled:true,trafficB:50,controlPackageSha256:cachePackage.descriptor.packageSha256,testPackageSha256:cachePackage.descriptor.packageSha256},{[cachePackage.descriptor.packageSha256]:cachePackage},{random:()=>sample}));
}
const measured=await describeCandidate('test-site',await buildArtifactCandidate({snapshot:positionFixture(false),pin:pinRuntime(runtimeDescriptor,{allowPreview:true}),buildTimestamp:'20260917_120000'}));
const measuredConfig={profile:'experiment-preview-v1',siteId:'test-site',experimentId:'measured-aa',revision:1,enabled:true,trafficB:50,controlPackageSha256:measured.descriptor.packageSha256,testPackageSha256:measured.descriptor.packageSha256};
for(const [name,sample] of [['measureda',0.75],['measuredb',0.25]]) {
  cases.set(name,await createExperimentDelivery(measuredConfig,{[measured.descriptor.packageSha256]:measured},{random:()=>sample}));
}
for(const name of ['a','b','aa','stopped','corrupt','corruptads','blocked','legacy']) {
  const other=name==='aa'?a:b;
  cases.set(name,await createExperimentDelivery(experimentConfig(a,other,{trafficB:name==='a'?0:100,enabled:name!=='stopped'}),
    {[a.descriptor.packageSha256]:a,[other.descriptor.packageSha256]:other}));
}
const marker={'x-tessera-local-fixture':'experiment-loader','cache-control':'no-store'};
createServer({key:readFileSync(key),cert:readFileSync(cert)},async(req,res)=>{
  try {
    const path=new URL(req.url,'https://experiment.invalid').pathname;
    if(path==='/health'){res.writeHead(200,marker);res.end('ready');return;}
    const match=path.match(/^\/case\/([a-z]+)(\/.*)?$/),name=match?.[1],tail=match?.[2]||'/';
    if(!cases.has(name)){res.writeHead(404,marker);res.end();return;}
    if(name.startsWith('cache')&&tail==='/mock.js'){
      res.writeHead(200,{...marker,'content-type':'application/javascript'});
      res.end(readFileSync('tests/runtime/mock-ad-libraries.js','utf8')+'\n'+readFileSync('tests/runtime/cache-runtime-fixture.js','utf8')+'\ndocument.addEventListener("load",function(e){if(e.target.tagName==="SCRIPT"&&e.target.src.endsWith("/prebid.js"))installFixtureAdapters();},true);');return;
    }
    if(name.startsWith('measured')&&tail==='/mock.js') {
      res.writeHead(200,{...marker,'content-type':'application/javascript'});
      res.end(readFileSync('tests/runtime/mock-ad-libraries.js','utf8')+'\ndelete window.pbjs;window.requestLabels=[];__testAds.service.addEventListener("slotRequested",function(e){requestLabels.push({id:e.slot.id,value:e.slot.getTargeting("tessera_ab")});});');return;
    }
    if(tail==='/') {
      const csp=(name==='blocked'?"default-src 'none'; script-src 'nonce-fixture'":"default-src 'none'; script-src 'nonce-fixture' 'strict-dynamic'")+(name.startsWith('cache')?"; connect-src https://cache-fixture.invalid https://cdn.jsdelivr.net; style-src 'unsafe-inline'":"");
      res.writeHead(200,{...marker,'content-type':'text/html','content-security-policy':csp});
      res.end('<!doctype html><title>Synthetic A/B loader</title><p>Local synthetic verification only</p>'+
        (name.startsWith('measured')||name.startsWith('cache')?'<div id="Billboard" class="wrapperAd"></div><div id="P1" class="wrapperAd"></div><div id="Overlay"></div><script nonce="fixture" src="mock.js"></script>':'')+
        (name==='legacy'?'<script nonce="fixture" src="legacy.js"></script>':'')+
        '<script nonce="fixture" src="ads.js"></script><script nonce="fixture" src="ads.js"></script>');return;
    }
    if(tail==='/legacy.js'){res.writeHead(200,{...marker,'content-type':'application/javascript'});res.end('window.pbjs={legacy:true};');return;}
    const response=cases.get(name).fetch(new Request('https://experiment.invalid'+tail));
    let body=await response.text();
    if((name==='corrupt'&&tail.endsWith('/prebid.js'))||(name==='corruptads'&&tail.startsWith('/releases/')&&tail.endsWith('/ads.js')))body+='/* deliberately tampered */';
    // In this scenario remove the nonce from dynamic scripts via the loader source
    // solely in the local harness, to prove a restrictive CSP fails closed.
    if(name==='blocked'&&tail==='/ads.js')body=body.replace('var nonce = current.nonce;','var nonce = "";');
    res.writeHead(response.status,{...Object.fromEntries(response.headers),...marker});res.end(body);
  }catch(e){res.writeHead(500,marker);res.end(String(e.message));}
}).listen(8877,'127.0.0.1',()=>console.log('Local experiment loader ready'));
