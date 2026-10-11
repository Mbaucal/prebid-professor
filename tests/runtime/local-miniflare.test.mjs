import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {Miniflare,Headers,isolatedToolchain} from '../../scripts/local-miniflare.mjs';

test('explicit isolated selector rejects unknown mode and never falls back to tools',()=>{
 assert.equal(isolatedToolchain,true);assert.equal(typeof Headers,'function');
 for(const mode of ['unknown',undefined]){
  const env={...process.env};delete env.TESSERA_TEST_TOOLCHAIN;if(mode)env.TESSERA_TEST_TOOLCHAIN=mode;
  const child=spawnSync(process.execPath,['--input-type=module','-e',"await import('./scripts/local-miniflare.mjs')"],{env,encoding:'utf8'});
  assert.notEqual(child.status,0);assert.match(child.stderr,mode?/Unknown TESSERA_TEST_TOOLCHAIN mode/:/Cannot find package 'miniflare'/);
 }
});

test('supported converter retains bindings, authorization, outbound guard and D1/R2 persistence',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'mba229-miniflare-'));let mf;let outbound=0;
 const options=path=>({modules:true,cf:false,compatibilityDate:'2026-07-15',resourcePersistencePath:path,
  bindings:{TOKEN:'fixture'},d1Databases:{DB:'fixture-db'},r2Buckets:{BUCKET:'fixture-bucket'},
  outboundService:()=>{outbound++;return new Response('blocked',{status:503});},
  script:`export default {async fetch(request,env){
   if(request.headers.get('authorization')!==env.TOKEN)return new Response('',{status:401});
   if(request.headers.get('origin')!=='https://fixture.invalid')return new Response('',{status:403});
   const path=new URL(request.url).pathname;
   if(path==='/outbound')return fetch('https://network.invalid/');
   await env.DB.prepare('CREATE TABLE IF NOT EXISTS fixture(value TEXT)').run();
   if(request.method==='POST'){await env.DB.prepare("INSERT INTO fixture VALUES ('retained')").run();await env.BUCKET.put('key','retained');}
   return Response.json({rows:(await env.DB.prepare('SELECT * FROM fixture').all()).results,object:await (await env.BUCKET.get('key'))?.text()??null});
  }};`});
 const request=(path='/',extra={})=>mf.dispatchFetch('https://fixture.invalid'+path,{headers:{authorization:'fixture',origin:'https://fixture.invalid'},...extra});
 try{
  mf=new Miniflare(options(directory));
  assert.equal((await mf.dispatchFetch('https://fixture.invalid')).status,401);
  assert.equal((await request('/',{headers:{authorization:'fixture',origin:'https://other.invalid'}})).status,403);
  const expected={rows:[{value:'retained'}],object:'retained'};
  assert.deepEqual(await (await request('/',{method:'POST'})).json(),expected);
  assert.equal(outbound,0);
  await mf.dispose();mf=new Miniflare(options(directory));
  assert.deepEqual(await (await request()).json(),expected);
  await mf.dispose();mf=new Miniflare(options(join(directory,'separate')));
  assert.deepEqual(await (await request()).json(),{rows:[],object:null});
  assert.equal(outbound,0);assert.equal((await request('/outbound')).status,503);assert.equal(outbound,1);
 }finally{await mf?.dispose();await rm(directory,{recursive:true,force:true});}
});

test('explicit invalid persistence is rejected by native validation rather than silently dropped',()=>{
 assert.throws(()=>new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2026-07-15',cf:false,resourcePersistencePath:false}),/resourcePersistencePath|expected string/);
});
