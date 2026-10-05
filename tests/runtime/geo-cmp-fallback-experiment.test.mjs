import test from 'node:test';
import assert from 'node:assert/strict';
import {handleGeoScopeRequest,fetchTrustedGeo,createGeoCmpFallback,planRegionalStartup} from '../support/geo-cmp-fallback-experiment.mjs';
const context={siteId:'site-test',pageId:'page-abcdefgh',nonce:'nonce-abcdefgh'};
const endpoint='https://edge.example.invalid/geo',origin='https://publisher.example.invalid';
async function geoFixture({country='RS',allowCountries=['RS'],time=1000,transform=x=>x}={}) {
 let calls=0,options;
 const geo=await fetchTrustedGeo({...context,endpoint,now:()=>time,fetchImpl:async(url,opts)=>{
  calls++;options=opts;const request=new Request(url,{headers:{origin,'cf-ipcountry':'US'}});Object.defineProperty(request,'cf',{value:{country}});
  const response=handleGeoScopeRequest(request,{siteId:context.siteId,allowCountries,allowedOrigin:origin,now:time});
  const data=transform(await response.json());const reply=new Response(JSON.stringify(data),{status:response.status,headers:response.headers});Object.defineProperty(reply,'url',{value:url});return reply;
 }});return {geo,calls,options};
}
const loading={cmpStatus:'loading',gdprApplies:undefined};
const reject={cmpStatus:'loaded',eventStatus:'useractioncomplete',gdprApplies:true,tcString:'synthetic-reject',purpose:{consents:{}},vendor:{consents:{}}};
function controller(geo,more={}){let time=1000;const invalidations=[];const c=createGeoCmpFallback({geo,...context,waitMs:30,now:()=>time,onInvalidate:x=>invalidations.push(x),...more});return {c,invalidations,tick:ms=>{time+=ms;return c.snapshot();}};}
test('pure edge handler trusts cf.country only; fetch contract no-store and copied page-bound result',async()=>{
 const f=await geoFixture();assert.equal(f.geo.country,'RS');assert(f.geo.allowed);assert(Object.isFrozen(f.geo));assert.deepEqual(f.options,{credentials:'omit',cache:'no-store',redirect:'error'});assert.equal(f.calls,1);
 const url=endpoint+'?'+new URLSearchParams({...context,country:'RS'});const req=new Request(url,{headers:{origin,'cf-ipcountry':'RS'}});const r=handleGeoScopeRequest(req,{siteId:context.siteId,allowCountries:['RS'],allowedOrigin:origin,now:1000});assert.equal((await r.json()).allowed,false);assert.match(r.headers.get('cache-control'),/no-store/);
});
test('empty allowlist, unknown ISO codes and protected countries deny fallback even when listed',async()=>{
 for(const country of ['DE','FR','IS','LI','NO','GB','UK','CH','XX','ZZ','AA','T1','EU',null,'rs']){const f=await geoFixture({country,allowCountries:[country]});assert.equal(f.geo?.allowed||false,false);}
 assert.equal((await geoFixture({allowCountries:[]})).geo.allowed,false);
});
test('wrong origin/site/page/nonce, stale/future timestamps and malformed expiry reject evidence',async()=>{
 for(const patch of [{siteId:'wrong'},{pageId:'page-different'},{nonce:'nonce-different'},{issuedAt:1001},{expiresAt:1000},{expiresAt:100000},{country:'ZZ',allowed:true},{schema:2}])assert.equal((await geoFixture({transform:x=>({...x,...patch})})).geo,null);
 const req=new Request(endpoint+'?'+new URLSearchParams(context),{headers:{origin:'https://other.invalid'}});assert.equal(handleGeoScopeRequest(req,{siteId:context.siteId,allowedOrigin:origin}).status,403);
});
test('transport failure, redirects, nonJSON, cacheable and wrong endpoint responses fail closed',async()=>{
 for(const kind of ['fail','redirect','nonjson','cacheable','wrongurl']){
 const result=await fetchTrustedGeo({...context,endpoint,now:()=>1000,fetchImpl:async()=>{if(kind==='fail')throw Error('network');const response=new Response('{}',{headers:{'content-type':kind==='nonjson'?'text/html':'application/json','cache-control':kind==='cacheable'?'public,max-age=600':'no-store'}});Object.defineProperty(response,'url',{value:kind==='wrongurl'?'https://evil.invalid/geo':endpoint});if(kind==='redirect')Object.defineProperty(response,'redirected',{value:true});return response;}});assert.equal(result,null);
 }
});
test('perpetual successful loading without scope releases explicit trusted country after chosen delay',async()=>{
 const {geo}=await geoFixture(),f=controller(geo);f.c.observeCmp(loading,true);assert.equal(f.c.selectNativeMode(),null);
 for(let n=0;n<3;n++){f.tick(10);f.c.observeCmp(loading,true);}
 const s=f.c.snapshot();assert.equal(s.reason,'regional-scope');assert.equal(s.ready,true);assert.deepEqual(f.c.selectNativeMode(),{mode:'static',consentData:{gdprApplies:false}});assert(f.c.canRequest(s.epoch));
 // Expiry prevents accepting an old response; it is not a pageview lifetime/refresh cutoff.
 f.tick(120000);assert(f.c.canRequest(s.epoch));assert.equal(f.c.snapshot().source,'geo');
});
test('time alone, forged geo, cross-page result, API silence and user choice never grant scope',async()=>{
 const {geo}=await geoFixture();
 for(const proof of [null,{...geo},geo]){const f=controller(proof,proof===geo?{pageId:'page-another'}:{});f.c.observeCmp(loading,true);f.tick(60000);assert.equal(f.c.selectNativeMode(),null);}
 for(const data of [null,{cmpStatus:'loaded',eventStatus:'cmpuishown'}]){const f=controller(geo);if(data)f.c.observeCmp(data,true);f.tick(60000);assert.equal(f.c.selectNativeMode(),null);}
 assert.throws(()=>createGeoCmpFallback({...context,geo}),/threshold/);
});
test('successful gdprApplies true during loading is conflict, including after subsequent error',async()=>{
 const {geo}=await geoFixture(),f=controller(geo);f.c.observeCmp({...loading,gdprApplies:true},true);f.tick(60000);assert.equal(f.c.snapshot().reason,'cmp-scope-conflict');assert.equal(f.c.selectNativeMode(),null);f.c.observeCmp(null,false);assert.equal(f.c.selectNativeMode(),null);
});
test('valid CMP Reject before fallback controls IAB startup and cannot turn into regional static',async()=>{
 const {geo}=await geoFixture(),f=controller(geo);f.c.observeCmp(reject,true);assert.equal(f.c.snapshot().source,'cmp');assert.deepEqual(f.c.selectNativeMode(),{mode:'iab'});assert(f.c.canRequest());f.c.observeCmp(loading,true);f.tick(60000);assert.equal(f.c.canRequest(),false);
});
test('late true or Reject after static initialization invalidates epoch and locks future requests',async()=>{
 for(const cmp of [{...loading,gdprApplies:true},reject]){const {geo}=await geoFixture(),f=controller(geo);f.c.observeCmp(loading,true);f.tick(30);f.c.selectNativeMode();const token=f.c.snapshot().epoch;assert(f.c.canRequest(token));f.c.observeCmp(cmp,true);assert(!f.c.canRequest(token));assert(!f.c.canRequest());assert.equal(f.c.selectNativeMode(),null);assert(f.invalidations.some(x=>x.epoch>token));}
});
test('valid CMP out-of-scope works without GEO and never invents TC or purpose/vendor grants',()=>{
 const f=controller(null);f.c.observeCmp({gdprApplies:false},true);assert.deepEqual(f.c.selectNativeMode(),{mode:'iab'});assert(f.c.canRequest());const exported=JSON.stringify(f.c.snapshot());assert(!/tcString|purpose|vendor|synthetic/.test(exported));f.c.dispose();assert(!f.c.canRequest());
});
test('same-origin GET without Origin header works; missing Origin on cross-origin endpoint is denied',async()=>{
 for(const [endpointOrigin,status] of [[origin,200],['https://other.invalid',403]]){const req=new Request(endpointOrigin+'/geo?'+new URLSearchParams(context));Object.defineProperty(req,'cf',{value:{country:'RS'}});const reply=handleGeoScopeRequest(req,{siteId:context.siteId,allowCountries:['RS'],allowedOrigin:origin,now:1000});assert.equal(reply.status,status);if(status===200)assert.equal((await reply.json()).allowed,true);}
});
test('epoch invalidation callback can inspect blocked state without recursive reentry',async()=>{
 const {geo}=await geoFixture();let controllerState,time=1000,seen=[];const c=createGeoCmpFallback({...context,geo,waitMs:0,now:()=>time,onInvalidate(){seen.push(c.snapshot());}});c.observeCmp(loading,true);c.selectNativeMode();c.observeCmp(reject,true);assert.equal(seen.at(-1).ready,false);assert.equal(seen.at(-1).reason,'native-scope-conflict');
});
test('fresh response adopted after expiry or before issue time stays unavailable, accepted navigation persists',async()=>{
 const {geo}=await geoFixture();for(const now of [999,61000]){const f=controller(geo,{now:()=>now,waitMs:0});f.c.observeCmp(loading,true);assert.equal(f.c.snapshot().reason,'geo-unavailable');assert.equal(f.c.selectNativeMode(),null);}
 const f=controller(geo);f.c.observeCmp(loading,true);f.tick(120000);assert.equal(f.c.selectNativeMode().mode,'static');assert(f.c.canRequest());
});
test('early regional plan requires fresh owned navigation before any CMP/native initialization',async()=>{
 const {geo}=await geoFixture(),input={...context,geo,now:()=>1000,publisherOwnsCmpStartup:true,existingTcfApi:false,existingPrebidInitialized:false,existingGptInitialized:false,hasObservedCmp:false};
 assert.deepEqual(planRegionalStartup(input),{route:'regional',consentData:{gdprApplies:false}});
 for(const patch of [{publisherOwnsCmpStartup:false},{publisherOwnsCmpStartup:undefined},{existingTcfApi:true},{existingTcfApi:undefined},{existingPrebidInitialized:true},{existingGptInitialized:true},{existingGptInitialized:undefined},{hasObservedCmp:true},{hasObservedCmp:undefined},{pageId:'page-another'},{nonce:'nonce-another'},{now:()=>61000},{now:()=>999},{geo:{...geo}}])assert.deepEqual(planRegionalStartup({...input,...patch}),{route:'cmp'});
 const denied=await geoFixture({country:'DE',allowCountries:['DE']});assert.deepEqual(planRegionalStartup({...input,geo:denied.geo}),{route:'cmp'});
 const off=await geoFixture({allowCountries:[]});assert.deepEqual(planRegionalStartup({...input,geo:off.geo}),{route:'cmp'});
});
