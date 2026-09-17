import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { unzipSync } from 'fflate';
import { createExperimentDelivery } from '../../worker/experiments/delivery.mjs';
import { experimentFixture, experimentConfig } from '../support/experiment-fixture.mjs';
import { metadata, zipBase64 } from '../../.generated/tanjug-pilot.mjs';

const origin = 'https://experiment.invalid';
const a = await experimentFixture('A'), b = await experimentFixture('B');
const packages = {[a.descriptor.packageSha256]:a,[b.descriptor.packageSha256]:b};
const config = experimentConfig(a,b);
const request = (path='/ads.js', country='RS', init={}) => {
  const r = new Request(origin+path,init);
  Object.defineProperty(r,'cf',{value:{country}});
  return r;
};
const make = (overrides={}, sample=0.9) => createExperimentDelivery({...config,...overrides},packages,{random:()=>sample});
function browser() {
  const entries=[];
  const document={currentScript:{src:origin+'/ads.js',nonce:'fixture-nonce'},
    createElement:()=>({}), head:{appendChild:e=>entries.push(e)}};
  const window={};
  const context=vm.createContext({window,document,URL});
  return {window,document,entries,context,run:source=>vm.runInContext(source,context),state:()=>window.__tesseraExperiments?.['tanjug-test']};
}
async function load(delivery, country='RS', page=browser()) {
  const response=delivery.fetch(request('/ads.js',country));
  page.run(await response.text());
  return page;
}

