import {WorkspaceError,TEST_SITE,jsonBody} from './boundary.mjs';
import {sha256} from '../runtime/prebid-artifact-check.mjs';

const idPattern=/^builtin-draft-[a-f0-9]{64}$/;
const names=new Set(['README.txt','ads.js','ads.min.js','config.json','div-export.csv','implementation.html','manifest.json','min-height.css','sticky.css','prebid.js','gam-reporting.json','deals-plan.json']);
const check=(ok,message)=>{if(!ok)throw new WorkspaceError(409,message);};
const deletionId=id=>`test-cleanup-${id}`;
const finishedId=id=>`test-cleanup-files-${id}`;
const prefix=id=>`publishers/${TEST_SITE}/releases/${id}/`;
const digest=value=>sha256(new TextEncoder().encode(JSON.stringify(value)));
async function inventory(env){
 const db=env.DB.withSession('first-primary');
 const rows=(await db.prepare('SELECT * FROM builtin_draft_uploads ORDER BY release_id').all()).results;
 check(rows.length<=20&&rows.every(r=>r.publisher_id===TEST_SITE&&idPattern.test(r.release_id)),'Unexpected TEST package inventory.');
 const eligible=[];
 for(const row of rows){
  if(row.state!=='stored')continue; // A running or interrupted upload is never removed by this action.
  const d=JSON.parse(row.descriptor_json);
  check(d.siteId===TEST_SITE&&d.releaseId===row.release_id&&d.packageSha256===row.package_sha256&&row.release_id==='builtin-draft-'+d.packageSha256&&d.kind==='builtin-stored-draft'&&d.completeRelease===false,'Stored package identity differs.');
  check(Array.isArray(d.files)&&d.files.length>=9&&d.files.length<=12&&new Set(d.files.map(f=>f.name)).size===d.files.length&&d.files.every(f=>names.has(f.name)),'Stored package file inventory differs.');
  check(await digest({siteId:TEST_SITE,inventory:d.files})===d.packageSha256,'Stored package checksum differs.');
  const release=await db.prepare('SELECT r.*,p.current_release_id FROM releases r JOIN publishers p ON p.id=r.publisher_id WHERE r.id=? AND r.publisher_id=?').bind(row.release_id,TEST_SITE).first();
  check(release?.status==='draft'&&release.published_at===null&&release.current_release_id!==row.release_id,'An active package cannot be removed.');
  eligible.push({row,keys:d.files.map(f=>prefix(row.release_id)+f.name)});
 }
 const pending=(await db.prepare(`SELECT a.* FROM audit_log a WHERE a.publisher_id=? AND a.action='test_draft.deleted'
  AND NOT EXISTS (SELECT 1 FROM audit_log done WHERE done.id='test-cleanup-files-'||a.entity_id) ORDER BY a.id`).bind(TEST_SITE).all()).results;
 return {eligible,pending,state:{count:rows.length,limit:20,deletable:eligible.length,protectedCount:rows.length-eligible.length,pending:pending.length,revision:await digest(rows)}};
}
export async function cleanupState(env){return (await inventory(env)).state;}
export async function clearPackages(env,actor,body){
 check(body.acknowledge===true&&typeof body.revision==='string','Confirm deletion of the displayed TEST packages.');
 const current=await inventory(env);
 check(body.revision===current.state.revision,'The package list changed. Reload releases before deleting.');
 const db=env.DB.withSession('first-primary'),writes=[],now=new Date().toISOString();
 for(const {row,keys} of current.eligible){
  const assertion=crypto.randomUUID();
  writes.push(db.prepare(`INSERT INTO builtin_draft_assertions (id,valid) VALUES (?,CASE WHEN EXISTS (
   SELECT 1 FROM builtin_draft_uploads u JOIN releases r ON r.id=u.release_id AND r.publisher_id=u.publisher_id JOIN publishers p ON p.id=u.publisher_id
   WHERE u.release_id=? AND u.publisher_id=? AND u.descriptor_json=? AND u.state='stored' AND r.status='draft' AND r.published_at IS NULL
   AND (p.current_release_id IS NULL OR p.current_release_id<>u.release_id)) THEN 1 ELSE 0 END)`).bind(assertion,row.release_id,TEST_SITE,row.descriptor_json));
  // The audit entry is also a tombstone: an old Save retry cannot resurrect this ID.
  writes.push(db.prepare(`INSERT INTO audit_log (id,actor,action,publisher_id,entity_type,entity_id,details_json,created_at)
   VALUES (?,?,'test_draft.deleted',?,'release',?,?,?)`).bind(deletionId(row.release_id),actor,TEST_SITE,row.release_id,JSON.stringify({keys,packageSha256:row.package_sha256}),now));
  writes.push(db.prepare('DELETE FROM releases WHERE id=? AND publisher_id=?').bind(row.release_id,TEST_SITE));
  writes.push(db.prepare('DELETE FROM builtin_draft_uploads WHERE release_id=? AND publisher_id=?').bind(row.release_id,TEST_SITE));
  writes.push(db.prepare('DELETE FROM builtin_draft_assertions WHERE id=?').bind(assertion));
 }
 if(writes.length)await db.batch(writes);
 // A storage failure leaves an auditable retry queue, while the quota is freed.
 const pending=(await inventory(env)).pending;
 for(const item of pending){
  try{
   check(idPattern.test(item.entity_id),'Invalid cleanup reference.');
   const {keys}=JSON.parse(item.details_json);
   check(Array.isArray(keys)&&keys.length>=9&&keys.length<=12&&keys.every(k=>k.startsWith(prefix(item.entity_id))&&names.has(k.slice(prefix(item.entity_id).length))),'Invalid cleanup file scope.');
   await env.BUILDS.delete(keys);
   check((await Promise.all(keys.map(k=>env.BUILDS.head(k)))).every(v=>v===null),'Some package files remain.');
   await db.prepare(`INSERT INTO audit_log (id,actor,action,publisher_id,entity_type,entity_id,details_json,created_at)
    VALUES (?,?,'test_draft.files_deleted',?,'release',?,'{}',?) ON CONFLICT(id) DO NOTHING`).bind(finishedId(item.entity_id),actor,TEST_SITE,item.entity_id,now).run();
  }catch{/* The next explicit cleanup retries the same exact keys. */}
 }
 return {deleted:current.eligible.length,...await cleanupState(env)};
}
export async function cleanupResponse(request,env,actor,headers){
 const json=(v,status=200)=>new Response(JSON.stringify(v),{status,headers:{...headers,'content-type':'application/json'}});
 if(request.method==='GET')return json(await cleanupState(env));
 if(request.method!=='POST')return json({error:'Method not allowed.'},405);
 return json(await clearPackages(env,actor,await jsonBody(request,['revision','acknowledge'])));
}
