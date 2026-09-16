import test from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync } from 'fflate';
import { generatedLiteral } from '../support/generated-literal.mjs';
import worker from '../../worker/test-workspace/index.mjs';
import { workspaceStore,ORIGIN,TEST_EMAIL,TEST_PASSWORD } from '../support/test-workspace-store.mjs';
import { defaultOverlay } from '../../worker/runtime-next/position-settings.mjs';
import { storePrebidFile } from '../../worker/test-workspace/prebid-files.mjs';
import { prebidStore } from '../../worker/test-workspace/prebid-settings.mjs';
const fixtures=[],oldFetch=globalThis.fetch;
test.before(()=>{globalThis.fetch=()=>assert.fail('No real network requests in the editor');});
test.after(()=>{globalThis.fetch=oldFetch;});test.afterEach(()=>{while(fixtures.length)fixtures.pop().close();});
async function req(f,path,cookie,body,origin=ORIGIN){const r=await worker.fetch(new Request(ORIGIN+path,{method:body===undefined?'GET':'POST',headers:{...(cookie?{cookie}:{}),...(body===undefined?{}:{origin,'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)}),f.env);return {r,data:r.headers.get('content-type')?.includes('json')?await r.json():null};}
async function ready(options={}){const f=workspaceStore(options);fixtures.push(f);const logged=await worker.fetch(new Request(ORIGIN+'/api/auth/login',{method:'POST',headers:{origin:ORIGIN,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({email:TEST_EMAIL,password:TEST_PASSWORD})}),f.env);const cookie=logged.headers.get('set-cookie').split(';')[0];assert.equal((await req(f,'/test-api/setup',cookie,{confirm:'prepare-empty-test-database'})).r.status,200);const s=(await req(f,'/test-api/runtime-selection',cookie)).data;assert.equal((await req(f,'/test-api/runtime-selection',cookie,{expectedRevision:s.revision,selection:{runtime:s.runtimes[0].pin,allowPreview:true,enablePrebid:false,prebidBuildId:null}})).r.status,200);return {f,cookie};}
const state=async(f,cookie)=>(await req(f,'/test-api/site-settings',cookie)).data;
const save=(f,cookie,s)=>req(f,'/test-api/site-settings',cookie,{expectedRevision:s.revision,acknowledge:true,draft:s.draft});
const generate=(f,cookie)=>req(f,'/test-api/generate',cookie,{acknowledge:true});
test('legacy generation cannot share the Interstitial fallback with a regular position',async()=>{
  const {f,cookie}=await ready();f.sqlite.prepare("UPDATE ad_units SET code='Interstitial' WHERE code='Billboard'").run();
  const g=await req(f,'/test-api/generate',cookie,{acknowledge:true,takeOverEnabled:true});assert.equal(g.r.status,409);assert.match(g.data.error,/separate from regular ad positions/);assert.equal(f.objects.size,0);
});
test('saved TakeOver controls drive Generate, status and the exact saved package',async()=>{
  const {f,cookie}=await ready(),s=await state(f,cookie);
  Object.assign(s.draft.takeOver,{enabled:true,adUnitCode:'Overlay',desktopSize:[970,600],mobileSize:[320,250],desktopMinWidth:1200,autoCloseDesktopSec:0,autoCloseMobileSec:8,showCountdown:false});
  assert.equal((await save(f,cookie,s)).r.status,200);
  assert.deepEqual((await state(f,cookie)).draft.takeOver,s.draft.takeOver);
  assert.equal((await req(f,'/test-api/status',cookie)).data.takeOver.enabled,true);
  const g=await generate(f,cookie);assert.equal(g.r.status,200,JSON.stringify(g.data));
  for(const [name,value] of Object.entries({TAKEOVER_ENABLED:true,TAKEOVER_AD_UNIT_CODE:'Overlay',TAKEOVER_DESKTOP_SIZE:[970,600],TAKEOVER_MOBILE_SIZE:[320,250],TAKEOVER_DESKTOP_MIN_WIDTH:1200,TAKEOVER_AUTO_CLOSE_DESKTOP_SEC:0,TAKEOVER_AUTO_CLOSE_MOBILE_SEC:8,TAKEOVER_SHOW_COUNTDOWN:false}))assert.deepEqual(generatedLiteral(g.data.adsJs,name),value);
  const release=await req(f,'/test-api/save',cookie,{receipt:g.data.receipt,acknowledge:true,note:'Saved TakeOver'});assert.equal(release.r.status,200);
  const zip=unzipSync(new Uint8Array(await(await req(f,'/test-api/releases/'+release.data.draft.id+'/download',cookie)).r.arrayBuffer()));
  assert.equal(new TextDecoder().decode(zip['ads.js']),g.data.adsJs);
  const c=JSON.parse(new TextDecoder().decode(zip['config.json']));
  assert(JSON.stringify(c).includes('Overlay'));
});
test('turning TakeOver off preserves its dimensions, timers and unrelated settings',async()=>{
  const {f,cookie}=await ready();let s=await state(f,cookie);s.draft.takeOver.enabled=true;s.draft.takeOver.mobileSize=[320,480];s.draft.takeOver.autoCloseDesktopSec=0;await save(f,cookie,s);
  s=await state(f,cookie);const positions=structuredClone(s.draft.units);s.draft.takeOver.enabled=false;assert.equal((await save(f,cookie,s)).r.status,200);
  const after=await state(f,cookie);assert.deepEqual(after.draft.takeOver,s.draft.takeOver);assert.deepEqual(after.draft.units,positions);
  const g=await generate(f,cookie);assert.equal(g.r.status,200);assert.equal(generatedLiteral(g.data.adsJs,'TAKEOVER_ENABLED'),false);
});
test('an older Generate tab cannot override saved TakeOver or save a stale review',async()=>{
  const {f,cookie}=await ready(),g=await generate(f,cookie),s=await state(f,cookie);s.draft.takeOver.enabled=true;await save(f,cookie,s);
  const old=await req(f,'/test-api/generate',cookie,{acknowledge:true,takeOverEnabled:false});assert.equal(old.r.status,409);assert.match(old.data.error,/saved site settings/);
  assert.equal((await req(f,'/test-api/save',cookie,{receipt:g.data.receipt,acknowledge:true,note:''})).r.status,409);assert.equal(f.objects.size,0);
});
test('reading defaults does not save them and old editor payloads retain stored TakeOver',async()=>{
  const {f,cookie}=await ready(),before=f.sqlite.prepare('SELECT config_json FROM publisher_configs').get().config_json;
  let s=await state(f,cookie);assert.equal(s.draft.takeOver.enabled,false);await req(f,'/test-api/status',cookie);
  assert.equal(f.sqlite.prepare('SELECT config_json FROM publisher_configs').get().config_json,before);
  s.draft.takeOver.enabled=true;await save(f,cookie,s);s=await state(f,cookie);const kept=structuredClone(s.draft.takeOver);delete s.draft.takeOver;s.draft.site.name='Another edit';
  assert.equal((await save(f,cookie,s)).r.status,200);assert.deepEqual((await state(f,cookie)).draft.takeOver,kept);
});
test('site settings page/script/API require authentication',async()=>{const f=workspaceStore();fixtures.push(f);Object.defineProperty(f.env,'DB',{get(){assert.fail('No database before authentication');}});for(const p of ['/site-settings','/site-settings.js'])assert.equal((await req(f,p)).r.status,303);for(const body of [undefined,{}])assert.equal((await req(f,'/test-api/site-settings',null,body)).r.status,401);});
test('editor HTML and script maintain restrictive CSP with no ad execution',async()=>{const{f,cookie}=await ready();const{r}=await req(f,'/site-settings',cookie);assert.equal(r.status,200);assert.match(r.headers.get('content-security-policy'),/default-src 'none'/);const text=await r.text();assert.match(text,/Save site settings/);assert(!text.includes('gpt.js'));assert(!text.includes('<iframe'));const js=await req(f,'/site-settings.js',cookie);assert.equal(js.r.status,200);});
test('authenticated settings response never exposes extra configuration',async()=>{const{f,cookie}=await ready();const c=JSON.parse(f.sqlite.prepare('SELECT config_json FROM publisher_configs').get().config_json);c.secretLike='do-not-expose';f.sqlite.prepare('UPDATE publisher_configs SET config_json=?').run(JSON.stringify(c));const s=await state(f,cookie);assert(!JSON.stringify(s).includes('do-not-expose'));assert.equal(s.prebidEditable,false);assert.equal(s.siteId,'test-site');});
test('saved site fields and positions drive real compiler and TakeOver path, not original demo values',async()=>{const{f,cookie}=await ready(),s=await state(f,cookie);s.draft.takeOver.enabled=true;s.draft.site={name:'Pilot test copy',domain:'pilot.example.invalid',gamPath:'/123/pilot/'};s.draft.units.push({code:'InText1',type:'BTF',sizeMap:'display',enabled:true});s.draft.maps[0].breakpoints[0].sizes=[[300,600],[300,250]];const written=await save(f,cookie,s);assert.equal(written.r.status,200,JSON.stringify(written.data));const g=await generate(f,cookie);assert.equal(g.r.status,200,JSON.stringify(g.data));assert.equal(generatedLiteral(g.data.adsJs,'adUnitPath'),'/123/pilot/');assert(generatedLiteral(g.data.adsJs,'EXPLICIT_UNITS').some(u=>u.id==='InText1'));assert.deepEqual(generatedLiteral(g.data.adsJs,'SIZE_MAPS_RAW').display[0].sizes,[[300,600],[300,250]]);assert.equal(generatedLiteral(g.data.adsJs,'TAKEOVER_CODELESS_AD_UNIT_PATH'),'/123/pilot/Interstitial');const saved=await req(f,'/test-api/save',cookie,{receipt:g.data.receipt,acknowledge:true,note:'pilot copy'});assert.equal(saved.r.status,200,JSON.stringify(saved.data));const file=await req(f,'/test-api/releases/'+saved.data.draft.id+'/download',cookie);const zip=unzipSync(new Uint8Array(await file.r.arrayBuffer()));assert.equal(new TextDecoder().decode(zip['ads.js']),g.data.adsJs);assert.equal(Object.keys(zip).length,9);assert.equal((await state(f,cookie)).draft.site.gamPath,'/123/pilot/');});
test('runtime selection works after approved test-copy identity change',async()=>{const{f,cookie}=await ready(),s=await state(f,cookie);s.draft.site.domain='pilot.example';s.draft.site.gamPath='/123/pilot/';assert.equal((await save(f,cookie,s)).r.status,200);const r=await req(f,'/test-api/runtime-selection',cookie);assert.equal(r.r.status,200,JSON.stringify(r.data));assert.equal(r.data.site.domain,'pilot.example');assert(r.data.selected);});
test('old receipt is rejected and stored ZIP stays identical after site editing',async()=>{const{f,cookie}=await ready(),g=await generate(f,cookie);const stored=await req(f,'/test-api/save',cookie,{receipt:g.data.receipt,acknowledge:true,note:''});const path='/test-api/releases/'+stored.data.draft.id+'/download';const before=new Uint8Array(await(await req(f,path,cookie)).r.arrayBuffer());const s=await state(f,cookie);s.draft.site.name='Changed';assert.equal((await save(f,cookie,s)).r.status,200);assert.equal((await req(f,'/test-api/save',cookie,{receipt:g.data.receipt,acknowledge:true,note:''})).r.status,409);const after=new Uint8Array(await(await req(f,path,cookie)).r.arrayBuffer());assert.deepEqual(before,after);});
test('cross-origin, foreign site and injected config fields are rejected',async()=>{const{f,cookie}=await ready(),s=await state(f,cookie);const body={expectedRevision:s.revision,acknowledge:true,draft:s.draft};assert.equal((await req(f,'/test-api/site-settings',cookie,body,'https://evil.invalid')).r.status,403);assert.equal((await req(f,'/test-api/site-settings',cookie,{...body,siteId:'politika'})).r.status,422);assert.equal((await req(f,'/test-api/site-settings',cookie,{...body,configJson:'{}'})).r.status,422);assert.equal((await req(f,'/test-api/site-settings',cookie,{...body,draft:{...s.draft,enablePrebid:true}})).r.status,422);});
test('query routes and alternate write methods do not access a different site',async()=>{const{f,cookie}=await ready();assert.equal((await req(f,'/test-api/site-settings?site=politika',cookie)).r.status,404);const r=await worker.fetch(new Request(ORIGIN+'/test-api/site-settings',{method:'DELETE',headers:{cookie,origin:ORIGIN}}),f.env);assert.equal(r.status,405);});
test('existing schema and production capabilities stay unchanged',async()=>{const{f,cookie}=await ready(),s=await state(f,cookie),before=f.sqlite.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all();assert.equal((await save(f,cookie,s)).r.status,200);assert.deepEqual(f.sqlite.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all(),before);for(const p of ['/api/publishers','/api/publish','/api/ads-txt/publish','/cdn/test-site/ads.js'])assert.equal((await req(f,p,cookie)).r.status,404);});

for(const initial of ['',null])test('explicit sticky OFF survives editor save and generation: '+JSON.stringify(initial),async()=>{
  const{f,cookie}=await ready();const c=JSON.parse(f.sqlite.prepare('SELECT config_json FROM publisher_configs').get().config_json);
  c.runtimeControls??={};c.runtimeControls.sticky??={};c.runtimeControls.sticky.bottomAdUnitId=initial;
  f.sqlite.prepare('UPDATE publisher_configs SET config_json=?').run(JSON.stringify(c));
  const s=await state(f,cookie);assert.equal(s.draft.bottomStickyId,'');s.draft.site.name='Unrelated name edit';
  assert.equal((await save(f,cookie,s)).r.status,200);const g=await generate(f,cookie);assert.equal(g.r.status,200,JSON.stringify(g.data));
  assert.equal(generatedLiteral(g.data.adsJs,'STICKY_TARGET_ID'),'');
});

test('maximum-count valid editor draft larger than 16KB is accepted',async()=>{
  const{f,cookie}=await ready(),s=await state(f,cookie);
  const mapName=(i)=>'Map'+String(i).padStart(2,'0')+'X'.repeat(59);
  s.draft.maps=Array.from({length:32},(_,i)=>({name:mapName(i),breakpoints:Array.from({length:12},(_,j)=>({minWidth:j*900,sizes:Array.from({length:12},(_,k)=>[10000,10000-k])}))}));
  s.draft.units=Array.from({length:100},(_,i)=>({code:'Ad'+String(i).padStart(3,'0')+'X'.repeat(59),type:'BTF',sizeMap:mapName(i%32),enabled:true}));s.draft.bottomStickyId='';
  const body={expectedRevision:s.revision,acknowledge:true,draft:s.draft};const bytes=new TextEncoder().encode(JSON.stringify(body)).length;
  assert(bytes>16384 && bytes<262144);const result=await save(f,cookie,s);assert.equal(result.r.status,200,JSON.stringify(result.data));
  const read=await state(f,cookie);assert.equal(read.draft.units.length,100);assert.equal(read.draft.maps.length,32);
});
test('site editor rejects over 256KB without changing the saved revision',async()=>{
  const{f,cookie}=await ready(),before=await state(f,cookie);const tooBig=structuredClone(before);tooBig.draft.site.name='X'.repeat(262145);
  assert.equal((await save(f,cookie,tooBig)).r.status,413);assert.equal((await state(f,cookie)).revision,before.revision);
});
test('other test endpoints retain the existing 16KB JSON limit',async()=>{
  const{f,cookie}=await ready();assert.equal((await req(f,'/test-api/generate',cookie,{acknowledge:true,takeOverEnabled:false,extra:'X'.repeat(16385)})).r.status,413);
});

test('TakeOver ad position saves map, Prebid override, lazy rules and original uploaded bytes into one package',async()=>{
  const {f,cookie}=await ready({prebidFiles:true});
  const s=await state(f,cookie);
  s.draft.maps.push({name:'modal',breakpoints:[{minWidth:0,sizes:[[300,250]]},{minWidth:1024,sizes:[[800,600]]}]});
  s.draft.units.push({code:'Overlay',type:'ATF',sizeMap:'modal',enabled:true,display:'takeover',overlay:{...defaultOverlay(),demand:'site'}});
  s.draft.units[0].lazy={enabled:false,fetchMarginPx:500,renderMarginPx:0};
  let written=await save(f,cookie,s);assert.equal(written.r.status,422);assert.match(written.data.error,/Prebid \+ GAM/);
  s.draft.units.at(-1).overlay.demand='gam';
  written=await save(f,cookie,s);assert.equal(written.r.status,200,JSON.stringify(written.data));
  assert.deepEqual((await state(f,cookie)).draft.units.at(-1),s.draft.units.at(-1));
  const bytes=new TextEncoder().encode('/* prebid.js v11.11.0\nModules: consentManagementTcf,tcfControl,currency,adformBidAdapter */\nwindow.prebidFixtureOnly=true;');
  const file=await storePrebidFile(prebidStore(f.env),bytes,TEST_EMAIL);
  const pb=(await req(f,'/test-api/prebid-settings',cookie)).data;
  assert(pb.units.some(u=>u.code==='Overlay'));
  const draft={...pb.draft,enablePrebid:true,buildId:file.file.id,bidders:[{bidder:'adform',params:{mid:123},enabled:true}],overrides:[{bidder:'adform',scopeType:'adunit',scopeKey:'Overlay',params:{mid:456},enabled:true}]};
  written=await req(f,'/test-api/prebid-settings',cookie,{expectedRevision:pb.revision,acknowledge:true,draft});
  assert.equal(written.r.status,200,JSON.stringify(written.data));
  const demandState=await state(f,cookie);demandState.draft.units.at(-1).overlay.demand='site';
  written=await save(f,cookie,demandState);assert.equal(written.r.status,200,JSON.stringify(written.data));
  s.draft.units.at(-1).overlay.demand='site';
  const g=await generate(f,cookie);assert.equal(g.r.status,200,JSON.stringify(g.data));
  assert.equal(generatedLiteral(g.data.adsJs,'TESSERA_OVERLAY').code,'Overlay');
  assert.equal(generatedLiteral(g.data.adsJs,'BIDDER_ADUNIT_PARAMS').adform.Overlay.mid,456);
  const release=await req(f,'/test-api/save',cookie,{receipt:g.data.receipt,acknowledge:true,note:'TakeOver position with Prebid'});
  assert.equal(release.r.status,200,JSON.stringify(release.data));
  const response=await req(f,'/test-api/releases/'+release.data.draft.id+'/download',cookie);
  const zip=unzipSync(new Uint8Array(await response.r.arrayBuffer()));
  assert.deepEqual(zip['prebid.js'],bytes);
  const config=JSON.parse(new TextDecoder().decode(zip['config.json']));
  assert.equal(config.adPosition.demand,'site');assert.equal(config.lazyRules.Billboard.enabled,false);
  const selection=(await req(f,'/test-api/runtime-selection',cookie)).data;
  assert.equal(selection.runtimes.length,2);
  const downgrade=await req(f,'/test-api/runtime-selection',cookie,{expectedRevision:selection.revision,selection:{runtime:selection.runtimes[1].pin,allowPreview:true,enablePrebid:true,prebidBuildId:file.file.id}});
  assert.equal(downgrade.r.status,422);
  assert.deepEqual((await state(f,cookie)).draft.units.at(-1),s.draft.units.at(-1));
});
test('invalid saved runtime pin keeps the Prebid editor readable without resetting it',async()=>{
  const {f,cookie}=await ready({prebidFiles:true});
  const row=f.sqlite.prepare('SELECT config_json FROM publisher_configs').get();
  const config=JSON.parse(row.config_json);config.builtinRuntimeSelection.runtime.runtimeSha256='f'.repeat(64);
  const before=JSON.stringify(config);f.sqlite.prepare('UPDATE publisher_configs SET config_json=?').run(before);
  const result=await req(f,'/test-api/prebid-settings',cookie);
  assert.equal(result.r.status,200,JSON.stringify(result.data));assert(result.data.validationIssue);
  assert.deepEqual(result.data.requiredModules,[]);assert.equal(result.data.draft.enablePrebid,false);
  const status=await req(f,'/test-api/status',cookie);
  assert.equal(status.r.status,200,JSON.stringify(status.data));assert.equal(status.data.ready,true);
  assert.equal(status.data.runtime,null);assert.match(status.data.validationIssue,/Script version/);
  assert.equal((await req(f,'/test-api/releases',cookie)).r.status,200);
  assert.equal((await req(f,'/test-api/runtime-selection',cookie)).r.status,200);
  assert.equal(f.sqlite.prepare('SELECT config_json FROM publisher_configs').get().config_json,before);
  assert.equal((await generate(f,cookie)).r.status,409);
});

test('TEST editor rejects disabling a TakeOver position before saving its draft',async()=>{
 const {f,cookie}=await ready();let s=await state(f,cookie);
 s.draft.maps.push({name:'modal',breakpoints:[{minWidth:0,sizes:[[300,250]]}]});
 s.draft.units.push({code:'Overlay',type:'ATF',sizeMap:'modal',enabled:true,display:'takeover',overlay:defaultOverlay()});
 let response=await save(f,cookie,s);assert.equal(response.r.status,200,JSON.stringify(response.data));
 s=await state(f,cookie);const before=structuredClone(s),audits=f.sqlite.prepare('SELECT count(*) n FROM audit_log').get().n;
 s.draft.units.find(u=>u.code==='Overlay').enabled=false;
 response=await save(f,cookie,s);assert.equal(response.r.status,422);assert.match(response.data.error,/Enable the TakeOver ad position/);
 assert.deepEqual(await state(f,cookie),before);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM audit_log').get().n,audits);
 delete s.draft.units.find(u=>u.code==='Overlay').overlay;s.draft.units.find(u=>u.code==='Overlay').display='standard';
 response=await save(f,cookie,s);assert.equal(response.r.status,200,JSON.stringify(response.data));
 assert.equal((await state(f,cookie)).draft.units.find(u=>u.code==='Overlay').enabled,false);
});
