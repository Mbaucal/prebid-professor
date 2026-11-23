import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mainAbFixture} from '../support/ab-tests-main-fixture.mjs';
import {DEFAULT_PACKAGE_SETTINGS} from '../../worker/experiments/package-settings-v1.mjs';

const base='/api/publishers/tanjug/ab-tests',history=base+'/history';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const encode=value=>new TextEncoder().encode(JSON.stringify(value));
let h,originalFetch,namedScripts=[],namedTests=[],generatedTest,originalConfig;
const state=()=>JSON.stringify({sql:h.persistent(),objects:[...h.r2.objects].map(([key,row])=>[key,hash(row.bytes),row.customMetadata])});
const get=async(path=history,options)=>{
  const response=await h.request(path,options);return {status:response.status,value:await response.json(),headers:response.headers};
};
const scriptKey=id=>`site-script-library/v1/tanjug/scripts/records/${id}.json`;
const scriptZip=id=>`site-script-library/v1/tanjug/scripts/archives/${id}.zip`;

test.before(async()=>{
  originalFetch=globalThis.fetch;globalThis.fetch=()=>assert.fail('No outbound traffic');
  h=await mainAbFixture({seed:false});
  originalConfig=JSON.stringify({enablePrebid:true,prebidBidCache:{enabled:false,maxBidAgeSeconds:60}});
  h.f.sqlite.prepare('INSERT INTO publishers(id,name,domain,gam_path) VALUES(?,?,?,?)').run('tanjug','Tanjug','tanjug.rs','/22852026051/Tanjug.rs-Display/');
  h.f.sqlite.prepare('INSERT INTO publisher_configs(id,publisher_id,config_json) VALUES(?,?,?)').run('tanjug-config','tanjug',originalConfig);
  const library='/api/publishers/tanjug/script-library';
  const initial=await h.json(library);
  for(let n=0;n<6;n++){
    const response=await h.json(library+'/scripts',{method:'POST',body:{revision:initial.revision,name:`Historical script ${n}`,refreshSeconds:30}},201);
    namedScripts.push(response.item);
  }
  for(let n=0;n<3;n++){
    const response=await h.json(library+'/tests',{method:'POST',body:{revision:initial.revision,name:`Historical test ${n}`,scriptA:namedScripts[0].id,scriptB:namedScripts[1].id,trafficBPercent:50}},201);
    namedTests.push(response.item);
  }
  const older='/api/publishers/tanjug/ab-experiments',oldState=await h.json(older);
  generatedTest=(await h.json(older,{method:'POST',body:{revision:oldState.revision,settings:DEFAULT_PACKAGE_SETTINGS,notes:'Original configurable pilot'}},201)).package;
  await h.addSite('alpha-site');
});
test.after(()=>{h?.close();globalThis.fetch=originalFetch;});

test('a real zero-builtin Tanjug site lists all existing historical collections without writes or invented TestId',async()=>{
  assert.equal((await get(base)).value.versions.length,0);
  const before=state(),gets=h.r2.log.gets.length,lists=h.r2.log.lists.length;
  const result=await get();assert.equal(result.status,200);assert.match(result.headers.get('cache-control'),/private, no-store/);
  const {sections,baseline}=result.value;
  assert.equal(sections.scripts.items.length,5);assert(sections.scripts.nextCursor);
  assert.equal(sections.namedTests.items.length,3);assert.equal(sections.generatedTests.items.length,1);
  for(const [collection,part] of Object.entries(sections)){
    assert.equal(part.error,null);
    for(const row of part.items){assert.equal(row.state,'stored');assert.equal(row.testId,null);assert.equal(row.reporting,collection==='scripts'?'not-instrumented':'variant-only');assert.equal(row.runtimeVersion,'3.9.1');assert.equal(row.prebidVersion,'11.34.0');assert(row.downloadUrl.startsWith(history+'/'));}
  }
  assert.equal(baseline.id,'tanjug-aa-1.0.2');assert.equal(baseline.name,'Accepted A/A baseline');assert.equal(baseline.createdAt,null);assert.equal(baseline.testId,null);
  assert.equal(sections.generatedTests.items[0].scripts.A.id,null,'generated pilots never had independent saved script IDs');
  assert.equal(state(),before);
  assert(h.r2.log.lists.slice(lists).every(row=>row.limit===5));
  assert(h.r2.log.gets.length-gets+h.r2.log.lists.length-lists<=48,'initial history stays within its bounded read budget');
});

