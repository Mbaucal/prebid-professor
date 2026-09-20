import test from 'node:test';
import assert from 'node:assert/strict';
import {abEditorResponse} from '../../worker/site-runtime/ab-editor.mjs';
import {DEFAULT_PACKAGE_SETTINGS} from '../../worker/experiments/package-settings-v1.mjs';

function fixture() {
  const row={id:'tanjug',name:'Tanjug',domain:'tanjug.rs',gam_path:'/22852026051/Tanjug.rs-Display/'};
  const objects=new Map();let writes=0;
  const env={DB:{withSession:()=>({prepare:()=>({bind:id=>({first:async()=>id===row.id?{...row}:null})})})},BUILDS:{
    get:async key=>objects.get(key)||null,
    list:async({prefix})=>({objects:[...objects.entries()].filter(([key])=>key.startsWith(prefix)).map(([key,o])=>({key,customMetadata:o.customMetadata})),truncated:false}),
    put:async(key,bytes,options)=>{assert.equal(options.onlyIf.get('if-none-match'),'*');if(objects.has(key))return null;writes++;
      const copy=Buffer.from(bytes);objects.set(key,{size:copy.length,customMetadata:options.customMetadata,arrayBuffer:async()=>Uint8Array.from(copy).buffer});return {};},
  }};
  const call=(method='GET',body,resource=null,options={},site='tanjug')=>abEditorResponse(new Request('https://app.invalid/api/ab',{method,
    headers:body?{'content-type':'application/json'}:{},...(body?{body:JSON.stringify(body)}:{})}),env,site,resource,'admin@example.invalid',options);
  return {row,env,objects,call,writes:()=>writes};
}
const settings=()=>structuredClone(DEFAULT_PACKAGE_SETTINGS);
let first;
test('generate, list, retry and download keep one exact immutable package',async()=>{
  const f=fixture(),state=await(await f.call()).json();
  const body={revision:state.revision,settings:settings(),notes:'First cache comparison'};
  const response=await f.call('POST',body);assert.equal(response.status,201,await response.clone().text());
  const p=(await response.json()).package;first=p;
  const bytes=Buffer.from(await(await f.call('GET',undefined,p.release)).arrayBuffer());
  assert.equal(bytes.length,p.bytes);assert.equal(f.writes(),2);
  const retry=await f.call('POST',{...body,notes:'Do not overwrite original note'});assert.equal(retry.status,200);
  assert.equal((await retry.json()).package.notes,body.notes);assert.equal(f.writes(),2);
  assert.equal((await(await f.call()).json()).packages.length,1);
  assert.deepEqual(Buffer.from(await(await f.call('GET',undefined,p.release)).arrayBuffer()),bytes);
  const baseline=await f.call('GET',undefined,'baseline');assert.equal(baseline.status,200);
  assert.equal(baseline.headers.get('x-package-sha256'),state.baseline.sha256);
});
test('unknown site, wrong GAM/domain, stale baseline and invalid settings cannot generate',async()=>{
  const f=fixture(),state=await(await f.call()).json(),body={revision:state.revision,settings:settings(),notes:''};
  assert.equal((await f.call('POST',{...body,revision:'stale'})).status,409);
  const invalid=settings();invalid.arms.B.maxBidAgeSeconds=0;
  assert.equal((await f.call('POST',{...body,settings:invalid})).status,422);
  assert.equal((await f.call('POST',{...body,publish:true})).status,422);
  assert.equal((await f.call('POST',{...body,notes:'x'.repeat(5000)})).status,413);
  assert.equal((await f.call('GET',undefined,null,{},'missing')).status,404);
  f.row.gam_path='/other/';assert.equal((await(await f.call()).json()).supported,false);
  assert.equal((await f.call('POST',body)).status,409);
  f.row.gam_path='/22852026051/Tanjug.rs-Display/';f.row.domain='tanjug.rs.evil.invalid';
  assert.equal((await f.call('POST',body)).status,409);assert.equal(f.writes(),0);
});
test('identity changes during compilation cannot register a package',async()=>{
  const f=fixture(),state=await(await f.call()).json();
  const response=await f.call('POST',{revision:state.revision,settings:settings(),notes:''},null,{build:async()=>{
    f.row.domain='changed.invalid';
    const bytes=Buffer.from('synthetic');
    const {sha256}=await import('../../scripts/static-aa-package.mjs');
    return {release:'tanjug-ab-2.0.0-'+'a'.repeat(64),archive:bytes,archiveSha256:sha256(bytes)};
  }});
  assert.equal(response.status,409);assert.equal(f.writes(),0);
});
test('saved corruption cannot be downloaded or replaced; sites cannot read each other',async()=>{
  const f=fixture(),state=await(await f.call()).json();
  const body={revision:state.revision,settings:settings(),notes:''};
  const result=await f.call('POST',body),p=(await result.json()).package;
  const object=[...f.objects.entries()].find(([k])=>k.endsWith('.zip'))[1];
  object.arrayBuffer=async()=>new Uint8Array(object.size).buffer;
  assert.equal((await f.call('GET',undefined,p.release)).status,409);
  assert.equal((await f.call('POST',body)).status,409);assert.equal(f.writes(),2);
  f.row.id='another-tanjug';
  assert.equal((await f.call('GET',undefined,p.release,{},'another-tanjug')).status,404);
});
