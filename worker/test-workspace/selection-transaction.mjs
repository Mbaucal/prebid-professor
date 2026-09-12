import { assertWorkspaceSiteScope } from './site-draft.mjs';
/** MBA-54: internal TEST-only compare-and-swap. No HTTP route, initialization,
 * migrations, R2 access or production fallback. The authenticated service supplies
 * its own saved snapshot and the validated selection planner's configJson.
 * Compare every readPreviewSnapshot projection INSIDE the write transaction.
 */
const SITE = 'test-site';
const MAX_BYTES = 1024 * 1024;
const specs = [
  ['site', 'publishers', ['id','name','domain','gam_path'], 'id = ? LIMIT 1', true],
  ['config', 'publisher_configs', ['config_json'], 'publisher_id = ? LIMIT 1', true],
  ['units', 'ad_units', ['code','type','media_type','size_map_key','enabled','sort_order'], 'publisher_id = ? ORDER BY sort_order, code'],
  ['bidders', 'bidders', ['bidder','params_json','enabled'], 'publisher_id = ? ORDER BY bidder'],
  ['overrides', 'bidder_overrides', ['bidder','scope_type','scope_key','params_json','enabled'], 'publisher_id = ? ORDER BY bidder, scope_type, scope_key'],
  ['maps', 'size_maps', ['name','map_json'], 'publisher_id = ? ORDER BY name'],
  ['rules', 'unit_rules', ['rule_key','rule_json'], 'publisher_id = ? ORDER BY rule_key'],
  ['prebidBuilds', 'prebid_builds', ['id','publisher_id','version','file_key','modules_json','status','uploaded_at'], "publisher_id = ? AND status = 'current' ORDER BY uploaded_at DESC, id LIMIT 2"],
];
export class SelectionWriteError extends Error {
  constructor(code, message, status = 422) { super(message); this.name = 'SelectionWriteError'; this.code = code; this.status = status; }
}
const fail = (code,message,status) => { throw new SelectionWriteError(code,message,status); };
function own(value,key) {
  const property = value && Object.getOwnPropertyDescriptor(value,key);
  if (!property || !Object.hasOwn(property,'value') || !property.enumerable) fail('invalid_snapshot','A complete saved TEST snapshot is required.');
  return property.value;
}
function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [null,Object.prototype].includes(Object.getPrototypeOf(value)) && Object.getOwnPropertySymbols(value).length === 0;
}
export function reviewedProjections(snapshot) {
  if (!plain(snapshot) || Object.keys(snapshot).sort().join('|') !== specs.map(([key])=>key).sort().join('|')) {
    fail('invalid_snapshot','Use the complete server-read TEST snapshot, including Prebid records.');
  }
  const result = [];
  for (const [key,table,columns,where,single] of specs) {
    const value = own(snapshot,key);
    const rows = single ? [value] : value;
    if (!Array.isArray(rows) || rows.length > 1000) fail('invalid_snapshot','Saved TEST settings exceed this editor scope.');
    const values = Array.from(rows, (row) => {
      if (!plain(row) || Object.keys(row).sort().join('|') !== [...columns].sort().join('|')) fail('invalid_snapshot','Saved TEST fields do not match the reviewed schema.');
      return columns.map((column)=>{
        const cell = own(row,column);
        if (cell !== null && typeof cell !== 'string' && !Number.isSafeInteger(cell)) fail('invalid_snapshot','Saved TEST fields have unsupported values.');
        return cell;
      });
    });
    result.push({ json:JSON.stringify(values),
      sql:`(SELECT json_group_array(json_array(${columns.join(',')})) FROM (SELECT ${columns.join(',')} FROM ${table} WHERE ${where})) = ?` });
  }
  try { assertWorkspaceSiteScope(snapshot); } catch { fail('test_site_required','Only the isolated approved TEST draft can be edited.'); }
  if (new TextEncoder().encode(result.map((row)=>row.json).join('')).byteLength > MAX_BYTES) fail('invalid_snapshot','Saved TEST settings are too large.');
  return result;
}

export async function commitTestRuntimeSelection(store,{snapshot,configJson,actor}) {
  // All caller-owned primitive/row values are captured before the first await.
  const projections = reviewedProjections(snapshot);
  const original = own(snapshot.config,'config_json');
  if (typeof configJson !== 'string' || !configJson.length || new TextEncoder().encode(configJson).byteLength > MAX_BYTES) fail('invalid_config','A validated TEST configuration is required.');
  let config;
  try { config = JSON.parse(configJson); } catch { fail('invalid_config','A validated TEST configuration is required.'); }
  if (!plain(config) || config.enablePrebid !== false) fail('test_mode_required','This first TEST editor remains GPT-only.');
  if (typeof actor !== 'string' || !actor.trim() || actor.length > 320 || /[\r\n]/.test(actor)) fail('actor_required','An authenticated TEST actor is required.');
  if (store?.isolation !== 'explicit-test-store' || !store.db || typeof store.db.withSession !== 'function') fail('test_store_required','An explicit isolated TEST store is required.');
  const db = store.db.withSession('first-primary');
  if (!db || typeof db.prepare !== 'function' || typeof db.batch !== 'function') fail('test_store_required','TEST storage is unavailable.',503);
  const id = crypto.randomUUID(), afterId = crypto.randomUUID();
  const params = [id];
  for (const row of projections) params.push(SITE,row.json);
  const statements = [db.prepare(`INSERT INTO builtin_draft_assertions (id,valid) VALUES (?,CASE WHEN (${projections.map((row)=>row.sql).join(' AND ')}) THEN 1 ELSE 0 END)`).bind(...params)];
  const changed = original !== configJson;
  if (changed) {
    statements.push(db.prepare("UPDATE publisher_configs SET config_json=?,config_hash=NULL,updated_at=? WHERE publisher_id=?").bind(configJson,new Date().toISOString(),SITE));
    statements.push(db.prepare('INSERT INTO builtin_draft_assertions (id,valid) VALUES (?,CASE WHEN changes()=1 THEN 1 ELSE 0 END)').bind(afterId));
    statements.push(db.prepare('INSERT INTO audit_log (id,actor,action,publisher_id,details_json) VALUES (?,?,?,?,?)')
      .bind(crypto.randomUUID(),actor,'test_workspace.runtime_selected',SITE,JSON.stringify({testOnly:true,kind:'runtime-selection'})));
  }
  statements.push(db.prepare('DELETE FROM builtin_draft_assertions WHERE id IN (?,?)').bind(id,afterId));
  try {
    const result = await db.batch(statements);
    if (!Array.isArray(result) || result.length !== statements.length || result.some((row)=>row.success !== true)) throw Error('Unconfirmed write');
  } catch(error) {
    const text = [error?.message,error?.cause?.message].filter((v)=>typeof v==='string').join(' ');
    if (/CHECK constraint failed:\s*valid\s*=\s*1/i.test(text)) {
      fail('configuration_changed','Settings changed in another tab. Reload saved settings before trying again.',409);
    }
    // A transport error can happen AFTER commit. Do not undo, retry blindly, or
    // claim nothing was saved. The client must read the current settings first.
    fail('save_unconfirmed','The save result could not be confirmed. Reload saved settings before trying again.',503);
  }
  return {persisted:true,changed,publishable:false};
}