test('history pagination follows genuine opaque cursors without duplicates or unbounded reads',async()=>{
  const first=(await get()).value,all=[...first.sections.scripts.items];let cursor=first.sections.scripts.nextCursor;
  while(cursor){
    const page=await get(history+'?collection=scripts&cursor='+encodeURIComponent(cursor));assert.equal(page.status,200);
    assert.deepEqual(Object.keys(page.value.sections),['scripts']);assert.equal(page.value.baseline,null);
    all.push(...page.value.sections.scripts.items);cursor=page.value.sections.scripts.nextCursor;
  }
  assert.equal(all.length,6);assert.equal(new Set(all.map(row=>row.id)).size,6);
  assert.deepEqual(new Set(all.map(row=>row.id)),new Set(namedScripts.map(row=>row.id)));
});

test('history and original ZIP downloads survive invalid current settings and changed site identity',async()=>{
  const initial=(await get()).value;
  const rows=[initial.sections.scripts.items[0],initial.sections.namedTests.items[0],initial.sections.generatedTests.items[0]];
  const originalBytes=new Map();
  for(const row of rows){const response=await h.request(row.downloadUrl);assert.equal(response.status,200);originalBytes.set(row.id,new Uint8Array(await response.arrayBuffer()));}
  h.f.sqlite.prepare('UPDATE publisher_configs SET config_json=? WHERE publisher_id=?').run('{invalid current configuration','tanjug');
  h.f.sqlite.prepare('UPDATE publishers SET domain=?,gam_path=? WHERE id=?').run('renamed.example.invalid','/999/renamed/','tanjug');
  try{
    const before=state(),result=await get();assert.equal(result.status,200);assert.equal(result.value.baseline,null,'fixed Tanjug baseline is not offered on another network');
    for(const row of rows){const response=await h.request(row.downloadUrl);assert.equal(response.status,200);assert.deepEqual(new Uint8Array(await response.arrayBuffer()),originalBytes.get(row.id));assert.equal(response.headers.get('x-package-sha256'),row.sha256);}
    assert.equal((await h.request(history+'/baseline/tanjug-aa-1.0.2/download')).status,404);
    assert.equal(state(),before);
  }finally{
    h.f.sqlite.prepare('UPDATE publisher_configs SET config_json=? WHERE publisher_id=?').run(originalConfig,'tanjug');
    h.f.sqlite.prepare('UPDATE publishers SET domain=?,gam_path=? WHERE id=?').run('tanjug.rs','/22852026051/Tanjug.rs-Display/','tanjug');
  }
});

test('historical auth, site boundaries, method and page-query checks precede package access',async()=>{
  const before=state(),gets=h.r2.log.gets.length;
  assert.equal((await get(history,{auth:false})).status,401);
  for(const method of ['POST','PUT','DELETE'])assert.equal((await get(history,{method,body:{}})).status,405);
  for(const query of ['?collection=scripts','?cursor=x','?collection=unknown&cursor=x','?collection=scripts&cursor=x&extra=1','?collection=scripts&collection=scripts&cursor=x','?collection=scripts&cursor='+ 'x'.repeat(2049)]){
    const result=await get(history+query);assert.equal(result.status,400);assert.match(result.value.error,/collection|cursor/i);
  }
  assert.equal(h.r2.log.gets.length,gets);
  const row=(await get()).value.sections.scripts.items[0];
  assert.equal((await h.request(row.downloadUrl+'?extra=1')).status,400);
  assert.equal((await h.request(row.downloadUrl.replace('/tanjug/','/alpha-site/'))).status,404);
  assert.equal((await h.request('/api/publishers/alpha-site/ab-tests/history/baseline/tanjug-aa-1.0.2/download')).status,404);
  assert.equal((await h.request(history+'/scripts/not-an-id/download')).status,404);
  assert.equal((await get('/api/publishers/missing-site/ab-tests/history')).status,404);
  assert.equal(state(),before);
});

