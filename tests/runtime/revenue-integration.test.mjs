import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {runtimeCatalog,previewInput,buildArtifactCandidate} from '../../worker/test-workspace/runtime-catalog.mjs';
import {pinRuntime} from '../../worker/runtime/version-pin.mjs';
import {sha256,prebidRequirements,inspectPrebidArtifact,parsePrebidHeader} from '../../worker/runtime/prebid-artifact-check.mjs';
import {positionFixture} from '../support/position-runtime-fixture.mjs';
import {dealsRuntimeFixture} from '../support/deals-runtime-fixture.mjs';
import {workspaceStore,TEST_EMAIL,TEST_PASSWORD,TEST_SECRET} from '../support/test-workspace-store.mjs';
const descriptor=runtimeCatalog.find(r=>r.id==='tessera-revenue-preview-1');
const stamp='20261011_140000';
test('explicit selection preserves the old default and refuses discarded active settings',()=>{
  assert.equal(runtimeCatalog[0].id,'tessera-positions-preview-1');
  const snapshot=dealsRuntimeFixture();
  for(const old of runtimeCatalog.filter(r=>!['tessera-revenue-preview-1','tessera-revenue-preview-2','tessera-revenue-preview-3','tessera-3.16.0','tessera-3.16.1'].includes(r.id)))assert.throws(()=>previewInput(snapshot,old,stamp),/Active Deals or Outstream/);
  const next=previewInput(snapshot,descriptor,stamp);
  assert.equal(next.deals.entries[0].dealId,'0000199');
  assert.deepEqual(next.outstream.disabledRefreshCodes,[]);
});
test('verified native bytes create a pinned new package; stale/mismatched bytes fail',async()=>{
  const snapshot=positionFixture(true),config=JSON.parse(snapshot.config.config_json);
  delete config.runtimeControls.adPositions;snapshot.units=snapshot.units.filter(u=>u.code!=='Overlay');snapshot.overrides=[];
  snapshot.config.config_json=JSON.stringify(config);
  const source=await readFile('vendor/prebid/tanjug-11.34.0/prebid.js');
  const bytes=source.buffer.slice(source.byteOffset,source.byteOffset+source.byteLength);
  const header=parsePrebidHeader(source.toString().slice(0,65536));
  const requirements=prebidRequirements(previewInput(snapshot,descriptor,stamp),config);
  const row={id:'native-fixture',publisher_id:'test-site',status:'current',version:header.version,file_key:'publishers/test-site/prebid-builds/native-fixture/prebid.js',modules_json:JSON.stringify(header.modules)};
  const report=await inspectPrebidArtifact({siteId:'test-site',builds:[row],requirements},{get:async()=>({size:bytes.byteLength,customMetadata:{sha256:await sha256(bytes)},arrayBuffer:async()=>bytes})});
  assert.equal(report.status,'checked');
  const args={snapshot,pin:pinRuntime(descriptor,{allowPreview:true}),buildTimestamp:stamp,prebid:{report,bytes}};
  const result=await buildArtifactCandidate(args);
  assert.equal(result.manifest.runtime.runtimeVersion,'3.16.0-revenue.preview.1');
  assert.deepEqual(result.files['prebid.js'],new Uint8Array(bytes));
  for(const [name,entry] of Object.entries(result.manifest.files))assert.equal(await sha256(result.files[name]),entry.sha256);
  await assert.rejects(buildArtifactCandidate({...args,prebid:{report,bytes:bytes.slice(0,-1)}}),/changed after verification/);
});
test('GAM-only retains saved intent but produces no Prebid asset or deal plan entries',async()=>{
  const result=await buildArtifactCandidate({snapshot:dealsRuntimeFixture(false),pin:pinRuntime(descriptor,{allowPreview:true}),buildTimestamp:stamp});
  assert.equal(result.files['prebid.js'],undefined);
  const config=JSON.parse(new TextDecoder().decode(result.files['config.json']));
  assert.equal(config.deals,null);assert.deepEqual(config.outstream.units,{});
  assert.deepEqual(JSON.parse(new TextDecoder().decode(result.files['deals-plan.json'])).entries,[]);
});

