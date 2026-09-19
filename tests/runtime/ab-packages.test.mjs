import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {AB_PACKAGES,abPackageResponse} from '../../worker/site-runtime/ab-packages.mjs';
const original=readFileSync('.generated/tanjug-cmp/tanjug-aa-1.0.2.zip');
function fixture(domain='tanjug.rs'){
 const objects=new Map();let puts=0;
 const env={DB:{withSession:()=>({prepare:()=>({bind:()=>({first:async()=>({domain})})})})},BUILDS:{
  head:async k=>objects.get(k)||null,get:async k=>objects.get(k)||null,
  put:async(k,bytes,options)=>{assert.equal(options.onlyIf.get('if-none-match'),'*');puts++;if(objects.has(k))return null;
   const copy=bytes.slice();objects.set(k,{size:copy.length,customMetadata:options.customMetadata,arrayBuffer:async()=>copy.slice().buffer});return {};}
 }};
 const call=(method='GET',release=null,bytes=original,site='tanjug')=>abPackageResponse(new Request('https://app.invalid/api/packages',{method,headers:method==='PUT'?{'content-type':'application/zip'}:{},...(method==='PUT'?{body:bytes}: {})}),env,site,release,'tester');
 return {env,objects,call,puts:()=>puts};
}
test('save/download preserves the exact live A/A ZIP, retries do not replace it',async()=>{
 const f=fixture(),pin=AB_PACKAGES[0];
 assert.equal((await(await f.call()).json()).packages[0].saved,false);
 assert.equal((await f.call('PUT',pin.release)).status,201);
 assert.equal((await f.call('PUT',pin.release)).status,200);assert.equal(f.puts(),1);
 assert.equal((await(await f.call()).json()).packages[0].saved,true);
 const response=await f.call('GET',pin.release);assert.equal(response.status,200);
 assert.deepEqual(Buffer.from(await response.arrayBuffer()),original);
 assert.equal(response.headers.get('x-package-sha256'),pin.sha256);
 assert.match(response.headers.get('cache-control'),/private, no-store/);
});
test('changed bytes, oversized streams, wrong site domain and unknown versions cannot register',async()=>{
 const f=fixture(),release=AB_PACKAGES[0].release,bad=Buffer.from(original);bad[100]^=1;
 assert.equal((await f.call('PUT',release,bad)).status,422);
 assert.equal((await f.call('PUT',release,Buffer.concat([original,Buffer.from('x')]))).status,413);
 assert.equal((await f.call('PUT','tanjug-aa-99.0.0')).status,404);assert.equal(f.puts(),0);
 const other=fixture('tanjug.rs.evil.invalid');assert.equal((await(await other.call()).json()).supported,false);
 assert.equal((await other.call('PUT',release)).status,409);assert.equal(other.puts(),0);
 assert.equal((await f.call('GET',release,original,'other-site')).status,409);
});
test('corrupt saved objects cannot be downloaded or overwritten on retry',async()=>{
 const f=fixture(),release=AB_PACKAGES[0].release;await f.call('PUT',release);
 const object=[...f.objects.values()][0];object.arrayBuffer=async()=>new Uint8Array(original.length).buffer;
 assert.equal((await f.call('GET',release)).status,409);
 assert.equal((await f.call('PUT',release)).status,409);assert.equal(f.puts(),1);
});
