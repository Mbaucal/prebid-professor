import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {createAdsTxtVersion,listAdsTxtVersions} from '../../worker/ads-txt-versions.ts';
import {deleteSite} from '../../worker/publishers.ts';
const sql=new DatabaseSync(':memory:');
for(const file of readdirSync(new URL('../../migrations/',import.meta.url)).sort())sql.exec(readFileSync(new URL('../../migrations/'+file,import.meta.url),'utf8'));
const objects=new Map(),writes=[];let failDelete=false,deleteCalls=0,onDelete=null,onPut=null,failCompensation=false,failMetadata=false,lostResponse=false,beforeBatch=null;
const DB={prepare(query){const make=args=>({query,args,bind(...values){return make(values)},async run(){writes.push(query);if(failMetadata && /INSERT INTO ads_txt_versions/.test(query))throw Error('Metadata unavailable');return {meta:{changes:sql.prepare(query).run(...args).changes}}},async all(){return {results:sql.prepare(query).all(...args)}},async first(){return sql.prepare(query).get(...args)??null}});return make([])},async batch(items){beforeBatch?.(items);sql.exec('BEGIN');try{const result=[];for(const item of items)result.push(await item.run());sql.exec('COMMIT');if(lostResponse && items.some(item=>/INSERT INTO ads_txt_versions/.test(item.query))){lostResponse=false;throw Error('Response lost after commit')}return result}catch(e){try{sql.exec('ROLLBACK')}catch{}throw e}}};
const env={DB,BUILDS:{async put(key,content){writes.push('R2.put');objects.set(key,content);await onPut?.()},async get(key){return objects.has(key)?{text:async()=>objects.get(key)}:null},async delete(key){if(failCompensation)throw Error('Compensation unavailable');if(failDelete && ++deleteCalls===3)throw Error('R2 unavailable');objects.delete(key);onDelete?.()}}};
const request=body=>new Request('https://fixture.invalid/api/publishers/site-a/ads-txt/versions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
const count=()=>sql.prepare('SELECT COUNT(*) n FROM ads_txt_versions').get().n;
async function current(){return (await (await listAdsTxtVersions(env,'site-a')).json()).currentFile.checksum}
sql.exec("INSERT INTO publisher_accounts(id,name,status) VALUES('owner','Owner','active'); INSERT INTO publishers(id,name,domain,gam_path,publisher_account_id) VALUES('site-a','A','a.invalid','/123/','owner')");
await listAdsTxtVersions(env,'site-a');
sql.exec("INSERT INTO ads_txt_requirement_sources(id,publisher_id,source_label,entry,monitor_entry,canonical_entry,required,sort_order,created_at,updated_at) VALUES('row','site-a','','example.com, 1, DIRECT','example.com, 1, DIRECT','example.com, 1, DIRECT',1,0,'now','now')");
test('reviewed checksum rejects missing/stale before snapshot or metadata writes',async()=>{
 const reviewed=await current();sql.exec("UPDATE ads_txt_requirement_sources SET entry='example.com, 2, DIRECT'");
 for(const [body,status] of [[{},428],[{expectedChecksum:reviewed},409]]){writes.length=0;const response=await createAdsTxtVersion(request(body),env,'site-a');assert.equal(response.status,status);assert.equal(count(),0);assert.equal(objects.size,0);assert.equal(writes.filter(q=>q==='R2.put'||/INSERT INTO ads_txt_versions/.test(q)).length,0)}
 const latest=await current();assert.notEqual(latest,reviewed);assert.equal((await createAdsTxtVersion(request({expectedChecksum:latest}),env,'site-a')).status,201);assert.equal(count(),1);
 assert.equal((await (await createAdsTxtVersion(request({expectedChecksum:latest}),env,'site-a')).json()).created,false);assert.equal(count(),1);
});
test('matching version is found beyond fifty displayed records',async()=>{
 const checksum=await current();const row=sql.prepare('SELECT * FROM ads_txt_versions').get();
 const fields=Object.keys(row);const insert=sql.prepare(`INSERT INTO ads_txt_versions(${fields.join(',')}) VALUES(${fields.map(()=>'?').join(',')})`);
 for(let i=2;i<=55;i++){const copy={...row,id:'version-'+i,version_number:i,object_key:'snapshot-'+i,checksum:'checksum-'+i};insert.run(...fields.map(f=>copy[f]));objects.set(copy.object_key,'old')}
 const payload=await (await listAdsTxtVersions(env,'site-a')).json();assert.equal(payload.totalVersions,55);assert.equal(payload.versions.length,50);assert.equal(payload.currentVersion.checksum,checksum);assert.equal(payload.currentVersion.versionNumber,1);
});
test('site deletion cleanup survives R2 failure and a retry',async()=>{
 failDelete=true;const first=await deleteSite(new Request('https://fixture.invalid',{method:'DELETE'}),env,'site-a');assert.equal(first.status,503);assert.equal(objects.size,53);assert.equal(count(),55);assert.ok(sql.prepare("SELECT id FROM publishers WHERE id='site-a'").get());
 failDelete=false;onDelete=()=>{onDelete=null;const row=sql.prepare('SELECT * FROM ads_txt_versions LIMIT 1').get();const fields=Object.keys(row);const copy={...row,id:'racing-version',version_number:56,object_key:'racing-snapshot',checksum:'racing-checksum'};sql.prepare(`INSERT INTO ads_txt_versions(${fields.join(',')}) VALUES(${fields.map(()=>'?').join(',')})`).run(...fields.map(f=>copy[f]));objects.set(copy.object_key,'racing snapshot')};
 const raced=await deleteSite(new Request('https://fixture.invalid',{method:'DELETE'}),env,'site-a');assert.equal(raced.status,409);assert.equal(count(),56);assert.equal(objects.size,1);assert.equal(sql.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='site.deleted'").get().n,0);
 const second=await deleteSite(new Request('https://fixture.invalid',{method:'DELETE'}),env,'site-a');assert.equal(second.status,200);assert.equal(objects.size,0);assert.equal(count(),0);
});

test('durable intent blocks in-flight deletion and survives failed compensation',async()=>{
 sql.exec("INSERT INTO publishers(id,name,domain,gam_path,publisher_account_id) VALUES('site-a','A','a.invalid','/123/','owner'); INSERT INTO ads_txt_requirement_sources(id,publisher_id,source_label,entry,monitor_entry,canonical_entry,required,sort_order,created_at,updated_at) VALUES('new-row','site-a','','example.com, 3, DIRECT','example.com, 3, DIRECT','example.com, 3, DIRECT',1,0,'now','now')");
 const checksum=await current();
 onPut=async()=>{onPut=null;assert.equal(sql.prepare("SELECT state FROM ads_txt_version_intents WHERE site_id='site-a'").get().state,'writing');assert.equal((await deleteSite(new Request('https://fixture.invalid',{method:'DELETE'}),env,'site-a')).status,409);failMetadata=true;failCompensation=true};
 const response=await createAdsTxtVersion(request({expectedChecksum:checksum}),env,'site-a');
 assert.equal(response.status,503);assert.equal(count(),0);assert.equal(objects.size,1);
 assert.equal(sql.prepare("SELECT state FROM ads_txt_version_intents WHERE site_id='site-a'").get().state,'cleanup');
 // Retry sees the durable key even if a separately removed site's FK rows are gone.
 sql.exec("DELETE FROM publishers WHERE id='site-a'");
 failMetadata=false;failCompensation=false;
 assert.equal((await deleteSite(new Request('https://fixture.invalid',{method:'DELETE'}),env,'site-a')).status,200);
 assert.equal(objects.size,0);assert.equal(sql.prepare('SELECT COUNT(*) n FROM ads_txt_version_intents').get().n,0);
});

test('new writing intent during snapshot cleanup blocks final cascade',async()=>{
 sql.exec("INSERT INTO publishers(id,name,domain,gam_path,publisher_account_id) VALUES('site-a','A','a.invalid','/123/','owner'); INSERT INTO ads_txt_requirement_sources(id,publisher_id,source_label,entry,monitor_entry,canonical_entry,required,sort_order,created_at,updated_at) VALUES('last-row','site-a','','example.com, 4, DIRECT','example.com, 4, DIRECT','example.com, 4, DIRECT',1,0,'now','now')");
 assert.equal((await createAdsTxtVersion(request({expectedChecksum:await current()}),env,'site-a')).status,201);
 assert.equal(sql.prepare('SELECT COUNT(*) n FROM ads_txt_version_intents').get().n,0);
 onDelete=()=>{onDelete=null;sql.exec("INSERT INTO ads_txt_version_intents VALUES('held','site-a','held-object','writing','now')")};
 assert.equal((await deleteSite(new Request('https://fixture.invalid',{method:'DELETE'}),env,'site-a')).status,409);
 assert.ok(sql.prepare("SELECT id FROM publishers WHERE id='site-a'").get());
 assert.equal((await deleteSite(new Request('https://fixture.invalid',{method:'DELETE'}),env,'site-a')).status,409);
 // Explicit fixture owner resolution, not a product timeout/reaper.
 sql.exec("UPDATE ads_txt_version_intents SET state='cleanup' WHERE id='held'");
 assert.equal((await deleteSite(new Request('https://fixture.invalid',{method:'DELETE'}),env,'site-a')).status,200);
});

test('lost metadata commit response retains registered file and removes intent atomically',async()=>{
 sql.exec("INSERT INTO publishers(id,name,domain,gam_path,publisher_account_id) VALUES('site-a','A','a.invalid','/123/','owner'); INSERT INTO ads_txt_requirement_sources(id,publisher_id,source_label,entry,monitor_entry,canonical_entry,required,sort_order,created_at,updated_at) VALUES('commit-row','site-a','','example.com, 5, DIRECT','example.com, 5, DIRECT','example.com, 5, DIRECT',1,0,'now','now')");
 lostResponse=true;
 const response=await createAdsTxtVersion(request({expectedChecksum:await current()}),env,'site-a');assert.equal(response.status,200);assert.equal(count(),1);assert.equal(objects.size,1);assert.equal(sql.prepare('SELECT COUNT(*) n FROM ads_txt_version_intents').get().n,0);
});

test('parallel deletion of an empty site does not write a second deletion audit',async()=>{
 await deleteSite(new Request('https://fixture.invalid',{method:'DELETE'}),env,'site-a');
 sql.exec("INSERT INTO publishers(id,name,domain,gam_path,publisher_account_id) VALUES('site-a','A','a.invalid','/123/','owner')");
 const before=sql.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='site.deleted'").get().n;
 beforeBatch=items=>{if(items.some(item=>item.query.includes("'site.deleted'"))){beforeBatch=null;sql.exec("DELETE FROM publishers WHERE id='site-a'")}};
 assert.equal((await deleteSite(new Request('https://fixture.invalid',{method:'DELETE'}),env,'site-a')).status,409);
 assert.equal(sql.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='site.deleted'").get().n,before);
});

test('version wrapper retains authoritative authentication and mutation origin checks',async()=>{
 const {default:app}=await import('../../worker/app-ads-txt-versions.ts');
 const {createHmac}=await import('node:crypto');
 const secret='fixture-only-session-secret-12345678901234567890',email='fixture@example.invalid';
 const now=Math.floor(Date.now()/1000),payload=Buffer.from(JSON.stringify({version:1,email,issuedAt:now,expiresAt:now+100})).toString('base64url');
 const cookie='__Host-pp_session='+payload+'.'+createHmac('sha256',secret).update(payload).digest('base64url');
 const authEnv={...env,ADMIN_EMAIL:email,ADMIN_PASSWORD:'fixture-password-only',SESSION_SECRET:secret};
 const url='https://fixture.invalid/api/publishers/site-a/ads-txt/versions';
 assert.equal((await app.fetch(new Request(url),authEnv,{})).status,401);
 for(const origin of ['null','https://foreign.invalid'])assert.equal((await app.fetch(new Request(url,{method:'POST',headers:{cookie,origin,'sec-fetch-site':'same-origin'},body:'{}'}),authEnv,{})).status,403);
 assert.equal((await app.fetch(new Request(url,{method:'PUT',headers:{cookie,origin:'https://fixture.invalid'}}),authEnv,{})).status,405);
});
