import test from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync } from 'fflate';
import worker from '../../worker/test-workspace/index.mjs';
import { workspaceStore, ORIGIN, TEST_EMAIL, TEST_PASSWORD } from '../support/test-workspace-store.mjs';
import { packageTestModel, renderPackageTestPage, packageTestPageResponse, testPageHeaders } from '../../worker/site-runtime/test-page.mjs';
import { testPageClient } from '../../worker/site-runtime/test-page-client.mjs';
const fixtures = [];
test.afterEach(() => { while(fixtures.length) fixtures.pop().close(); });
const text = new TextEncoder();
function input(prebid=false) {
  return {'config.json':text.encode(JSON.stringify({siteId:'site-a',runtime:{runtimeVersion:'3.10.0'},core:{gamPath:'/123/site-a/',explicitUnits:[
    {id:'Billboard_1',type:'ATF',sizes:[[970,250]],sizeMapName:'Billboard'},
    {id:'InText_1',type:'BTF',sizes:['fluid',[300,250]],sizeMapName:'Text'},
    {id:'Sticky',type:'ATF',sizeMapName:'Sticky'},
    {id:'TakeOver',type:'ATF',sizeMapName:'Overlay'},
  ],sizeMapsRaw:{Billboard:[{viewport:[0,0],sizes:[]},{viewport:[1300,0],sizes:[[970,250]]}],Text:[{viewport:[0,0],sizes:['fluid',[300,250]]}],Sticky:[{viewport:[0,0],sizes:[[320,50]]}]}},options:{sticky:{bottomAdUnitId:'Sticky'}},adPosition:{code:'TakeOver'},prebidBuild:prebid?{version:'11.34.0'}:null})),
  'ads.min.js':text.encode('window.example="</script>";/* exact bytes */'),'min-height.css':text.encode('#Billboard_1{min-height:250px}'),...(prebid?{'prebid.js':text.encode('/* Original Prebid */ window.fixturePrebid=true;')}:{}),};
}
test('saved configuration supplies all standard/sticky DIVs and excludes the runtime-created modal',() => {
  const model=packageTestModel(input(),'site-a','saved-one');
  assert.deepEqual(model.units.map(u=>u.id),['Billboard_1','InText_1','Sticky']);assert.equal(model.overlay,'TakeOver');
  assert.equal(model.units[2].sticky,true);assert.equal(model.prebidVersion,null);assert.equal(model.assets.prebid,null);
  assert.deepEqual(model.maps.Billboard[0].sizes,[]);assert.equal(model.units[1].sizes[0],'fluid');
  const html=renderPackageTestPage(model);assert.match(html,/id="InText_1" class="wrapperAd lazyAd"/);assert.match(html,/id="Sticky" class="wrapperAd"/);
  assert.doesNotMatch(html,/id="TakeOver"/);assert.equal(Buffer.from(model.assets.ads,'base64').toString(),new TextDecoder().decode(input()['ads.min.js']));
});
test('original Prebid bytes are included only when the archived package requires them',() => {
  const files=input(true),model=packageTestModel(files,'site-a','saved-one');
  assert.equal(model.prebidVersion,'11.34.0');assert.deepEqual(Buffer.from(model.assets.prebid,'base64'),Buffer.from(files['prebid.js']));
  delete files['prebid.js'];assert.throws(()=>packageTestModel(files,'site-a','saved-one'),/dependency/);
  assert.throws(()=>packageTestModel(input(),'another-site','saved-one'),/match this site/);
});
test('lazy labels honor saved ATF/BTF and per-position overrides',() => {
  const files=input(),config=JSON.parse(new TextDecoder().decode(files['config.json']));
  config.lazyRules={__DEFAULT__:{enabled:true,fetchMarginPx:500,renderMarginPx:0},InText_1:{enabled:false}};
  files['config.json']=text.encode(JSON.stringify(config));
  const model=packageTestModel(files,'site-a','saved-one');
  assert.equal(model.units[0].lazy.enabled,true);assert.equal(model.units[1].lazy.enabled,false);
  assert.equal(model.units[1].lazy.fetchMarginPx,500);
});
test('archive text cannot close HTML data/scripts and the page has no admin API client',() => {
  const model=packageTestModel(input(),'site-a','saved-one');model.runtimeVersion='</script><script>alert(1)</script>';model.adUnitPath='/123/</p><script>alert(2)</script>/';
  const html=renderPackageTestPage(model);
  assert.equal((html.match(/<script\b/g)||[]).length,2);assert.equal((html.match(/<\/script>/g)||[]).length,2);
  assert.doesNotMatch(html,/<script>alert/);assert.match(html,/\\u003c\/script>/);
  assert.match(testPageHeaders['content-security-policy'],/^sandbox allow-scripts allow-popups;/);
  assert.doesNotMatch(testPageHeaders['content-security-policy'],/allow-same-origin|allow-top-navigation|allow-popups-to-escape-sandbox/);
  assert.equal(testPageHeaders['cache-control'],'private, no-store');assert.equal(testPageHeaders['referrer-policy'],'no-referrer');
  assert.doesNotMatch(testPageClient.toString(),/fetch\(|\/api\/|__tcfapi\s*=/);
  new Function('return ('+testPageClient.toString()+')');
});
function req(path,cookie,body) { return new Request(ORIGIN+path,{method:body?'POST':'GET',headers:{...(cookie?{cookie}:{}),...(body?{origin:ORIGIN,'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined}); }
async function stored() {
  const f=workspaceStore();fixtures.push(f);
  const login=await worker.fetch(new Request(ORIGIN+'/api/auth/login',{method:'POST',headers:{origin:ORIGIN,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({email:TEST_EMAIL,password:TEST_PASSWORD})}),f.env);
  const cookie=login.headers.get('set-cookie').split(';')[0];
  const setup=await worker.fetch(req('/test-api/setup',cookie,{confirm:'prepare-empty-test-database'}),f.env);assert.equal(setup.status,200);
  const generated=await (await worker.fetch(req('/test-api/generate',cookie,{acknowledge:true,takeOverEnabled:false}),f.env)).json();
  const saved=await (await worker.fetch(req('/test-api/save',cookie,{receipt:generated.receipt,acknowledge:true,note:'Test page package'}),f.env)).json();
  assert(saved.draft?.id,JSON.stringify(saved));return {f,cookie,id:saved.draft.id};
}
test('authenticated TEST page reads exact archived bytes without modifying settings, channels or R2',async()=>{
  const {f,cookie,id}=await stored(),path='/test-api/site-test-page/'+id;
  const original=unzipSync(new Uint8Array(await (await worker.fetch(req('/test-api/releases/'+id+'/download',cookie),f.env)).arrayBuffer()));
  // The current editor can diverge or become invalid; this test still opens the archived release.
  f.sqlite.prepare("UPDATE publisher_configs SET config_json='{}'").run();
  const puts=f.log.puts.length,batches=f.log.batches;
  const response=await worker.fetch(req(path+'?google_force_console=1',cookie),f.env);assert.equal(response.status,200,await response.clone().text());
  assert.equal(response.headers.get('content-security-policy'),testPageHeaders['content-security-policy']);
  const html=await response.text(),data=JSON.parse(html.match(/data-test-model>(.*?)<\/script>/s)[1]);
  assert.deepEqual(Buffer.from(data.assets.ads,'base64'),Buffer.from(original['ads.min.js']));
  assert.equal(data.units[0].id,JSON.parse(new TextDecoder().decode(original['config.json'])).core.explicitUnits[0].id);
  assert.equal(f.log.puts.length,puts);assert.equal(f.log.batches,batches);assert.equal(f.sqlite.prepare('SELECT status FROM releases').get().status,'draft');
  assert.equal((await worker.fetch(req(path),f.env)).status,401);
  assert.equal((await worker.fetch(req(path+'?source=https://example.invalid',cookie),f.env)).status,400);
  assert.equal((await worker.fetch(req(path+'?googfc=1&googfc=1',cookie),f.env)).status,400);
  assert.equal((await worker.fetch(req(path,cookie,{action:'run'}),f.env)).status,405);
  const foreign=new Request(ORIGIN+path,{method:'POST',headers:{cookie,origin:'null','content-type':'application/json'},body:'{}'});
  assert.equal((await worker.fetch(foreign,f.env)).status,403);
  assert.equal((await packageTestPageResponse(req(path),f.env,'foreign-site',id,{testOnly:true})).status,404);
});
test('damaged saved script is rejected instead of executing or falling back to current config',async()=>{
  const {f,cookie,id}=await stored();const key=[...f.objects.keys()].find(k=>k.includes(id)&&k.endsWith('/ads.min.js'));assert(key);
  f.objects.set(key,text.encode('corrupt').buffer);
  const response=await worker.fetch(req('/test-api/site-test-page/'+id,cookie),f.env);assert.notEqual(response.status,200);assert.match(response.headers.get('content-type'),/json/);
});
