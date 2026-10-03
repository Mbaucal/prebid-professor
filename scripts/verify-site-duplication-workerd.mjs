/** Actual compiled production Worker, ephemeral D1/R2 and synthetic identity. */
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {randomBytes,createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Miniflare} from 'miniflare';
const directory=await mkdtemp(join(tmpdir(),'site-copy-audit-'));
const origin='https://audit.example.invalid',email='audit@example.invalid',password=randomBytes(24).toString('hex');
const mf=new Miniflare({modules:true,script:await readFile('dist/prebid_professor/index.js','utf8'),compatibilityDate:'2026-07-15',compatibilityFlags:['nodejs_compat'],cf:false,
 host:'127.0.0.1',port:0,resourcePersistencePath:directory,d1Databases:{DB:'audit-d1'},r2Buckets:{BUILDS:'audit-r2'},
 bindings:{ADMIN_EMAIL:email,ADMIN_PASSWORD:password,SESSION_SECRET:randomBytes(48).toString('hex')},
 outboundService:()=>{throw Error('External traffic forbidden.');}});
const checks=[];const check=(name,value)=>{assert(value,name);checks.push({name,passed:true});};
try{
 const db=await mf.getD1Database('DB'),bucket=await mf.getR2Bucket('BUILDS');
 for(const [file,stop] of [['0001_initial.sql','INSERT OR IGNORE INTO publishers'],['0002_publisher_accounts.sql','-- Politika.rs']]){
  for(const statement of (await readFile('migrations/'+file,'utf8')).split(stop)[0].split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(statement).run();
 }
 const login=await mf.dispatchFetch(origin+'/api/auth/login',{method:'POST',redirect:'manual',headers:{origin,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({email,password})});
 assert.equal(login.status,303);const cookie=login.headers.get('set-cookie').split(';')[0];
 const call=(path,body,method=body?'POST':'GET',extra={})=>mf.dispatchFetch(origin+path,{method,headers:{cookie,origin,'content-type':'application/json',...extra},...(body?{body:JSON.stringify(body)}:{})});
 check('Create source through authenticated production route',(await call('/api/sites',{id:'source',name:'Source',domain:'source.example.invalid',gamPath:'/123/source/'})).status===201);
 await db.prepare("INSERT INTO ad_units(id,publisher_id,code,type,media_type,size_map_key) VALUES('u','source','Billboard','ATF','banner','Billboard')").run();
 await db.prepare("INSERT INTO size_maps(id,publisher_id,name,map_json) VALUES('m','source','Billboard',?)").bind(JSON.stringify([{minViewPort:[0,0],sizes:[[300,250]]}])).run();
 const modules=['consentManagementTcf','currency','priceFloors','tcfControl'],bytes=new TextEncoder().encode('/* prebid.js v11.34.0\nModules: '+modules.join(', ')+' */\nwindow.pbjs=window.pbjs||{};');
 const key='publishers/source/prebid-builds/original/prebid.js';
 await bucket.put(key,bytes,{customMetadata:{sha256:createHash('sha256').update(bytes).digest('hex'),version:'11.34.0'}});
 await db.prepare("INSERT INTO prebid_builds(id,publisher_id,version,file_key,modules_json,status) VALUES('original','source','11.34.0',?,?,'current')").bind(key,JSON.stringify(modules)).run();
 const settingsPath='/api/publishers/source/builtin-site-settings',s=await(await call(settingsPath)).json();
 const selected=await call(settingsPath,{action:'setup',revision:s.revision,runtime:s.runtimes[0].pin,allowPreview:true,enablePrebid:true});
 assert.equal(selected.status,200,await selected.text());
 const response=await call('/api/sites/source/duplicate',{id:'copy',name:'Copy',domain:'copy.example.invalid',gamPath:'/123/copy/',copyPrebidBuild:true});
 assert.equal(response.status,201,await response.text());check('Duplicate commits with real D1 snapshot guard',true);
 const row=await db.prepare("SELECT * FROM prebid_builds WHERE publisher_id='copy'").first();
 check('Copy owns a separate native R2 object',row.file_key!==key&&Boolean(await bucket.get(row.file_key)));
 const copyConfig=JSON.parse((await db.prepare("SELECT config_json FROM publisher_configs WHERE publisher_id='copy'").first()).config_json);
 check('Copied selection points to its own build',copyConfig.builtinRuntimeSelection.prebid.id===row.id);
 const settings=await(await call('/api/publishers/copy/builtin-site-settings')).json();
 const bundle=await call('/api/publishers/copy/builtin-site-settings',{action:'bundle',revision:settings.revision,acknowledge:true});
 check('Copied site generates a complete bundle in compiled Worker',bundle.status===200&&(await bundle.arrayBuffer()).byteLength>1000);
 await db.prepare("UPDATE prebid_builds SET status='archived' WHERE id=?").bind(row.id).run();
 check('Delete copied file through authenticated route',(await call('/api/publishers/copy/prebid-builds/'+row.id,null,'DELETE',{'x-confirm-delete':row.id})).status===200);
 check('Original native R2 file survives',Boolean(await bucket.get(key)));
 check('Copied native R2 file is removed',!(await bucket.get(row.file_key)));
 await mkdir('.generated/audit-mba96',{recursive:true});
 await writeFile('.generated/audit-mba96/duplication-workerd.json',JSON.stringify({scope:'compiled production Worker + local native D1/R2; no hosted writes',checks,passed:checks.length,failed:0},null,2));
 console.log('PASS '+checks.length+' compiled Worker duplication checks');
}finally{await mf.dispose();await rm(directory,{recursive:true,force:true});}
