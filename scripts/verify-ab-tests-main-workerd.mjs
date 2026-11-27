/** Compiled MAIN A/B contract. Ephemeral workerd/D1/R2, synthetic sites and the
 * checked-in Prebid bytes only. No generated ad script is executed or published. */
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {unzipSync} from 'fflate';
import {Miniflare} from './local-miniflare.mjs';
import {composeAbBundle} from '../worker/experiments/ab-bundle.mjs';
import {ORIGINAL_SOURCES,originalId} from '../worker/experiments/original-source-catalog.mjs';
import {guardedModules,guardCalls,describeCalls} from './canonical-text-guard.mjs';

const origin='https://main-ab-workerd.invalid',site='workerd-ab-alpha',other='workerd-ab-beta';
const actor='tester@example.invalid',password=randomBytes(24).toString('hex'),secret=randomBytes(40).toString('hex');
const output='.generated/ab-tests-main-workerd',directory=await mkdtemp(join(tmpdir(),'main-ab-workerd-'));
const script=await readFile('dist/prebid_professor/index.js','utf8');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const prebid=new Uint8Array(await readFile('vendor/prebid/tanjug-11.34.0/prebid.js'));
const prebidConfig=JSON.parse(await readFile('vendor/prebid/tanjug-11.34.0/prebid-config.json','utf8'));
assert.equal(hash(prebid),'384daae36c4fb334e16229d7f3e4b7a2c2caf9c0344580bdca7b185c756bb10b');
await mkdir(output,{recursive:true});
const checks=[];
const check=(name,ok)=>{assert(ok,name);checks.push(name);};
let mf,db,bucket,cookie='',outbound=0,expected,record,measurementPlan;
const options={modules:guardedModules(script),compatibilityDate:'2026-07-15',compatibilityFlags:['nodejs_compat'],cf:false,
  resourcePersistencePath:directory,d1Databases:{DB:'main-ab-d1'},r2Buckets:{BUILDS:'main-ab-r2'},
  bindings:{ADMIN_EMAIL:actor,ADMIN_PASSWORD:password,SESSION_SECRET:secret},
  serviceBindings:{ASSETS:()=>new Response('No remote fixture assets',{status:404})},
  outboundService:()=>{outbound++;return new Response('External requests are blocked',{status:503});}};