test('a corrupt stored ZIP is unavailable rather than downloadable or silently converted',async()=>{
  const row=(await get()).value.sections.scripts.items[0],stored=h.r2.objects.get(scriptZip(row.id)),original=stored.bytes;
  stored.bytes=original.slice();stored.bytes[0]^=1;
  try{
    const result=(await get()).value,unavailable=result.sections.scripts.items.find(item=>item.id===row.id);
    assert.equal(unavailable.state,'unavailable');assert.equal(unavailable.downloadUrl,null);assert.match(unavailable.reason,/checksum/i);
    assert.equal((await h.request(row.downloadUrl)).status,409);
    assert.equal(result.sections.namedTests.error,null);assert.equal(result.sections.namedTests.items.length,3);
  }finally{stored.bytes=original;}
});

test('record checksum, size and bound site identity fail closed without erasing other history',async()=>{
  const row=(await get()).value.sections.scripts.items[0],stored=h.r2.objects.get(scriptKey(row.id));
  const original=stored.bytes,metadata={...stored.customMetadata};
  const invalidRecords=[new Uint8Array(32769),encode({...JSON.parse(new TextDecoder().decode(original)),siteId:'alpha-site'})];
  try{
    for(const bytes of invalidRecords){
      stored.bytes=bytes;stored.customMetadata.sha256=hash(bytes);
      const result=(await get()).value;
      assert.equal(result.sections.scripts.items.find(item=>item.id===row.id).state,'unavailable');
      assert.equal((await h.request(row.downloadUrl)).status,409);
      assert.equal(result.sections.generatedTests.items[0].id,generatedTest.release);
    }
    stored.bytes=original;stored.customMetadata.sha256='0'.repeat(64);
    assert.match((await get()).value.sections.scripts.items.find(item=>item.id===row.id).reason,/checksum/i);
  }finally{stored.bytes=original;stored.customMetadata=metadata;}
});

test('a collection storage fault is explicit and leaves the other saved collections visible',async()=>{
  h.r2.faults.list=({prefix})=>{if(prefix.includes('/scripts/records/'))throw Error('Synthetic unavailable collection');};
  try{
    const result=await get();assert.equal(result.status,200);
    assert.match(result.value.sections.scripts.error,/Could not load/);
    assert.equal(result.value.sections.scripts.items.length,0);
    assert.equal(result.value.sections.namedTests.items.length,3);assert.equal(result.value.sections.generatedTests.items.length,1);
  }finally{h.r2.faults.list=null;}
});

test('soft-deleted history stays distinct and cannot be downloaded through the new read route',async()=>{
  const row=(await get()).value.sections.scripts.items[0],confirm={confirmId:row.id,sha256:row.sha256};
  await h.json('/api/publishers/tanjug/script-library/scripts/'+row.id+'.zip',{method:'DELETE',body:confirm});
  try{
    const before=state(),result=(await get()).value;
    const deleted=result.sections.scripts.deleted.find(item=>item.id===row.id);assert(deleted);assert.equal(deleted.downloadUrl,null);
    assert.equal((await h.request(row.downloadUrl)).status,410);assert.equal(state(),before);
  }finally{await h.json('/api/publishers/tanjug/script-library/scripts/'+row.id+'.zip',{method:'PUT',body:confirm});}
});