const compiled=await build({entryPoints:['worker/app-builtin-runtime-preview.ts'],bundle:true,write:false,platform:'node',format:'esm'});
const {default:app}=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));
async function store(){
  const f=workspaceStore();
  f.sqlite.exec((await readFile('migrations/0001_initial.sql','utf8')).split('INSERT OR IGNORE INTO publishers')[0]);
  f.sqlite.prepare("INSERT INTO publishers(id,name,domain,gam_path) VALUES('first','First','first.invalid','/123/first/')").run();
  f.sqlite.prepare("INSERT INTO publisher_configs(id,publisher_id,config_json) VALUES('cfg','first',?)").run(JSON.stringify({enablePrebid:true,runtimeControls:{sticky:{bottomAdUnitId:''}}}));
  f.sqlite.prepare("INSERT INTO ad_units(id,publisher_id,code,type,size_map_key) VALUES('unit','first','Billboard','ATF','display')").run();
  f.sqlite.prepare("INSERT INTO bidders(id,publisher_id,bidder,params_json,enabled) VALUES('bidder','first','pubmatic','{}',1)").run();
  Object.assign(f.env,{ADMIN_EMAIL:TEST_EMAIL,ADMIN_PASSWORD:TEST_PASSWORD,SESSION_SECRET:TEST_SECRET});
  const login=await app.fetch(new Request('https://tessera.invalid/api/auth/login',{method:'POST',headers:{origin:'https://tessera.invalid','content-type':'application/json'},body:JSON.stringify({email:TEST_EMAIL,password:TEST_PASSWORD})}),f.env,{});
  assert.equal(login.status,303);
  return {...f,cookie:login.headers.get('set-cookie').split(';')[0]};
}
test('actual routes authenticate, check Origin and save/reopen with stale revision rejected',async()=>{
  const f=await store();
  try {
    for(const endpoint of ['deals','outstream-settings']) {
      const url='https://tessera.invalid/api/publishers/first/'+endpoint;
      const send=(options={})=>app.fetch(new Request(url,options),f.env,{});
      assert.equal((await send()).status,401);
      assert.equal((await send({method:'POST',headers:{cookie:f.cookie,origin:'https://foreign.invalid','content-type':'application/json'},body:'{}'})).status,403);
      const before=await(await send({headers:{cookie:f.cookie}})).json();
      const body=endpoint==='deals'?{revision:before.revision,settings:{schemaVersion:1,entries:[]}}:{revision:before.revision,outstream:{schemaVersion:1,units:{Billboard:{format:'banner'}}}};
      const headers={cookie:f.cookie,origin:'https://tessera.invalid','content-type':'application/json'};
      const response=await send({method:'POST',headers,body:JSON.stringify(body)});
      assert.equal(response.status,200,await response.clone().text());
      const reopened=await(await send({headers:{cookie:f.cookie}})).json();
      assert.notEqual(reopened.revision,before.revision);
      assert.equal((await send({method:'POST',headers,body:JSON.stringify(body)})).status,409);
      assert.equal((await app.fetch(new Request(url.replace('/first/','/missing/'),{headers:{cookie:f.cookie}}),f.env,{})).status,404);
    }
    assert.equal(f.log.puts.length,0);
  }finally{f.close();}
});
test('position edits retain scoped settings until explicitly cleared; Banner permits rename',async()=>{
  const f=await store();
  try {
    const url='https://tessera.invalid/api/publishers/first/ad-units/unit';
    const headers={cookie:f.cookie,origin:'https://tessera.invalid','content-type':'application/json'};
    const configure=runtimeControls=>f.sqlite.prepare('UPDATE publisher_configs SET config_json=?').run(JSON.stringify({enablePrebid:true,runtimeControls}));
    for(const settings of [{deals:{schemaVersion:1,entries:[{positions:['Billboard']}]}},{outstream:{schemaVersion:1,units:{Billboard:{format:'banner-outstream'}}}}]){
      configure(settings);
      assert.equal((await app.fetch(new Request(url,{method:'PATCH',headers,body:JSON.stringify({code:'Renamed'})}),f.env,{})).status,409);
      assert.equal((await app.fetch(new Request(url,{method:'DELETE',headers}),f.env,{})).status,409);
      assert.equal(f.sqlite.prepare('SELECT code FROM ad_units WHERE id=?').get('unit').code,'Billboard');
    }
    configure({outstream:{schemaVersion:1,units:{Billboard:{format:'banner'}}}});
    assert.equal((await app.fetch(new Request(url,{method:'PATCH',headers,body:JSON.stringify({code:'Renamed'})}),f.env,{})).status,200);
    const {buildOutstreamInput}=await import('../../shared/outstream/settings.mjs');
    const {readPreviewSnapshot}=await import('../../worker/runtime/builtin-preview-service.mjs');
    assert.deepEqual(buildOutstreamInput(await readPreviewSnapshot(f.env.DB,'first')),{units:{},disabledRefreshCodes:[],cacheUrl:null});
  }finally{f.close();}
});