async function start(){mf=new Miniflare(options);await mf.ready;db=await mf.getD1Database('DB');bucket=await mf.getR2Bucket('BUILDS');}
const base=id=>`/api/publishers/${id}/ab-tests`;
async function request(path,{method='GET',body,auth=true,origin:source=origin,headers={}}={}){
  return mf.dispatchFetch(origin+path,{method,headers:{...(auth&&cookie?{cookie}:{}),...(source?{origin:source}:{}),
    ...(body!==undefined?{'content-type':'application/json'}:{}),...headers},
    ...(body!==undefined?{body:typeof body==='string'?body:JSON.stringify(body)}:{})});
}
async function json(path,options,status=200){
  const response=await request(path,options),text=await response.text();
  assert.equal(response.status,status,`${path}: ${text.slice(0,1000)}`);
  return JSON.parse(text);
}
async function schema(){
  // Omit the real publisher seed rows. Apply only the existing additive schemas this flow uses.
  for(const source of [
    (await readFile('migrations/0001_initial.sql','utf8')).split('INSERT OR IGNORE INTO publishers')[0],
    await readFile('migrations/0003_external_deployments.sql','utf8'),
    await readFile('migrations/0007_bidder_accounts.sql','utf8'),
  ])await db.exec(source.replace(/--[^\n]*/g,'').replace(/\n/g,' '));
}
async function addSite(id){
  const config={enablePrebid:true,currency:'EUR',consent:{cmpApi:'iab'},prebidBidCache:{enabled:false,maxBidAgeSeconds:60},
    runtimeControls:{sticky:{bottomAdUnitId:''},floors:{enabled:false},currencyConversion:{enabled:false},output:{cleanComments:true}}};
  await db.batch([
    db.prepare('INSERT INTO publishers(id,name,domain,gam_path) VALUES(?,?,?,?)').bind(id,'Synthetic '+id,id+'.example.invalid','/999/'+id+'/'),
    db.prepare('INSERT INTO publisher_configs(id,publisher_id,config_json) VALUES(?,?,?)').bind(id+'-config',id,JSON.stringify(config)),
    db.prepare('INSERT INTO ad_units(id,publisher_id,code,type,size_map_key,sort_order) VALUES(?,?,?,?,?,?)').bind(id+'-unit',id,'Billboard','ATF','display',0),
    db.prepare('INSERT INTO size_maps(id,publisher_id,name,map_json) VALUES(?,?,?,?)').bind(id+'-map',id,'display',JSON.stringify([{viewport:[0,0],sizes:[[300,250]]}])),
    db.prepare('INSERT INTO unit_rules(id,publisher_id,rule_key,rule_json) VALUES(?,?,?,?)').bind(id+'-rule',id,'__DEFAULT__',JSON.stringify({timeout:800,cmpTimeout:10000,refresh:{enabled:false}})),
    db.prepare('INSERT INTO bidders(id,publisher_id,bidder,params_json,account_json) VALUES(?,?,?,?,?)').bind(id+'-bidder',id,'pubmatic','{"publisherId":"1","adSlot":"synthetic"}','{}'),
    db.prepare('INSERT INTO prebid_builds(id,publisher_id,version,file_key,modules_json,status,uploaded_at) VALUES(?,?,?,?,?,?,?)')
      .bind(id+'-prebid',id,prebidConfig.version,`publishers/${id}/prebid-builds/${id}-prebid/prebid.js`,JSON.stringify(prebidConfig.modules),'current','2026-11-20T00:00:00Z'),
  ]);
  await bucket.put(`publishers/${id}/prebid-builds/${id}-prebid/prebid.js`,prebid,{customMetadata:{sha256:hash(prebid),version:prebidConfig.version}});
  const endpoint=`/api/publishers/${id}/builtin-site-settings`,settings=await json(endpoint);
  const runtime=settings.runtimes.find(row=>row.version==='3.25.1');assert(runtime,'3.25.1 is not offered');
  await json(endpoint,{method:'POST',body:{action:'setup',revision:settings.revision,runtime:runtime.pin,allowPreview:true,enablePrebid:true}});
}
async function generate(id,name){
  const endpoint=`/api/publishers/${id}/builtin-releases`,state=await json(endpoint);
  assert.equal(state.ready,true,JSON.stringify(state));
  return (await json(endpoint,{method:'POST',body:{action:'generate',revision:state.revision,notes:name}},201)).release.id;
}
async function packageBytes(id,release){
  const endpoint=`/api/publishers/${id}/builtin-releases/${release}`;
  const index=await json(endpoint+'/index'),files={};
  assert.equal(index.descriptor.releaseId,release);assert.equal(index.descriptor.siteId,id);
  for(const entry of index.descriptor.files){
    const response=await request(endpoint+'/files/'+entry.name);assert.equal(response.status,200);
    const bytes=new Uint8Array(await response.arrayBuffer());assert.equal(bytes.length,entry.byteSize);assert.equal(hash(bytes),entry.sha256);
    files[entry.name]=bytes;
  }
  return {files,manifest:JSON.parse(new TextDecoder().decode(files['manifest.json'])),
    release:await db.prepare('SELECT * FROM releases WHERE publisher_id=? AND id=?').bind(id,release).first()};
}
async function persistent(){
  const tables=['publishers','publisher_configs','ad_units','size_maps','unit_rules','bidders','bidder_overrides','prebid_builds','releases','audit_log','deployment_targets','external_deployments'];
  return JSON.stringify(await Promise.all(tables.map(async name=>[name,(await db.prepare(`SELECT * FROM ${name} ORDER BY id`).all()).results])));
}
async function sourceObjects(){
  const listed=await bucket.list({prefix:'publishers/'});
  return JSON.stringify(await Promise.all(listed.objects.map(async row=>[row.key,hash(new Uint8Array(await(await bucket.get(row.key)).arrayBuffer()))])));
}
async function download(id){
  const response=await request(base(site)+'/'+id+'/download');assert.equal(response.status,200);
  const bytes=new Uint8Array(await response.arrayBuffer());
  assert.equal(response.headers.get('x-package-sha256'),hash(bytes));
  return bytes;
}
try{
  await start();await schema();
  check('Compiled MAIN rejects unauthenticated A/B reads',(await request(base(site),{auth:false})).status===401);
  const login=await mf.dispatchFetch(origin+'/api/auth/login',{method:'POST',headers:{origin,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({email:actor,password}),redirect:'manual'});
  assert.equal(login.status,303);assert(login.headers.get('set-cookie'));cookie=login.headers.get('set-cookie').split(';')[0];
  check('The verifier signs in through actual MAIN admin authentication',Boolean(cookie));
  await addSite(site);await addSite(other);
  const a=await generate(site,'3.25.1 cache off');
  const demand=`/api/publishers/${site}/prebid-mode`,before=await json(demand);
  const offConfig=JSON.parse((await db.prepare('SELECT config_json FROM publisher_configs WHERE publisher_id=?').bind(site).first()).config_json);
  await json(demand,{method:'PUT',body:{enabled:true,revision:before.revision,bidCache:{enabled:true,maxBidAgeSeconds:60}}});
  const onConfig=JSON.parse((await db.prepare('SELECT config_json FROM publisher_configs WHERE publisher_id=?').bind(site).first()).config_json);
  const withoutCache=value=>{const copy=structuredClone(value);delete copy.prebidBidCache;return copy;};
  assert.deepEqual(withoutCache(offConfig),withoutCache(onConfig));
  check('Cache ON is saved through MAIN Demand without changing other site settings',offConfig.prebidBidCache.enabled===false&&onConfig.prebidBidCache.enabled===true);
  const b=await generate(site,'3.25.1 cache on'),foreign=await generate(other,'Another site control');
  // Fixture-only production marker: no release publication or external deployment is requested.
  await db.batch([db.prepare("UPDATE releases SET status='production' WHERE id=?").bind(a),
    db.prepare('UPDATE publishers SET current_release_id=?,current_version=? WHERE id=?').bind(a,a,site)]);
  const A=await packageBytes(site,a),B=await packageBytes(site,b);
  check('Both arms are real complete MAIN saved releases on 3.25.1',A.manifest.kind==='builtin-runtime-release'&&B.manifest.kind==='builtin-runtime-release'&&A.manifest.runtime.runtimeVersion==='3.25.1'&&B.manifest.runtime.runtimeVersion==='3.25.1');
  check('Both saved arms retain the exact checked-in verified Prebid bytes',hash(A.files['prebid.js'])===hash(prebid)&&hash(B.files['prebid.js'])===hash(prebid));
  const listing=await json(base(site));
  check('Another publisher sees its own versions and verified current control',listing.supported&&listing.site===site&&listing.current===a&&listing.versions.length===2&&listing.versions.every(row=>row.runtimeVersion==='3.25.1'));
  const dbBefore=await persistent(),sourcesBefore=await sourceObjects();
  const input={name:'Synthetic cache comparison',testId:'workerd_cache_1',a,b,trafficBPercent:50};
  for(const [name,path,options,status] of [
    ['Unauthenticated writes fail closed',base(site),{method:'POST',body:input,auth:false},401],
    ['Cross-origin writes fail closed',base(site),{method:'POST',body:input,origin:'https://foreign.invalid'},403],
    ['Writes without Origin fail closed',base(site),{method:'POST',body:input,origin:null},403],
    ['Malformed JSON fails closed',base(site),{method:'POST',body:'{'},400],
    ['Unknown uploaded fields fail closed',base(site),{method:'POST',body:{...input,source:'not accepted'}},422],
    ['Oversized JSON fails closed',base(site),{method:'POST',body:JSON.stringify({...input,name:'x'.repeat(5000)})},413],
    ['Wrong content type fails closed',base(site),{method:'POST',body:input,headers:{'content-type':'text/plain'}},415],
    ['Unknown query fails closed',base(site)+'?site='+other,{},400],
    ['Unsupported method fails closed',base(site),{method:'PATCH',body:{}},405],
    ['Unknown site fails closed',base('does-not-exist'),{},404],
  ])check(name,(await request(path,options)).status===status);
  const foreignCheck=await json(base(site)+'/check',{method:'POST',body:{a,b:foreign}});
  check('Foreign-site release selection is a refusal',foreignCheck.compatible===false&&foreignCheck.refusal.check==='packages');
  check('Foreign-site create cannot copy another publisher release',(await request(base(site),{method:'POST',body:{...input,b:foreign}})).status===422);
  const compatibility=await json(base(site)+'/check',{method:'POST',body:{a,b}});
  check('Compiled compatibility identifies cache OFF versus ON',compatibility.compatible&&compatibility.configDiff.some(row=>row.field==='bidCache.enabled'&&row.a===false&&row.b===true));
  check('Listing and Check do not create experiment objects',(await bucket.list({prefix:'site-experiments/'})).objects.length===0);
  check('All checks and refusals preserve release channels and saved settings',await persistent()===dbBefore&&await sourceObjects()===sourcesBefore);
  expected=await composeAbBundle({site,a:A,b:B,name:input.name,testId:input.testId,trafficBPercent:input.trafficBPercent});
  const created=await json(base(site),{method:'POST',body:input},201);record=created.record;
  check('Compiled Save matches the direct composer identity',created.created===true&&record.id===expected.id&&record.bundle.zipSha256===expected.zipSha256);
  const registry=JSON.parse(await readFile('worker/experiments/ab-loader-registry.json','utf8'));
  assert.match(record.loader.version,/^\d+\.\d+\.\d+$/);
  const loader=await import(new URL(`../worker/experiments/ab-loader-${record.loader.version}.mjs`,import.meta.url));
  check('The saved loader version matches its registered actual template hash',record.loader.sha256===registry[record.loader.version]?.sha256&&record.loader.sha256===hash(loader.AB_LOADER_TEMPLATE));
  const bytes=await download(record.id),files=unzipSync(bytes);
  check('Downloaded compiled Worker ZIP equals direct compose byte for byte',Buffer.from(bytes).equals(Buffer.from(expected.zip)));
  for(const entry of record.bundle.files){assert.equal(files[entry.path]?.length,entry.bytes);assert.equal(hash(files[entry.path]),entry.sha256);}
  check('Every downloaded A/B file matches its immutable record',Object.keys(files).length===record.bundle.files.length);
  check('Arm files are the original compact saved scripts',Buffer.from(files[record.arms.A.path]).equals(Buffer.from(A.files['ads.min.js']))&&Buffer.from(files[record.arms.B.path]).equals(Buffer.from(B.files['ads.min.js'])));
  const retry=await json(base(site),{method:'POST',body:input});
  check('Retry reuses one completed test without duplicate records',retry.created===false&&retry.record.id===record.id&&(await json(base(site))).tests.length===1);
  check('Changing inputs cannot reuse a reserved TestId',(await request(base(site),{method:'POST',body:{...input,name:'Different test'}})).status===409);
  check('A saved test cannot be read from another site',(await request(base(other)+'/'+record.id)).status===404);
  const recordResponse=await request(base(site)+'/'+record.id+'/record'),recordBytes=new Uint8Array(await recordResponse.arrayBuffer());
  check('Downloaded record bytes match the response checksum',recordResponse.status===200&&hash(recordBytes)===recordResponse.headers.get('x-record-sha256'));
  const plans=base(site)+'/'+record.id+'/measurement/plans';
  check('Nested measurement plans retain actual MAIN authentication',(await request(plans,{auth:false})).status===401);
  const report={networkCode:'999',inventoryPath:'/999/'+site+'/',startDate:'2026-11-18',endDate:'2026-11-18',currency:'EUR',timeZone:'UTC',revenueBasis:'net',revenueMetric:'total'};
  check('Cross-origin measurement writes are refused',(await request(plans,{method:'POST',body:report,origin:'https://foreign.invalid'})).status===403);
  check('Foreign experiment plans cannot be read through another publisher',(await request(base(other)+'/'+record.id+'/measurement/plans')).status===404);
  const planSaved=await json(plans,{method:'POST',body:report},201);measurementPlan=planSaved;
  check('Compiled measurement plans bind the verified experiment and source ZIP',planSaved.created&&planSaved.plan.experimentId===record.id&&planSaved.plan.zipSha256===record.bundle.zipSha256&&planSaved.plan.measurement.collection==='disabled');
  const planRetry=await json(plans,{method:'POST',body:report});
  check('Report-plan retries retain one immutable identity',!planRetry.created&&planRetry.plan.id===planSaved.plan.id&&planRetry.planSha256===planSaved.planSha256);
  const planPath=plans+'/'+planSaved.plan.id,template=await request(planPath+'/template.csv');
  check('Compiled report template uses joint TestId and Variant dimensions',template.status===200&&/date,TestId,Variant,/.test(await template.text()));
  const objectsBeforePreview=JSON.stringify((await bucket.list()).objects.map(row=>[row.key,row.etag]));
  const csv='date,TestId,Variant,impressions,revenue,adRequests,responsesServed,measurableImpressions,viewableImpressions\n'+['A','B'].map(side=>`2026-11-18,${record.testId},${side},10,1.23,20,10,8,6`).join('\n')+'\n';
  const preview=await json(planPath+'/preview',{method:'POST',body:{csv}});
  check('Ad request and impression counts cannot enable page RPM or a winner',preview.revenueReady===false&&preview.winner===null&&preview.upliftPercent===null&&['A','B'].every(side=>preview.totals[side].receivedAssignments===null&&preview.totals[side].pageRpm===null));
  check('CSV preview has no R2 persistence or publisher side effect',JSON.stringify((await bucket.list()).objects.map(row=>[row.key,row.etag]))===objectsBeforePreview&&await persistent()===dbBefore&&await sourceObjects()===sourcesBefore);
  check('Compiled preview rejects an ambiguous raw Key-values CSV',(await request(planPath+'/preview',{method:'POST',body:{csv:'Key-values,Total impressions,Total revenue\nVariant=A,10,1.23\n'}})).status===422);
  // Corrupt only ephemeral fixture objects; the real R2-backed readers must refuse their bytes.
  const zipKey=`site-experiments/v1/${site}/zips/${record.id}.zip`,zipObject=await bucket.get(zipKey);
  const corruptZip=bytes.slice();corruptZip[corruptZip.length-1]^=1;
  await bucket.put(zipKey,corruptZip,{customMetadata:zipObject.customMetadata,httpMetadata:zipObject.httpMetadata});
  check('A corrupted stored ZIP is refused by compiled download',(await request(base(site)+'/'+record.id+'/download')).status===409);
  await bucket.put(zipKey,bytes,{customMetadata:zipObject.customMetadata,httpMetadata:zipObject.httpMetadata});
  const armKey=`publishers/${site}/releases/${b}/ads.min.js`,armObject=await bucket.get(armKey);
  const corruptArm=B.files['ads.min.js'].slice();corruptArm[0]^=1;
  await bucket.put(armKey,corruptArm,{customMetadata:armObject.customMetadata,httpMetadata:armObject.httpMetadata});
  check('A corrupted saved source arm fails closed before compatibility',(await request(base(site)+'/check',{method:'POST',body:{a,b}})).status===503);
  check('A corrupted saved source arm cannot create another test',(await request(base(site),{method:'POST',body:{...input,testId:'workerd_corrupt_1',name:'Refused corrupt source'}})).status===503);
  await bucket.put(armKey,B.files['ads.min.js'],{customMetadata:armObject.customMetadata,httpMetadata:armObject.httpMetadata});
  check('Restoring fixture bytes restores exact readback without an extra record',hash(await download(record.id))===hash(bytes)&&(await json(base(site))).tests.length===1&&await sourceObjects()===sourcesBefore);
  await json(base(site)+'/'+record.id+'/events',{method:'POST',body:{type:'marked-live'}},201);
  await json(base(site)+'/'+record.id+'/events',{method:'POST',body:{type:'marked-stopped'}},201);
  const detail=await json(base(site)+'/'+record.id);
  check('Live and stopped are ordered audit marks',detail.events.length===2&&detail.events[0].type==='marked-live'&&detail.events[1].type==='marked-stopped');
  check('Saving and audit marks never publish or change site/release state',await persistent()===dbBefore&&await sourceObjects()===sourcesBefore);
  const confirmation={confirmId:record.id,sha256:record.bundle.zipSha256};
  check('Deletion requires the exact saved package confirmation',(await request(base(site)+'/'+record.id,{method:'DELETE',body:{...confirmation,sha256:'0'.repeat(64)}})).status===422);
  await json(base(site)+'/'+record.id,{method:'DELETE',body:confirmation});
  check('Deleted tests retain their reserved TestId',(await request(base(site),{method:'POST',body:{...input,name:'Reuse after deletion'}})).status===409);
  await json(base(site)+'/'+record.id,{method:'PUT',body:confirmation});
  check('Restore preserves the exact original ZIP',hash(await download(record.id))===hash(bytes));
  assert.deepEqual(describeCalls(await guardCalls(mf,origin)),[],'Compiled MAIN serialized a function without canonical source text');
  check('Compiled generation and A/B use only registered canonical function text',true);
  await mf.dispose();mf=null;await start();
  const restarted=await json(base(site)+'/'+record.id);
  check('Actual workerd restart preserves identity, ZIP and audit history',restarted.record.id===record.id&&restarted.events.length===2&&hash(await download(record.id))===hash(bytes));
  const restartedPlan=await json(base(site)+'/'+record.id+'/measurement/plans/'+measurementPlan.plan.id);
  check('Actual workerd restart preserves immutable reporting plans',restartedPlan.planSha256===measurementPlan.planSha256&&JSON.stringify(restartedPlan.plan)===JSON.stringify(measurementPlan.plan));
  const retried=await json(base(site),{method:'POST',body:input});
  check('Retry after restart remains idempotent',retried.created===false&&retried.record.id===record.id&&(await json(base(site))).tests.length===1);
  check('Restart and repeated reads preserve source packages and publisher channels',await persistent()===dbBefore&&await sourceObjects()===sourcesBefore);
  // The actual compiled original-source path: static responses only, never execute either real arm.
  await addSite('politika');const originalBefore=await persistent(),originalBase=base('politika');
  check('Original save retains the MAIN origin gate',(await request(originalBase+'/original-sources',{method:'POST',origin:'https://foreign.invalid'})).status===403);
  const originals=await json(originalBase+'/original-sources',{method:'POST'});
  check('Workerd saves both verified original choices',originals.versions.length===2&&originals.versions.every(v=>v.sourceKind==='original-script'&&v.state==='stored'));
  await json(originalBase+'/original-sources',{method:'POST'});
  check('Workerd original-source save and retry make no network requests',outbound===0);
  const originalInput={a:originalId(ORIGINAL_SOURCES[0]),b:originalId(ORIGINAL_SOURCES[1]),name:'Original Politika scripts',testId:'politika_original_1',trafficBPercent:50,reportingKey:'VersionId'};
  check('Compiled original pair passes with explicit scope warnings',(await json(originalBase+'/check',{method:'POST',body:originalInput})).warnings.some(w=>w.code==='original-source-scope'));
  const originalTest=await json(originalBase,{method:'POST',body:originalInput},201);
  const originalDownload=await request(originalBase+'/'+originalTest.record.id+'/download'),originalZip=new Uint8Array(await originalDownload.arrayBuffer()),originalUnzipped=unzipSync(originalZip);
  check('Compiled original test uses the new single-attempt loader',originalTest.record.loader.version==='1.3.0');
  for(const source of ORIGINAL_SOURCES)check('Downloaded original '+source.side+' bytes are unchanged',hash(originalUnzipped[originalTest.record.arms[source.side].path])===source.sha256);
  const originalPlans=await json(originalBase+'/'+originalTest.record.id+'/measurement/plans');
  check('Original sources do not fabricate Config-based reporting scope',originalPlans.sourceError.includes('no complete Config snapshot'));
  check('Saving original sources and test leaves publisher config and channels unchanged',await persistent()===originalBefore);
  check('The complete compiled flow makes no outbound network request',outbound===0);
  assert.deepEqual(describeCalls(await guardCalls(mf,origin)),[],'Restarted MAIN serialized a function without canonical source text');
  await writeFile(output+'/bundle.zip',bytes);await writeFile(output+'/record.json',recordBytes);
  const result={scope:'Actual compiled MAIN Worker in ephemeral workerd/D1/R2; synthetic non-Tanjug 3.25.1 cache OFF/ON packages. No generated ad scripts executed, paid traffic, GAM writes, publisher activation or hosted production verification.',
    passed:checks.length,failed:0,checks,workerSha256:hash(script),site,otherSite:other,releaseA:a,releaseB:b,
    loader:record.loader,prebidSha256:hash(prebid),zipSha256:hash(bytes),recordSha256:hash(recordBytes),outboundRequests:outbound};
  await writeFile(output+'/result.json',JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({passed:checks.length,failed:0,zipSha256:result.zipSha256,loader:record.loader}));
}catch(error){
  await writeFile(output+'/result.json',JSON.stringify({passed:checks.length,failed:1,checks,outboundRequests:outbound,error:{name:error.name,message:error.message}},null,2)+'\n');
  throw error;
}finally{if(mf)await mf.dispose();await rm(directory,{recursive:true,force:true});}
