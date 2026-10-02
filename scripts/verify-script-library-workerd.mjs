import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {readFile,mkdir,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Miniflare} from 'miniflare';
import {unzipSync} from 'fflate';
import {buildSavedScript,buildSavedTest} from './saved-script-package.mjs';
import {seedScriptLibrary} from './script-library-test-db.mjs';
import {sha256} from './static-aa-package.mjs';

const directory=await mkdtemp(join(tmpdir(),'script-library-'));
const origin='https://app.invalid',password=randomBytes(20).toString('hex');
const script=await readFile('dist/prebid_professor/index.js','utf8');
let outbound=0,mf;const checks=[];
const check=(name,ok)=>{assert(ok,name);checks.push(name);};
try {
  mf=new Miniflare({modules:true,script,compatibilityDate:'2026-07-15',compatibilityFlags:['nodejs_compat'],cf:false,
    resourcePersistencePath:directory,d1Databases:{DB:'ab-editor-d1'},r2Buckets:{BUILDS:'ab-editor-r2'},
    bindings:{ADMIN_EMAIL:'tester@example.invalid',ADMIN_PASSWORD:password,SESSION_SECRET:randomBytes(40).toString('hex')},
    serviceBindings:{ASSETS:()=>new Response('fixture asset',{status:404})},
    outboundService:()=>{outbound++;return new Response('External traffic blocked',{status:503});}});
  await mf.ready;
  const db=await mf.getD1Database('DB');
  await seedScriptLibrary(db);
  const path='/api/publishers/tanjug/script-library';
  check('Unauthenticated settings are rejected',(await mf.dispatchFetch(origin+path)).status===401);
  const login=await mf.dispatchFetch(origin+'/api/auth/login',{method:'POST',headers:{origin,'content-type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({email:'tester@example.invalid',password}),redirect:'manual'});
  assert(login.headers.get('set-cookie'),'Fixture login failed.');const cookie=login.headers.get('set-cookie').split(';')[0];
  const call=(suffix='',body,extra={})=>mf.dispatchFetch(origin+path+suffix,{method:body?'POST':'GET',headers:{cookie,...(body?{origin,'content-type':'application/json'}:{}),...extra},body:body?JSON.stringify(body):undefined});
  let state=await(await call()).json();check('Reviewed baseline is available',state.supported&&state.baseline.positions===19);
  const demand=(body,headers={cookie,origin})=>mf.dispatchFetch(origin+'/api/publishers/tanjug/prebid-mode',{method:body?'PUT':'GET',headers:{...headers,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});
  const initialDemand=await(await demand()).json();
  check('Demand defaults to fresh auctions without altering config',initialDemand.prebidMode.bidCache.enabled===false&&initialDemand.bidCacheAvailable===true);
  const saveDemand=async enabled=>{
    const current=await(await demand()).json();
    const response=await demand({enabled:true,revision:current.revision,bidCache:{enabled,maxBidAgeSeconds:60}});
    assert.equal(response.status,200,await response.clone().text());
    const saved=await response.json();assert.equal(saved.prebidMode.bidCache.enabled,enabled);
    return saved;
  };
  check('Cross-origin Demand save is rejected',(await demand({enabled:true,revision:initialDemand.revision,bidCache:{enabled:true,maxBidAgeSeconds:60}},{cookie,origin:'https://other.invalid'})).status===403);
  check('Invalid cache age is rejected',(await demand({enabled:true,revision:initialDemand.revision,bidCache:{enabled:true,maxBidAgeSeconds:0}})).status===422);
  const inputs={base:await readFile('.generated/tanjug-pilot/ads.js'),previousArchive:await readFile('.generated/tanjug-cmp/tanjug-aa-1.0.2.zip')};
  const scripts={};const savedScripts={};
  const output='.generated/script-library-delivered/';await mkdir(output,{recursive:true});
  async function materialize(kind,id,label,expected){
    const response=await call('/'+kind+'/'+id+'.zip');const bytes=new Uint8Array(await response.arrayBuffer());
    assert.equal(response.status,200,Buffer.from(bytes).toString().slice(0,1000));
    check(label+': exact offline ZIP from compiled Worker',response.status===200&&sha256(bytes)===expected.archiveSha256);
    for(const [name,data] of Object.entries(unzipSync(bytes))){const target=output+label+'/deploy/'+name;await mkdir(target.slice(0,target.lastIndexOf('/')),{recursive:true});await writeFile(target,data);}
    await writeFile(output+label+'/release.json',JSON.stringify(expected.manifest,null,2));
  }
  for(const variant of ['A','B']){
    const settings=variant==='A'?{mode:'fresh-only',refreshSeconds:10}:{mode:'auction-with-cache',refreshSeconds:10,maxBidAgeSeconds:60};
    await saveDemand(variant==='B');state=await(await call()).json();
    const body={revision:state.revision,name:variant==='A'?'Standard 10s':'Cache 60s',refreshSeconds:10};
    if(variant==='A')check('Cross-origin writes rejected',(await call('/scripts',body,{origin:'https://other.invalid'})).status===403);
    const response=await call('/scripts',body),data=await response.json();assert.equal(response.status,201,JSON.stringify(data));
    const expected=scripts[variant]=await buildSavedScript({...inputs,...body,settings});savedScripts[variant]=data.item;
    check('Correct named script '+variant,data.item.id===expected.id&&data.item.name===body.name);
    await materialize('scripts',data.item.id,variant==='A'?'fresh':'cache',expected);
    const retry=await call('/scripts',body);check('Idempotent save '+variant,retry.status===200&&(await retry.json()).item.id===expected.id);
  }
  for(const [label,pair] of [['ab',scripts],['aa',{A:scripts.B,B:scripts.B}]]){
    const body={revision:state.revision,name:label==='ab'?'Standard vs Cache':'Cache A/A',scriptA:pair.A.id,scriptB:pair.B.id,trafficBPercent:50};
    const response=await call('/tests',body),data=await response.json();assert.equal(response.status,201,JSON.stringify(data));
    const expected=await buildSavedTest({...inputs,...body,scripts:pair});
    check('Saved references '+label,data.item.scripts.A.id===pair.A.id&&data.item.scripts.B.id===pair.B.id);
    await materialize('tests',data.item.id,label,expected);
  }
  check('Stale Demand form cannot overwrite newer settings',(await demand({enabled:true,revision:initialDemand.revision,bidCache:{enabled:false,maxBidAgeSeconds:60}})).status===409);
  const currentDemand=await(await demand()).json();
  const config=JSON.parse((await db.prepare("SELECT config_json FROM publisher_configs WHERE publisher_id='tanjug'").first()).config_json);
  check('Saving cache preserves currency and consent',config.currency==='EUR'&&config.consent.cmpApi==='iab');
  check('Generation rejects a caller-supplied cache override',(await call('/scripts',{revision:state.revision,name:'Override',refreshSeconds:10,settings:{mode:'fresh-only',refreshSeconds:10}})).status===422);
  const oldGenerator=await mf.dispatchFetch(origin+'/api/publishers/tanjug/releases/generate',{method:'POST',headers:{cookie,origin,'content-type':'application/json'},body:'{}'});
  check('Older generator cannot silently ignore saved cache settings',oldGenerator.status===409&&(await oldGenerator.json()).error.includes('Bid caching'));
  const oldBundle=await mf.dispatchFetch(origin+'/api/publishers/tanjug/builtin-runtime-bundle',{method:'POST',headers:{cookie,origin,'content-type':'application/json'},body:'{}'});
  check('Older bundle endpoint cannot ignore saved cache settings',oldBundle.status===409&&(await oldBundle.json()).error.includes('Bid caching'));
  const off=await demand({enabled:false,revision:currentDemand.revision,bidCache:currentDemand.prebidMode.bidCache});
  check('Turning Prebid off keeps the saved cache choice',off.status===200&&(await off.json()).prebidMode.bidCache.enabled===true);
  state=await(await call()).json();
  check('Prebid off blocks new named Prebid scripts',(await call('/scripts',{revision:state.revision,name:'Off',refreshSeconds:10})).status===409);
  check('Saved scripts remain downloadable after Demand changes',(await call('/scripts/'+savedScripts.B.id+'.zip')).status===200);
  await saveDemand(true);
  const history=await(await call()).json();check('Named script and test history',history.scripts.length===2&&history.tests.length===2);
  const recordKeys=(await (await mf.getR2Bucket('BUILDS')).list({prefix:'site-script-library/'})).objects;
  check('Only immutable script/test objects created',recordKeys.length===8);
  const item=savedScripts.B,suffix='/scripts/'+item.id+'.zip',confirmation={confirmId:item.id,sha256:item.sha256};
  const mutate=(method,body=confirmation,headers={cookie,origin})=>mf.dispatchFetch(origin+path+suffix,{method,headers:{...headers,'content-type':'application/json'},body:JSON.stringify(body)});
  check('Unauthenticated deletion is rejected',(await mutate('DELETE',confirmation,{origin})).status===401);
  check('Cross-origin deletion is rejected',(await mutate('DELETE',confirmation,{cookie,origin:'https://other.invalid'})).status===403);
  check('Deletion without origin is rejected',(await mutate('DELETE',confirmation,{cookie})).status===403);
  check('Deletion requires the displayed exact version',(await mutate('DELETE',{...confirmation,confirmId:savedScripts.A.id})).status===422);
  check('Confirmed deletion succeeds',(await mutate('DELETE')).status===200);
  const deleted=await(await call()).json();check('Deleted version is hidden and recoverable',deleted.scripts.length===1&&deleted.deletedScripts[0].id===item.id&&deleted.tests.length===2);
  check('Deleted ZIP cannot be selected or downloaded',(await call(suffix)).status===410);
  check('Cross-origin restore is rejected',(await mutate('PUT',confirmation,{cookie,origin:'https://other.invalid'})).status===403);
  check('Restore succeeds',(await mutate('PUT')).status===200);
  check('Restored ZIP retains original hash',sha256(new Uint8Array(await(await call(suffix)).arrayBuffer()))===item.sha256);
  // Existing permanent-delete routes must retain active-version guards and require confirmation.
  await db.exec("ALTER TABLE publishers ADD COLUMN current_release_id TEXT; ALTER TABLE publishers ADD COLUMN current_version TEXT; CREATE TABLE releases(id TEXT PRIMARY KEY,publisher_id TEXT,version TEXT,status TEXT); INSERT INTO releases VALUES('active-release','tanjug','active','production'),('draft-release','tanjug','draft','draft'); INSERT INTO prebid_builds VALUES('current-build','tanjug','11','fixture-current.js',NULL,'[]','current','fixture','2026-09-20'),('old-build','tanjug','10','fixture-old.js',NULL,'[]','archived','fixture','2026-09-20');");
  const deletion=(resource,id,confirm)=>mf.dispatchFetch(origin+'/api/publishers/tanjug/'+resource+'/'+id,{method:'DELETE',headers:{cookie,origin,...(confirm?{'x-confirm-delete':id}:{})}});
  check('Active release remains protected',(await deletion('releases','active-release',true)).status===409);
  check('Draft release needs explicit confirmation',(await deletion('releases','draft-release',false)).status===422);
  check('Current Prebid remains protected',(await deletion('prebid-builds','current-build',true)).status===409);
  check('Archived Prebid needs explicit confirmation',(await deletion('prebid-builds','old-build',false)).status===422);
  // Per-position settings go through the real authenticated API and compiled generator.
  for(const positionOverrides of [{Unknown:true},{Sticky:'false'},null,[]]) {
    const current=await(await demand()).json();
    check('Reject invalid position map '+JSON.stringify(positionOverrides),(await demand({enabled:true,revision:current.revision,bidCache:{enabled:false,maxBidAgeSeconds:60,positionOverrides}})).status===422);
  }
  for(const [label,enabled,positionOverrides] of [
    ['positions',true,{Billboard:false,Sticky:true}],
    ['positions-default-off',false,{Billboard:false,Sticky:true}],
  ]) {
    const current=await(await demand()).json();
    const response=await demand({enabled:true,revision:current.revision,bidCache:{enabled,maxBidAgeSeconds:60,positionOverrides}});
    assert.equal(response.status,200,await response.clone().text());
    const roundtrip=await(await demand()).json();
    check(label+': saved overrides round-trip',roundtrip.prebidMode.bidCache.enabled===enabled&&roundtrip.prebidMode.bidCache.positionOverrides.Billboard===false&&roundtrip.prebidMode.bidCache.positionOverrides.Sticky===true);
    check(label+': supported positions are returned',roundtrip.bidCachePositions.includes('Billboard')&&roundtrip.bidCachePositions.includes('Sticky'));
    const state=await(await call()).json(),body={revision:state.revision,name:label,refreshSeconds:2};
    const created=await call('/scripts',body),data=await created.json();assert.equal(created.status,201,JSON.stringify(data));
    const expected=await buildSavedScript({...inputs,...body,settings:{mode:enabled?'auction-with-cache':'fresh-only',refreshSeconds:2,maxBidAgeSeconds:60,positionOverrides}});
    check(label+': versioned position runtime',data.item.id===expected.id&&expected.manifest.kind==='saved-script-v2');
    await materialize('scripts',data.item.id,label,expected);
  }
  check('Old downloaded cache version remains byte-identical after position changes',sha256(new Uint8Array(await(await call(suffix)).arrayBuffer()))===item.sha256);
  check('Generation made no external network request',outbound===0);
  await writeFile(output+'workerd-report.json',JSON.stringify({scope:'Compiled production Worker, ephemeral D1/R2 and synthetic identity only',checks,passed:checks.length,failed:0},null,2));
  console.log(JSON.stringify({passed:checks.length,failed:0}));
}finally{if(mf)await mf.dispose();await rm(directory,{recursive:true,force:true});}
