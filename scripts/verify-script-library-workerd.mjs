import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {readFile,mkdir,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Miniflare} from 'miniflare';
import {unzipSync} from 'fflate';
import {buildSavedScript,buildSavedTest} from './saved-script-package.mjs';
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
  await db.exec("CREATE TABLE publishers(id TEXT PRIMARY KEY,name TEXT,domain TEXT,gam_path TEXT); INSERT INTO publishers VALUES('tanjug','Tanjug','tanjug.rs','/22852026051/Tanjug.rs-Display/');");
  const path='/api/publishers/tanjug/script-library';
  check('Unauthenticated settings are rejected',(await mf.dispatchFetch(origin+path)).status===401);
  const login=await mf.dispatchFetch(origin+'/api/auth/login',{method:'POST',headers:{origin,'content-type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({email:'tester@example.invalid',password}),redirect:'manual'});
  assert(login.headers.get('set-cookie'),'Fixture login failed.');const cookie=login.headers.get('set-cookie').split(';')[0];
  const call=(suffix='',body,extra={})=>mf.dispatchFetch(origin+path+suffix,{method:body?'POST':'GET',headers:{cookie,...(body?{origin,'content-type':'application/json'}:{}),...extra},body:body?JSON.stringify(body):undefined});
  const state=await(await call()).json();check('Reviewed baseline is available',state.supported&&state.baseline.positions===19);
  const inputs={base:await readFile('.generated/tanjug-pilot/ads.js'),previousArchive:await readFile('.generated/tanjug-cmp/tanjug-aa-1.0.2.zip')};
  const scripts={};const savedScripts={};
  const output='.generated/script-library-delivered/';await mkdir(output,{recursive:true});
  async function materialize(kind,id,label,expected){
    const response=await call('/'+kind+'/'+id+'.zip');const bytes=new Uint8Array(await response.arrayBuffer());
    check(label+': exact offline ZIP from compiled Worker',response.status===200&&sha256(bytes)===expected.archiveSha256);
    for(const [name,data] of Object.entries(unzipSync(bytes))){const target=output+label+'/deploy/'+name;await mkdir(target.slice(0,target.lastIndexOf('/')),{recursive:true});await writeFile(target,data);}
    await writeFile(output+label+'/release.json',JSON.stringify(expected.manifest,null,2));
  }
  for(const variant of ['A','B']){
    const settings=variant==='A'?{mode:'fresh-only',refreshSeconds:10}:{mode:'auction-with-cache',refreshSeconds:10,maxBidAgeSeconds:60};
    const body={revision:state.revision,name:variant==='A'?'Standard 10s':'Cache 60s',settings};
    if(variant==='A')check('Cross-origin writes rejected',(await call('/scripts',body,{origin:'https://other.invalid'})).status===403);
    const response=await call('/scripts',body),data=await response.json();assert.equal(response.status,201,JSON.stringify(data));
    const expected=scripts[variant]=await buildSavedScript({...inputs,...body});savedScripts[variant]=data.item;
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
  const history=await(await call()).json();check('Named script and test history',history.scripts.length===2&&history.tests.length===2);
  const recordKeys=(await (await mf.getR2Bucket('BUILDS')).list({prefix:'site-script-library/'})).objects;
  check('Only immutable script/test objects created',recordKeys.length===8);
  check('Generation made no external network request',outbound===0);
  await writeFile(output+'workerd-report.json',JSON.stringify({scope:'Compiled production Worker, ephemeral D1/R2 and synthetic identity only',checks,passed:checks.length,failed:0},null,2));
  console.log(JSON.stringify({passed:checks.length,failed:0}));
}finally{if(mf)await mf.dispose();await rm(directory,{recursive:true,force:true});}