test('weighted allocation uses precise boundaries, 0/100 and disabled control',async()=>{
  for (const [trafficB,sample,variant] of [[50,0,'B'],[50,0.49999,'B'],[50,0.5,'A'],[10,0.099,'B'],[10,0.1,'A'],[0,0,'A'],[100,0.999,'B']]) {
    const page=await load(await make({trafficB},sample));
    assert.equal(page.state().context.variant,variant);
    assert.equal(page.entries.length,1);
    assert.equal(page.entries[0].nonce,'fixture-nonce');
  }
  const page=await load(await make({enabled:false,trafficB:100},0));
  assert.equal(page.state().context.variant,'A');assert.equal(page.state().context.active,false);
});
test('controlled 10000-request sample honors 90/10 without cookies or IP identity',async()=>{
  let n=0; const delivery=await createExperimentDelivery({...config,trafficB:10},packages,{random:()=>n++/10000});
  let count=0;
  for(let i=0;i<10000;i++) if((await delivery.fetch(request()).text()).includes('"variant":"B"'))count++;
  assert.equal(count,1000);
});
test('A/A can assign different groups to the exact same package',async()=>{
  const single={[a.descriptor.packageSha256]:a};
  for(const sample of [0,0.9]) {
    const delivery=await createExperimentDelivery(experimentConfig(a),single,{random:()=>sample});
    const page=await load(delivery);
    const script=delivery.fetch(new Request(page.entries[0].src));
    page.run(await script.text());page.entries[0].onload();
    assert.equal(page.window.fixtureExecutions,1);
    assert.equal(page.window.fixtureLabel,'A');
    assert.equal(page.state().status,'loaded');
    assert.equal(page.state().context.packageSha256,a.descriptor.packageSha256);
  }
});
test('duplicate tags, new revisions and Stop cannot restart the same document',async()=>{
  const page=await load(await make({},0));
  await load(await make({revision:2,enabled:false}),'DE',page);
  assert.equal(page.entries.length,1);assert.equal(page.state().context.variant,'B');
  assert.equal(page.state().snapshot().loaderAttempts,2);
  assert.equal(page.state().snapshot().blockedDuplicates,1);
  assert.equal(page.state().context.country,'RS');assert.equal(page.state().context.revision,1);
  const fresh=await load(await make({revision:2,enabled:false}));
  assert.equal(fresh.state().context.variant,'A');assert.equal(fresh.entries.length,1);
});
test('loader failure never starts a fallback runtime after possible partial execution',async()=>{
  const page=await load(await make({},0));
  page.window.fixtureExecutions=1;page.entries[0].onerror();
  await load(await make(),'RS',page);
  assert.equal(page.state().status,'load-error');assert.equal(page.entries.length,1);
  assert.equal(page.window.fixtureExecutions,1);
});
test('country is per-request metadata, not gdprApplies or a consent override',async()=>{
  const delivery=await make();
  for (const value of ['RS','DE','GB','CH','US',null,undefined,'XX','T1','ZZ','EU','rs','<script>']) {
    const page=await load(delivery,value);
    const expected=['RS','DE','GB','CH','US'].includes(value)?value:null;
    // undefined uses load's default; exercise true missing cf separately below.
    if(value!==undefined)assert.equal(page.state().context.country,expected);
    assert(!('gdprApplies' in page.state().context));
    assert.equal(page.window.__tcfapi,undefined);
  }
  const source=await delivery.fetch(new Request(origin+'/ads.js',{headers:{'cf-ipcountry':'US'}})).text();
  const page=browser();page.run(source);assert.equal(page.state().context.country,null);
});
test('missing script tag and blocked insertion do not create duplicate runtimes',async()=>{
  const delivery=await make();
  const source=await delivery.fetch(request()).text();
  const noTag=browser();noTag.document.currentScript=null;noTag.run(source);
  assert.equal(noTag.entries.length,0);assert.equal(noTag.state(),undefined);
  const blocked=browser();blocked.document.head.appendChild=()=>{throw Error('blocked');};
  blocked.run(source);assert.equal(blocked.state().status,'load-error');
  blocked.run(source);assert.equal(blocked.entries.length,0);
});
test('loader is never shared-cached, conditional requests cannot reuse another decision',async()=>{
  const delivery=await make();
  const r=delivery.fetch(request('/ads.js','DE',{headers:{'if-none-match':'"old"'}}));
  assert.equal(r.status,200);
  for(const key of ['cache-control','cdn-cache-control','cloudflare-cdn-cache-control']) assert.match(r.headers.get(key),/no-store/);
  assert.equal(r.headers.get('set-cookie'),null);assert.equal(r.headers.get('etag'),null);
  assert.equal(await delivery.fetch(request('/ads.js','RS',{method:'HEAD'})).text(),'');
});
test('only pinned JS assets are public, with exact bytes and immutable headers',async()=>{
  const delivery=await make();
  const path='/releases/'+a.descriptor.packageSha256+'/ads.js';
  const r=delivery.fetch(request(path));
  assert.match(r.headers.get('cache-control'),/immutable/);
  assert.deepEqual(new Uint8Array(await r.arrayBuffer()),a.files['ads.min.js']);
  for (const p of ['/config.json','/manifest.json','/releases/'+a.descriptor.packageSha256+'/config.json','/releases/'+ 'f'.repeat(64)+'/ads.js','/ads.js?variant=B','/ads.js?country=US'])assert.equal(delivery.fetch(request(p)).status,404);
  assert.equal(delivery.fetch(request('/ads.js','RS',{method:'POST'})).status,405);
});
test('invalid settings and allocation inputs are rejected',async()=>{
  for(const change of [{trafficB:-1},{trafficB:101},{trafficB:1.2},{enabled:'true'},{revision:0},{siteId:1},{experimentId:1},{experimentId:'</script>'},{profile:'live'},{extra:true}])await assert.rejects(make(change));
  for(const sample of [-1,1,NaN,Infinity,'0.5']) {
    const delivery=await make({},sample);assert.throws(()=>delivery.fetch(request()),/allocation sample/);
  }
});
test('package scope, full manifest, pins, corruption and extra registry entries are checked',async()=>{
  const corrupt=structuredClone(packages);corrupt[a.descriptor.packageSha256].files['ads.min.js'][0]^=1;
  await assert.rejects(createExperimentDelivery(config,corrupt),/checksum/);
  await assert.rejects(make({siteId:'other-site'}),/manifest/);
  await assert.rejects(createExperimentDelivery(config,{...packages,['f'.repeat(64)]:a}),/registry/);
  const wrong={...packages,[a.descriptor.packageSha256]:b};
  await assert.rejects(createExperimentDelivery(config,wrong),/pin/);
});
test('caller mutations during and after preparation cannot change pinned serving bytes',async()=>{
  const mutable=structuredClone(packages), settings={...config};
  const pending=createExperimentDelivery(settings,mutable,{random:()=>0.9});
  mutable[a.descriptor.packageSha256].files['ads.min.js'].fill(0);settings.trafficB=100;
  const delivery=await pending;
  const page=await load(delivery);assert.equal(page.state().context.variant,'A');
  assert.deepEqual(new Uint8Array(await delivery.fetch(new Request(page.entries[0].src)).arrayBuffer()),a.files['ads.min.js']);
});
test('delivery identity changes with rules, but original Tanjug package remains byte-identical',async()=>{
  const bytes=new Uint8Array(Buffer.from(zipBase64,'base64'));
  const files=unzipSync(bytes), original=structuredClone(files);
  const pin=metadata.descriptor.packageSha256;
  const settings=experimentConfig({descriptor:metadata.descriptor});
  const delivery=await createExperimentDelivery(settings,{[pin]:{files}});
  for(const [name,source] of [['ads.js','ads.min.js'],['prebid.js','prebid.js']]) {
    const r=delivery.fetch(request('/releases/'+pin+'/'+name));
    assert.deepEqual(new Uint8Array(await r.arrayBuffer()),original[source]);
  }
  assert.deepEqual(files,original);
  const changed=await createExperimentDelivery({...settings,revision:2,trafficB:10},{[pin]:{files}});
  assert.notEqual(changed.deliverySha256,delivery.deliverySha256);
  const page=await load(delivery);
  for(const [index,name] of [[0,'prebid.js'],[1,'ads.min.js']]) {
    const expected=metadata.descriptor.files.find(f=>f.name===name).sha256;
    assert.equal(page.entries[index].integrity,'sha256-'+Buffer.from(expected,'hex').toString('base64'));
    page.entries[index].onload();
  }
});

