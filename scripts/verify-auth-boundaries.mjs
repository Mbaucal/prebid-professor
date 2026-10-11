/** Actual compiled Worker, local workerd/D1 only. Never contacts a hosted service. */
import assert from 'node:assert/strict';
import { readFile,mkdtemp,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { Miniflare } from './local-miniflare.mjs';
const config=JSON.parse(await readFile('dist/prebid_professor/wrangler.json','utf8'));
const folder=await mkdtemp(join(tmpdir(),'tessera-auth-'));
const email='admin@example.invalid',password='Synthetic-login-fixture-only-927!';
const mf=new Miniflare({modules:true,script:await readFile('dist/prebid_professor/index.js','utf8'),compatibilityDate:config.compatibility_date,compatibilityFlags:config.compatibility_flags,cf:false,host:'127.0.0.1',port:0,resourcePersistencePath:folder,bindings:{ADMIN_EMAIL:email,ADMIN_PASSWORD:password,SESSION_SECRET:'Synthetic-session-signing-key-not-for-production-927!'},d1Databases:{DB:'local-auth'},r2Buckets:{BUILDS:'local-unused'},assets:{directory:'dist/client',binding:'ASSETS',routerConfig:{has_user_worker:true,invoke_user_worker_ahead_of_assets:true},assetConfig:{not_found_handling:'single-page-application'}},outboundService:()=>{throw Error('Auth checks prohibit outbound requests');}});
const origin='https://tessera.example.invalid';
const spoof={'cf-access-authenticated-user-email':'forged-access@example.invalid','x-user-email':'forged-user@example.invalid'};
const call=(path,options={})=>mf.dispatchFetch(origin+path,{redirect:'manual',...options});
const login=(passwordValue=password,headers={})=>call('/api/auth/login',{method:'POST',headers:{origin,'content-type':'application/x-www-form-urlencoded',...headers},body:new URLSearchParams({email,password:passwordValue,next:'/config?site=auth-site#units'}).toString()});
try{
 const db=await mf.getD1Database('DB');
 // Apply only schema DDL to a fresh local database; no publisher seed content.
 const initial=(await readFile('migrations/0001_initial.sql','utf8')).split('INSERT OR IGNORE INTO publishers')[0];
 const hierarchy=(await readFile('migrations/0002_publisher_accounts.sql','utf8')).split('INSERT OR IGNORE INTO publisher_accounts')[0];
 for(const source of [initial,hierarchy])for(const sql of source.replace(/^\s*--.*$/gm,'').split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(sql).run();
 const anonymous=await call('/api/publisher-accounts',{method:'POST',headers:{...spoof,origin,'content-type':'application/json'},body:JSON.stringify({id:'forged',name:'Forbidden'})});assert.equal(anonymous.status,401);
 const signedIn=await login();assert.equal(signedIn.status,303);assert.equal(signedIn.headers.get('location'),'/config?site=auth-site#units');
 const cookie=signedIn.headers.get('set-cookie').split(';')[0];
 async function mutate(path,body,status=201){const response=await call(path,{method:'POST',headers:{...spoof,cookie,origin,'content-type':'application/json'},body:JSON.stringify(body)});const data=await response.json();assert.equal(response.status,status,JSON.stringify(data));return data;}
 await mutate('/api/publisher-accounts',{id:'auth-publisher',name:'Synthetic publisher'});
 await mutate('/api/publishers',{id:'auth-site',name:'Synthetic site',domain:'example.invalid',gamPath:'/123/example/',publisherAccountId:'auth-publisher'});
 const map=await mutate('/api/publishers/auth-site/size-maps',{name:'Original',map:[{minViewPort:[0,0],sizes:[[300,250]]}]});
 await mutate(`/api/publishers/auth-site/size-maps/${map.sizeMap.id}/duplicate`,{name:'Copied'});
 const records=(await db.prepare('SELECT actor,action FROM audit_log').all()).results;
 assert(records.length>=4);assert(records.every(row=>row.actor===email),JSON.stringify(records));
 assert.equal((await db.prepare('SELECT created_by FROM publisher_configs').first()).created_by,email);
 for(let i=0;i<4;i++)assert.equal((await login('wrong',{'x-forwarded-for':`198.51.100.${i}`})).status,401);
 const blocked=await login();assert.equal(blocked.status,429);assert(+blocked.headers.get('retry-after')<=60);assert.equal(blocked.headers.get('set-cookie'),null);
 await db.prepare('UPDATE auth_login_limits SET reset_at=unixepoch()-1').run();assert.equal((await login()).status,303);
 // A missing table is initialized, not a rollout login lockout.
 await db.prepare('DROP TABLE auth_login_limits').run();assert.equal((await login()).status,303);
 // An unexpected schema is not repaired and cannot issue a session.
 await db.prepare('ALTER TABLE auth_login_limits RENAME TO fixture_saved_limits').run();await db.prepare('CREATE TABLE auth_login_limits (unexpected TEXT)').run();
 const unavailable=await login();assert.equal(unavailable.status,503);assert.equal(unavailable.headers.get('retry-after'),'30');assert.equal(unavailable.headers.get('set-cookie'),null);
 assert.equal((await call('/api/auth/me',{headers:{cookie}})).status,200,'An active verified session must survive limiter outage');
 await db.prepare('DROP TABLE auth_login_limits').run();await db.prepare('ALTER TABLE fixture_saved_limits RENAME TO auth_login_limits').run();await db.prepare('DELETE FROM auth_login_limits').run();assert.equal((await login()).status,303);
 console.log('PASS: compiled Worker login burst/cooldown/recovery, missing/broken schema, spoofed header mutation + persisted audit, duplicate adapter actor.');
 if(process.argv.includes('--serve')){
  await db.prepare('DELETE FROM auth_login_limits').run();console.log('AUTH_FIXTURE_READY '+await mf.ready);
  for await(const command of createInterface({input:process.stdin})){
   if(command==='expire')await db.prepare('UPDATE auth_login_limits SET reset_at=unixepoch()-1').run();
   if(command==='unavailable'){await db.prepare('ALTER TABLE auth_login_limits RENAME TO fixture_saved_limits').run();await db.prepare('CREATE TABLE auth_login_limits (unexpected TEXT)').run();}
   if(command==='recover'){await db.prepare('DROP TABLE auth_login_limits').run();await db.prepare('ALTER TABLE fixture_saved_limits RENAME TO auth_login_limits').run();await db.prepare('DELETE FROM auth_login_limits').run();}
   console.log('AUTH_COMMAND_DONE '+command);
  }
 }
}finally{await mf.dispose();await rm(folder,{recursive:true,force:true});}
