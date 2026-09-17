import test from 'node:test';
import assert from 'node:assert/strict';
import {unzipSync} from 'fflate';
import {cacheSelectionFixture} from '../support/cache-selection-fixture.mjs';
import {descriptorForPin as mainDescriptor,runtimeCatalog as mainCatalog} from '../../worker/test-workspace/runtime-catalog.mjs';
import {siteRuntimeResponse} from '../../worker/site-runtime/service.mjs';
import {sha256} from '../../worker/runtime/prebid-artifact-check.mjs';
const fixtures=[];test.afterEach(()=>fixtures.splice(0).forEach(f=>f.close()));
test.before(()=>{globalThis.fetch=()=>assert.fail('No external requests');});
const ready=async()=>{const f=await cacheSelectionFixture();fixtures.push(f);return f;};
const state=f=>f.api('/test-api/runtime-selection');
function choice(s,policy={mode:'auction-with-cache',maxAgeSeconds:60}){return {expectedRevision:s.revision,selection:{runtime:s.runtimes.find(r=>r.version==='3.13.0').pin,allowPreview:true,enablePrebid:s.enablePrebid,prebidBuildId:s.prebidBuildId,bidCache:policy}};}
async function packageAt(f,note){const s=await f.api('/test-api/site-packages');assert(s.ready,s.error);const result=await f.api('/test-api/site-packages',{action:'generate',revision:s.revision,notes:note},201);const r=await f.request('/test-api/releases/'+result.release.id+'/download');return {id:result.release.id,bytes:new Uint8Array(await r.response.arrayBuffer())};}
const configFrom=p=>JSON.parse(new TextDecoder().decode(unzipSync(p.bytes)['config.json']));
test('private explicit selection preserves defaults, old ZIPs, settings and both editor views; changed policy creates another immutable package',async()=>{
 const f=await ready(),old=await packageAt(f,'Before cache'),s=await state(f),before=f.readConfig();
 assert.equal(s.runtimes.length,5);assert.equal(s.runtimes[0].version,'3.10.0-tessera.preview.1');assert.equal(s.bidCache,null);
 assert.equal(mainCatalog.length,2);assert.throws(()=>mainDescriptor(choice(s).selection.runtime));
 await f.api('/test-api/runtime-selection',choice(s));
 let selected=await state(f);assert.equal(selected.selected.runtime.runtimeVersion,'3.13.0');assert.deepEqual(selected.bidCache,{mode:'auction-with-cache',maxAgeSeconds:60});
 const after=f.readConfig();assert.deepEqual(after.builtinRuntimeSelection.prebid,before.builtinRuntimeSelection.prebid);delete after.runtimeControls.bidCache;after.builtinRuntimeSelection=before.builtinRuntimeSelection;assert.deepEqual(after,before);
 const editor=await f.api('/test-api/site-runtime');assert.equal(editor.selected.runtimeVersion,'3.13.0');assert.deepEqual(editor.bidCache,selected.bidCache);assert.equal(editor.validationIssue,null);
 const a=await packageAt(f,'Cache 60');assert.deepEqual(configFrom(a).bidCache,selected.bidCache);
 await f.api('/test-api/site-runtime',{action:'version',revision:editor.revision,runtime:editor.selected,allowPreview:true,bidCache:{mode:'fresh-only',maxAgeSeconds:90}});
 selected=await state(f);assert.deepEqual(selected.bidCache,{mode:'fresh-only',maxAgeSeconds:90});
 const b=await packageAt(f,'Fresh 90');assert.deepEqual(configFrom(b).bidCache,selected.bidCache);assert.notEqual(a.id,b.id);
 for(const p of [old,a])assert.deepEqual(new Uint8Array(await (await f.request('/test-api/releases/'+p.id+'/download')).response.arrayBuffer()),p.bytes);
 const ex=await f.api('/test-api/experiments');assert(ex.sources.some(r=>r.releaseId===a.id));assert(ex.sources.some(r=>r.releaseId===b.id));
 const aa=await f.api('/test-api/experiments/save',{expectedRevision:ex.revision,siteId:'test-site',releaseA:a.id,releaseB:a.id,trafficB:50});const row=aa.experiments.at(-1);
 await f.api('/test-api/experiments/start',{expectedRevision:aa.revision,experimentId:row.id});
 const loader=await f.request('/test-api/experiments/preview/test-site/ads.js');assert.equal(loader.response.status,200);assert.match(await loader.response.text(),/3.13.0/);
 // Selecting an old version retains unused cache settings, without retrofitting it.
 const latest=await state(f),oldChoice=choice(latest);oldChoice.selection.runtime=latest.runtimes[0].pin;delete oldChoice.selection.bidCache;
 await f.api('/test-api/runtime-selection',oldChoice);assert.deepEqual((await state(f)).bidCache,{mode:'fresh-only',maxAgeSeconds:90});
 assert.equal(configFrom(await packageAt(f,'Return to old')).bidCache,undefined);
});
test('both writers require explicit valid mode, bounded age and preview approval; main refuses cache fields',async()=>{
 const f=await ready(),s=await state(f),before=f.readConfig();
 for(const policy of [null,{},true,{mode:'cache-first',maxAgeSeconds:60},{mode:'fresh-only',maxAgeSeconds:'60'},{mode:'fresh-only',maxAgeSeconds:0},{mode:'fresh-only',maxAgeSeconds:301},{mode:'fresh-only',maxAgeSeconds:1.5},{mode:'fresh-only',maxAgeSeconds:60,extra:true}]){
  await f.api('/test-api/runtime-selection',choice(s,policy),422);
  await f.api('/test-api/site-runtime',{action:'version',revision:s.revision,runtime:choice(s).selection.runtime,allowPreview:true,bidCache:policy},422);
 }
 const missing=choice(s);delete missing.selection.bidCache;await f.api('/test-api/runtime-selection',missing,422);
 const unapproved=choice(s);unapproved.selection.allowPreview=false;await f.api('/test-api/runtime-selection',unapproved,422);
 const old=choice(s);old.selection.runtime=s.runtimes[0].pin;await f.api('/test-api/runtime-selection',old,422);
 const main=await siteRuntimeResponse(new Request('https://example.invalid/',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'version',revision:s.revision,runtime:old.selection.runtime,allowPreview:true,bidCache:{mode:'fresh-only',maxAgeSeconds:60}})}),f.env,'test-site','tester');assert.equal(main.status,422);
 assert.deepEqual(f.readConfig(),before);
});
test('stale concurrent cache edits, receipts and uncertain writes retain existing atomic protections',async()=>{
 const f=await ready(),s=await state(f);await f.api('/test-api/runtime-selection',choice(s));
 await f.api('/test-api/runtime-selection',choice(s,{mode:'fresh-only',maxAgeSeconds:100}),409);
 const fresh=await state(f),results=await Promise.all([f.request('/test-api/runtime-selection',choice(fresh,{mode:'fresh-only',maxAgeSeconds:90})),f.request('/test-api/runtime-selection',choice(fresh,{mode:'auction-with-cache',maxAgeSeconds:120}))]);
 assert.deepEqual(results.map(r=>r.response.status).sort(),[200,409]);
 const current=await state(f),noOp=await f.api('/test-api/runtime-selection',choice(current,current.bidCache));assert.equal(noOp.changed,false);
 const generated=await f.api('/test-api/generate',{acknowledge:true});
 const next=await state(f);await f.api('/test-api/runtime-selection',choice(next,{mode:'auction-with-cache',maxAgeSeconds:70}));
 await f.api('/test-api/save',{receipt:generated.receipt,acknowledge:true,note:'stale cache'},409);
 const confirmed=await state(f),batch=f.env.DB.batch;let once=true;
 f.env.DB.batch=async items=>{const result=await batch(items);if(once&&items.some(i=>i.sql.startsWith('UPDATE publisher_configs SET config_json'))){once=false;throw Error('synthetic lost acknowledgement');}return result;};
 await f.api('/test-api/runtime-selection',choice(confirmed,{mode:'fresh-only',maxAgeSeconds:80}),503);
 const recovered=await state(f);assert.deepEqual(recovered.bidCache,{mode:'fresh-only',maxAgeSeconds:80});
 assert.equal((await f.api('/test-api/runtime-selection',choice(recovered,recovered.bidCache))).changed,false);
});
test('same-version Prebid bytes with a different hash cannot be selected or generated',async()=>{
 const f=await ready(),s=await state(f),original=f.objects.get(f.prebidKey),changed=original.slice();changed[changed.length-1]^=1;
 f.objects.set(f.prebidKey,changed);f.metadata.set(f.prebidKey,{version:'11.34.0',sha256:await sha256(changed)});
 const r=await f.request('/test-api/runtime-selection',choice(s));assert.equal(r.response.status,422);assert.match(r.data.error,/exact reviewed Prebid/);
 f.objects.set(f.prebidKey,original);f.metadata.set(f.prebidKey,{version:'11.34.0',sha256:await sha256(original)});await f.api('/test-api/runtime-selection',choice(s));
 f.objects.set(f.prebidKey,changed);f.metadata.set(f.prebidKey,{version:'11.34.0',sha256:await sha256(changed)});
 assert.equal((await f.api('/test-api/site-packages')).ready,false);
 const invalid=await state(f);assert.equal(invalid.selected,null);assert(invalid.validationIssue);
});
