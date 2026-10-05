import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {readFile,mkdir,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Miniflare} from 'miniflare';
import {unzipSync} from 'fflate';
import {buildConfigurableABPackage} from './configurable-ab-package.mjs';
import {sha256} from './static-aa-package.mjs';

const directory=await mkdtemp(join(tmpdir(),'ab-editor-'));
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
  await db.exec("CREATE TABLE publishers(id TEXT PRIMARY KEY,name TEXT,domain TEXT,gam_path TEXT); INSERT INTO publishers VALUES('tanjug','Tanjug','tanjug.rs','/22852026051/Tanjug.rs-Display/');");
  const path='/api/publishers/tanjug/ab-experiments';
  check('Unauthenticated settings are rejected',(await mf.dispatchFetch(origin+path)).status===401);
  const login=await mf.dispatchFetch(origin+'/api/auth/login',{method:'POST',headers:{origin,'content-type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({email:'tester@example.invalid',password}),redirect:'manual'});
  assert(login.headers.get('set-cookie'),'Fixture login failed.');const cookie=login.headers.get('set-cookie').split(';')[0];
  const call=(suffix='',body,extra={})=>mf.dispatchFetch(origin+path+suffix,{method:body?'POST':'GET',headers:{cookie,...(body?{origin,'content-type':'application/json'}:{}),...extra},body:body?JSON.stringify(body):undefined});
  const state=await(await call()).json();check('Reviewed baseline is available',state.supported&&state.baseline.positions===19);
  const settings=JSON.parse(await readFile('tests/runtime/configurable-ab-settings.json','utf8'));
  const body={revision:state.revision,settings,notes:'10 second integration fixture'};
  check('Cross-origin writes are rejected',(await call('',body,{origin:'https://other.invalid'})).status===403);
  const generated=await call('',body),data=await generated.json();
  assert.equal(generated.status,201,JSON.stringify(data));
  const saved=data.package;const download=await call('/'+saved.release+'.zip');
  const bytes=new Uint8Array(await download.arrayBuffer());
  check('Downloaded bytes match the saved hash',download.status===200&&sha256(bytes)===saved.sha256&&bytes.length===saved.bytes);
  const expected=await buildConfigurableABPackage({base:await readFile('.generated/tanjug-pilot/ads.js'),previousArchive:await readFile('.generated/tanjug-cmp/tanjug-aa-1.0.2.zip'),settings});
  check('Bundled Worker produces the exact offline-verified ZIP',expected.archiveSha256===saved.sha256&&expected.release===saved.release);
  const retry=await call('',{...body,notes:'Retry'});check('Retry preserves first record',(await retry.json()).package.notes===body.notes);
  const history=await(await call()).json();check('History contains the saved configuration',history.packages.length===1&&history.packages[0].settings.arms.B.refreshSeconds===10);
  const files=unzipSync(bytes),folder='.generated/ab-editor-delivered/';
  for(const [name,bytes] of Object.entries(files)){const target=folder+'deploy/'+name;await mkdir(target.slice(0,target.lastIndexOf('/')),{recursive:true});await writeFile(target,bytes);}
  await writeFile(folder+'release.json',JSON.stringify(expected.manifest,null,2));
  check('Generation made no external network request',outbound===0);
  await writeFile(folder+'workerd-report.json',JSON.stringify({scope:'Compiled production Worker, ephemeral D1/R2 and synthetic identity only',checks,passed:checks.length,failed:0,sha256:saved.sha256},null,2));
  console.log(JSON.stringify({passed:checks.length,failed:0,release:saved.release,sha256:saved.sha256}));
}finally{if(mf)await mf.dispose();await rm(directory,{recursive:true,force:true});}
