import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleLogin, getAuthenticatedUser } from '../../worker/auth.ts';
import { getActor,withAuthenticatedActor } from '../../worker/http.ts';
import { loginStore } from '../support/login-store.mjs';
const auth={ADMIN_EMAIL:'admin@example.invalid',ADMIN_PASSWORD:'synthetic-password-only',SESSION_SECRET:'synthetic-session-secret-not-used-outside-tests'};
const origin='https://tessera.invalid';
function attempt(DB,{email=auth.ADMIN_EMAIL,password='wrong',ip='192.0.2.1',headers={},next='/config?site=demo#units'}={}){
 return handleLogin(new Request(origin+'/api/auth/login',{method:'POST',headers:{origin,'content-type':'application/x-www-form-urlencoded',...(ip?{'cf-connecting-ip':ip}:{}),...headers},body:new URLSearchParams({email,password,next})}),{...auth,DB});
}
test('atomic shared limit survives new instances, bursts, changed email/XFF and recovers after fixed window',async()=>{
 const folder=mkdtempSync(join(tmpdir(),'tessera-login-'));const path=join(folder,'login.sqlite');const a=loginStore(path),b=loginStore(path);
 try {
  const responses=await Promise.all(Array.from({length:20},(_,i)=>attempt(i%2?a.DB:b.DB,{email:`untrusted${i}@example.invalid`,headers:{'x-forwarded-for':`203.0.113.${i}`}})));
  assert.equal(responses.filter(r=>r.status===401).length,5);assert.equal(responses.filter(r=>r.status===429).length,15);
  assert(responses.every(r=>!r.headers.has('set-cookie')));
  const row=a.sqlite.prepare('SELECT * FROM auth_login_limits').get();assert.match(row.source_key,/^[a-f0-9]{64}$/);assert.equal(row.attempts,6);
  assert.equal((await attempt(b.DB,{password:auth.ADMIN_PASSWORD})).status,429);
  assert.equal(a.sqlite.prepare('SELECT reset_at FROM auth_login_limits').get().reset_at,row.reset_at);
  // Another source is never account-locked by attempts against the same email.
  assert.equal((await attempt(a.DB,{ip:'192.0.2.2',password:auth.ADMIN_PASSWORD})).status,303);
  a.sqlite.prepare('UPDATE auth_login_limits SET reset_at=unixepoch()-1 WHERE source_key=?').run(row.source_key);
  const retry=await attempt(b.DB,{password:auth.ADMIN_PASSWORD});assert.equal(retry.status,303);assert.equal(retry.headers.get('location'),'/config?site=demo#units');
 }finally{a.close();b.close();rmSync(folder,{recursive:true,force:true});}
});
test('unknown sources cannot bypass by rotating forwarding headers; equivalent IPv6 shares a bucket',async()=>{
 const f=loginStore();try{
  for(let i=0;i<7;i++)assert.equal((await attempt(f.DB,{ip:'',headers:{'x-forwarded-for':`192.0.2.${i}`}})).status,i<5?401:429);
  assert.equal((await attempt(f.DB,{ip:'invalid-address'})).status,429);
  for(let i=0;i<5;i++)assert.equal((await attempt(f.DB,{ip:'2001:db8::1'})).status,401);
  assert.equal((await attempt(f.DB,{ip:'2001:0db8:0:0:0:0:0:1'})).status,429);
 }finally{f.close();}
});
test('missing DB, thrown DB, invalid schema and timeout fail closed with retry guidance',async()=>{
 const f=loginStore();try{
  f.sqlite.exec('CREATE TABLE auth_login_limits (unrecognized TEXT)');
  for(const DB of [undefined,{...f.DB,batch:async()=>{throw Error('outage');}},f.DB,{...f.DB,batch:async()=>[]}]){
   const response=await attempt(DB,{password:auth.ADMIN_PASSWORD});assert.equal(response.status,503);assert.equal(response.headers.get('retry-after'),'30');assert.equal(response.headers.get('set-cookie'),null);
   const html=await response.text();assert.match(html,/temporarily unavailable/);assert.match(html,/value="admin@example.invalid"/);assert.match(html,/name="next" value="\/config\?site=demo#units"/);assert(!html.includes(auth.ADMIN_PASSWORD));
  }
  const response=await attempt({...f.DB,batch:()=>new Promise(()=>{})});assert.equal(response.status,503);
 }finally{f.close();}
});
test('blocked form preserves escaped email/internal next, keeps password empty and exposes Retry-After',async()=>{
 const f=loginStore();try{
  for(let i=0;i<5;i++)await attempt(f.DB);
  const r=await attempt(f.DB,{email:'a"@example.invalid',password:auth.ADMIN_PASSWORD});assert.equal(r.status,429);assert(+r.headers.get('retry-after')<=60);
  const html=await r.text();assert.match(html,/a&quot;@example.invalid/);assert.match(html,/Try again in \d+ seconds/);assert(!html.includes(auth.ADMIN_PASSWORD));assert(!html.includes('type="submit" disabled'));
 }finally{f.close();}
});
test('audit actor is internal request metadata; arbitrary identity headers are ignored',()=>{
 const request=new Request(origin,{headers:{'x-user-email':'attacker@example.invalid','cf-access-authenticated-user-email':'owner@example.invalid'}});
 assert.equal(getActor(request),'system');const trusted=withAuthenticatedActor(request,'admin@example.invalid');assert.equal(getActor(trusted),'admin@example.invalid');assert.equal(trusted.headers.get('cf-access-authenticated-user-email'),null);assert.equal(trusted.headers.get('x-user-email'),'admin@example.invalid');assert.equal(getActor(new Request(trusted)),'system');
});

test('an existing verified session does not depend on limiter database availability',async()=>{
 const f=loginStore();try{const r=await attempt(f.DB,{password:auth.ADMIN_PASSWORD});const request=new Request(origin,{headers:{cookie:r.headers.get('set-cookie').split(';')[0]}});assert.deepEqual(await getAuthenticatedUser(request,auth),{email:auth.ADMIN_EMAIL});}finally{f.close();}
});