test('one damaged builtin manifest cannot erase saved tests or the healthy source choices',async()=>{
  const alpha='/api/publishers/alpha-site/ab-tests',versions=h.versions['alpha-site'];
  const saved=await h.json(alpha,{method:'POST',body:{a:versions[0],b:versions[1],name:'Existing generic test',testId:'existing_test',trafficBPercent:50}},201);
  const key=`publishers/alpha-site/releases/${versions[0]}/manifest.json`,object=h.r2.objects.get(key);
  h.r2.objects.delete(key);
  try{
    const before=state(),result=await get(alpha);assert.equal(result.status,200);assert.equal(result.value.tests[0].id,saved.record.id);
    const broken=result.value.versions.find(row=>row.id===versions[0]),healthy=result.value.versions.find(row=>row.id===versions[1]);
    assert.equal(broken.state,'unavailable');assert.equal(broken.runtimeVersion,null);assert.match(broken.unavailableReason,/manifest/i);
    assert.equal(healthy.state,'stored');assert.match(healthy.runtimeSha256,/^[a-f0-9]{64}$/);assert.equal(healthy.prebidVersion,null,'GAM-only sources do not claim Prebid');
    assert.equal(result.value.current,null);
    assert.equal((await h.request(alpha+'/'+saved.record.id+'/download')).status,200);
    const body={a:versions[0],b:versions[1],name:'Broken source',testId:'broken_source',trafficBPercent:50};
    for(const path of [alpha+'/check',alpha]){
      const refused=await h.json(path,{method:'POST',body},503);assert.match(refused.error,/could not be read/i);
    }
    assert.equal(state(),before);
  }finally{h.r2.objects.set(key,object);}
});

test('MAIN packages with the same settings ignore generated release IDs in their difference summary',async()=>{
  const alpha='/api/publishers/alpha-site/ab-tests',packages='/api/publishers/alpha-site/builtin-releases';
  h.f.sqlite.prepare('UPDATE unit_rules SET rule_json=? WHERE publisher_id=?').run(JSON.stringify({timeout:800,refresh:{enabled:false}}),'alpha-site');
  const priorDate=globalThis.Date,stamp=priorDate.now()+3600000;
  let generated;
  try{
    globalThis.Date=class extends priorDate{constructor(...args){super(...(args.length?args:[stamp]));}static now(){return stamp;}};
    const ready=await h.json(packages);generated=(await h.json(packages,{method:'POST',body:{action:'generate',revision:ready.revision,notes:'Same settings, later build'}},201)).release.id;
  }finally{globalThis.Date=priorDate;}
  assert.notEqual(generated,h.versions['alpha-site'][0]);
  const body={a:h.versions['alpha-site'][0],b:generated,name:'Same MAIN settings',testId:'same_settings',trafficBPercent:50};
  const checked=await h.json(alpha+'/check',{method:'POST',body});assert.equal(checked.compatible,true);assert.deepEqual(checked.configDiff,[]);
  const saved=await h.json(alpha,{method:'POST',body},201),recordKey=`site-experiments/v1/alpha-site/records/${saved.record.id}.json`;
  const stored=h.r2.objects.get(recordKey),historical={...saved.record,configDiff:[{field:'otherSettings',a:{version:body.a},b:{version:body.b}}]};
  stored.bytes=encode(historical);stored.customMetadata.sha256=hash(stored.bytes);
  const before=state(),retry=await h.json(alpha,{method:'POST',body});
  assert.equal(retry.created,false);assert.deepEqual(retry.record,historical);assert.equal(retry.record.bundle.zipSha256,saved.record.bundle.zipSha256);
  assert.equal(state(),before,'a retry preserves the original historical record, ZIP and source bytes');
});

test('unnamed configurable pilots get stable distinguishable history labels for empty or whitespace notes',async()=>{
  const endpoint='/api/publishers/tanjug/ab-experiments',initial=await h.json(endpoint),saved=[];
  for(const [notes,trafficBPercent] of [['',49],[' \t ',48]]){
    const settings={...DEFAULT_PACKAGE_SETTINGS,trafficBPercent};
    const result=await h.json(endpoint,{method:'POST',body:{revision:initial.revision,settings,notes}},201);
    assert.equal(result.package.notes,'');saved.push(result.package);
  }
  const before=state(),rows=(await get()).value.sections.generatedTests.items;
  for(const item of saved){
    const row=rows.find(value=>value.id===item.release);assert(row);
    assert.equal(row.name,`Earlier A/B package ${item.release.slice(-8)}`);
    assert.equal(row.state,'stored');assert.equal(row.testId,null);assert(row.downloadUrl);
  }
  assert.equal(new Set(saved.map(item=>rows.find(row=>row.id===item.release).name)).size,2);
  assert.equal(state(),before,'reading fallback labels never rewrites historical records or archives');
});
