/** One D1 transaction for a reviewed TEST site copy, its positions/maps and audit.
 * No schema changes, production fallback, publication, R2 write or file deletion.
 */
import { reviewedProjections, SelectionWriteError } from './selection-transaction.mjs';
import { readSiteDraft } from './site-draft.mjs';
import { TEST_SITE } from './boundary.mjs';
const error=(code,message,status=422)=>{throw new SelectionWriteError(code,message,status);};
export async function commitSiteDraft(store,plan,actor) {
  const before=reviewedProjections(plan.before),after=reviewedProjections(plan.after);
  readSiteDraft(plan.after);
  if(typeof actor!=='string'||!actor.trim()||actor.length>320||/[\r\n]/.test(actor))error('actor_required','An authenticated TEST actor is required.');
  if(store?.isolation!=='explicit-test-store'||typeof store.db?.withSession!=='function')error('test_store_required','An isolated TEST store is required.');
  const db=store.db.withSession('first-primary'),stamp=new Date().toISOString(),id=crypto.randomUUID(),afterId=crypto.randomUUID();
  const assertion=(key,rows)=>db.prepare(`INSERT INTO builtin_draft_assertions(id,valid) VALUES (?,CASE WHEN (${rows.map((r)=>r.sql).join(' AND ')}) THEN 1 ELSE 0 END)`)
    .bind(key,...rows.flatMap((r)=>[TEST_SITE,r.json]));
  const statements=[assertion(id,before)];
  const changed=before.some((row,index)=>row.json!==after[index].json);
  if(changed) {
    const site=plan.after.site,config=plan.after.config.config_json;
    const units=JSON.stringify(plan.after.units.map((u)=>({...u,id:crypto.randomUUID()})));
    const maps=JSON.stringify(plan.after.maps.map((m)=>({...m,id:crypto.randomUUID()})));
    statements.push(db.prepare('UPDATE publishers SET name=?,domain=?,gam_path=?,updated_at=? WHERE id=?').bind(site.name,site.domain,site.gam_path,stamp,TEST_SITE));
    statements.push(db.prepare('UPDATE publisher_configs SET config_json=?,config_hash=NULL,updated_at=? WHERE publisher_id=?').bind(config,stamp,TEST_SITE));
    // Bulk JSON input keeps query count constant even for a full publisher layout.
    statements.push(db.prepare(`INSERT INTO size_maps(id,publisher_id,name,map_json)
      SELECT json_extract(value,'$.id'),?,json_extract(value,'$.name'),json_extract(value,'$.map_json') FROM json_each(?) WHERE 1
      ON CONFLICT(publisher_id,name) DO UPDATE SET map_json=excluded.map_json,updated_at=?`).bind(TEST_SITE,maps,stamp));
    statements.push(db.prepare(`INSERT INTO ad_units(id,publisher_id,code,type,media_type,size_map_key,enabled,sort_order)
      SELECT json_extract(value,'$.id'),?,json_extract(value,'$.code'),json_extract(value,'$.type'),json_extract(value,'$.media_type'),
      json_extract(value,'$.size_map_key'),json_extract(value,'$.enabled'),json_extract(value,'$.sort_order') FROM json_each(?) WHERE 1
      ON CONFLICT(publisher_id,code) DO UPDATE SET type=excluded.type,media_type=excluded.media_type,size_map_key=excluded.size_map_key,
      enabled=excluded.enabled,sort_order=excluded.sort_order,updated_at=?`).bind(TEST_SITE,units,stamp));
    statements.push(db.prepare("DELETE FROM ad_units WHERE publisher_id=? AND code NOT IN (SELECT json_extract(value,'$.code') FROM json_each(?))").bind(TEST_SITE,units));
    statements.push(db.prepare("DELETE FROM size_maps WHERE publisher_id=? AND name NOT IN (SELECT json_extract(value,'$.name') FROM json_each(?))").bind(TEST_SITE,maps));
    statements.push(assertion(afterId,after));
    statements.push(db.prepare('INSERT INTO audit_log(id,actor,action,publisher_id,details_json) VALUES (?,?,?,?,?)')
      .bind(crypto.randomUUID(),actor,'test_workspace.site_draft_saved',TEST_SITE,JSON.stringify({testOnly:true,positions:plan.after.units.length,maps:plan.after.maps.length,publishable:false})));
  }
  statements.push(db.prepare('DELETE FROM builtin_draft_assertions WHERE id IN (?,?)').bind(id,afterId));
  try{
    const result=await db.batch(statements);
    if(!Array.isArray(result)||result.length!==statements.length||result.some((r)=>r.success!==true))throw Error('Unconfirmed write');
  }catch(e){
    const detail=[e?.message,e?.cause?.message].filter((s)=>typeof s==='string').join(' ');
    if(/CHECK constraint failed:\s*valid\s*=\s*1/i.test(detail))error('configuration_changed','Settings changed in another tab. Reload saved settings before trying again.',409);
    error('save_unconfirmed','The save result could not be confirmed. Reload saved settings before trying again.',503);
  }
  return {persisted:true,changed,publishable:false};
}
