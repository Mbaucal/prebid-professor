import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {Miniflare} from 'miniflare';
const config=JSON.parse(await readFile('wrangler.jsonc','utf8')),origin='https://prebid-professor.mbaucal.workers.dev';
const directory=await mkdtemp(join(tmpdir(),'tessera-organization-'));
const email='agency-fixture@example.invalid',password=randomBytes(24).toString('hex');
const mf=new Miniflare({modules:true,script:await readFile('dist/prebid_professor/index.js','utf8'),compatibilityDate:config.compatibility_date,compatibilityFlags:config.compatibility_flags??[],cf:false,host:'127.0.0.1',port:0,resourcePersistencePath:directory,bindings:{...config.vars,ADMIN_EMAIL:email,ADMIN_PASSWORD:password,SESSION_SECRET:randomBytes(48).toString('hex')},d1Databases:{DB:'local-agencies'},r2Buckets:{BUILDS:'local-unused'},outboundService:()=>{throw Error('No outbound requests permitted.');}});
try{
  const db=await mf.getD1Database('DB');await db.prepare('CREATE TABLE publisher_accounts(id TEXT PRIMARY KEY,created_at TEXT NOT NULL)').run();await db.prepare("INSERT INTO publisher_accounts VALUES ('example-publisher','fixture')").run();
  assert.equal((await mf.dispatchFetch(origin+'/api/organization')).status,401);
  const login=await mf.dispatchFetch(origin+'/api/auth/login',{method:'POST',redirect:'manual',headers:{origin,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({email,password}).toString()});assert.equal(login.status,303);const cookie=login.headers.get('set-cookie').split(';')[0];
  const call=(path,body,from=origin)=>mf.dispatchFetch(origin+'/api/organization'+path,{method:body?'POST':'GET',headers:{cookie,origin:from,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  assert.equal((await call('/agencies',{name:'Rejected',logo:null},'https://evil.example')).status,403);
  const create=await call('/agencies',{name:'Example Agency',logo:null});assert.equal(create.status,201);const id=(await create.json()).agencies[0].id;
  assert.equal((await call('/publishers/example-publisher/agency',{agencyId:id,expectedRevision:0})).status,200);
  assert.equal((await call('/publishers/example-publisher/agency',{agencyId:null,expectedRevision:0})).status,409);
  assert.equal((await (await call('')).json()).memberships[0].agencyId,id);
  assert.equal((await db.prepare('SELECT actor FROM organization_events LIMIT 1').first()).actor,email);
  console.log('PASS: compiled production Worker session/Origin checks and real D1 agency create/assign/CAS/audit');
}finally{await mf.dispose();await rm(directory,{recursive:true,force:true});}