test('pinned dependency loads before ads and an error never starts ads or fallback',async()=>{
  const candidate=await experimentFixture('pinned',{prebid:true});
  const delivery=await createExperimentDelivery(experimentConfig(candidate),{[candidate.descriptor.packageSha256]:candidate});
  const page=await load(delivery);
  assert.equal(page.entries.length,1);assert.match(page.entries[0].src,/prebid.js$/);
  page.run(await delivery.fetch(new Request(page.entries[0].src)).text());
  page.entries[0].onload();page.entries[0].onload();
  assert.equal(page.entries.length,2);assert.match(page.entries[1].src,/ads.js$/);
  page.run(await delivery.fetch(new Request(page.entries[1].src)).text());page.entries[1].onload();
  assert.equal(page.window.fixtureExecutions,1);
  assert.deepEqual(Array.from(page.state().snapshot().events,e=>e.type),['assigned','prebid-loaded','script-loaded']);
  const broken=await load(delivery);broken.entries[0].onerror();broken.entries[0].onload();
  assert.equal(broken.entries.length,1);assert.equal(broken.state().status,'load-error');
  assert.deepEqual(Array.from(broken.state().snapshot().events,e=>e.type),['assigned','load-error']);
});
test('legacy and cross-site conflicts remain in assignment counts without starting scripts',async()=>{
  for(const key of ['pbjs','__TESSERA_RUNTIME_STARTED','__tesseraExperimentOwner']) {
    const page=browser();page.window[key]={existing:true};await load(await make(),'RS',page);
    assert.equal(page.entries.length,0);assert.equal(page.state().status,'conflict');
    assert.deepEqual(Array.from(page.state().snapshot().events,e=>e.type),['assigned','conflict']);
    const snapshot=page.state().snapshot();snapshot.events.length=0;
    assert.equal(page.state().snapshot().events.length,2);
  }
});
