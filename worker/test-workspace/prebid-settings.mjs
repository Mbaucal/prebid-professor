import { runtimeCatalog, descriptorForPin, previewInput, prepareSiteRuntimeSelection, readPinnedSiteRuntime } from './runtime-catalog.mjs';
/** Authenticated TEST configuration service. No live endpoints or ad execution. */
import { readPreviewSnapshot } from '../runtime/builtin-preview-service.mjs';
import { RuntimeSelectionError } from '../runtime/site-runtime-selection.mjs';
import { prebidRequirements } from '../runtime/prebid-artifact-check.mjs';
import { digest } from '../runtime/preview-snapshot.mjs';
import { WorkspaceError, TEST_SITE } from './boundary.mjs';
import { assertWorkspaceSiteScope } from './site-draft.mjs';
import { reviewedProjections, SelectionWriteError } from './selection-transaction.mjs';
import { listPrebidFiles, readPrebidFile } from './prebid-files.mjs';
import { fields, normalizePrebidDraft, SUPPORTED_BIDDERS } from './prebid-draft.mjs';
import { makePrebidPlan, publicPlan, planOptions, USER_IDS } from './prebid-plan.mjs';
export const prebidStore = (env) => ({isolation:'explicit-test-store', db:env.DB, bucket:env.BUILDS});
export async function prebidSnapshot(env) {
  const snapshot = await readPreviewSnapshot(env.DB.withSession('first-primary'), TEST_SITE, {includePrebid:true});
  const config = assertWorkspaceSiteScope(snapshot);
  if (!config.builtinRuntimeSelection?.runtime) throw new WorkspaceError(409, 'Save an exact script version first.');
  return {snapshot,config};
}
function editorDraft(snapshot, config) {
  return {enablePrebid:config.enablePrebid,buildId:snapshot.prebidBuilds[0]?.id ?? null,
    bidders:snapshot.bidders.map((b)=>({bidder:b.bidder,params:JSON.parse(b.params_json),enabled:b.enabled===1})),
    overrides:snapshot.overrides.map((o)=>({bidder:o.bidder,scopeType:o.scope_type,scopeKey:o.scope_key,params:JSON.parse(o.params_json),enabled:o.enabled===1}))};
}
export async function getPrebidSettings(env) {
  const {snapshot,config} = await prebidSnapshot(env);
  let validationIssue = null;
  try { await readPinnedSiteRuntime({siteId:TEST_SITE,snapshot,catalog:runtimeCatalog},env.BUILDS); }
  catch(error) { if (!(error instanceof RuntimeSelectionError)) throw error; validationIssue=error.message; }
  const input=previewInput(snapshot,descriptorForPin(config.builtinRuntimeSelection.runtime),'20000101_000000');
  return {site:{id:TEST_SITE,name:snapshot.site.name},revision:await digest(snapshot),draft:editorDraft(snapshot,config),
    files:await listPrebidFiles(prebidStore(env)),supportedBidders:SUPPORTED_BIDDERS,
    units:snapshot.units.map((u)=>({code:u.code,enabled:u.enabled===1})),requiredModules:prebidRequirements(input,config).modules,
    plan:config.testPrebidPlan??null,options:planOptions(config),userIds:USER_IDS.map(({name,label})=>({name,label})),
    version:snapshot.prebidBuilds[0]?.version??'11.11.0',
    validationIssue,publishable:false,notice:'File bytes and header declarations are checked. Partner parameters and actual ad delivery still need a staging test.'};
}
export async function prepareBuildPlan(env,body) {
  fields(body,['expectedRevision','draft','version','options'],'plan request');
  const {snapshot,config}=await prebidSnapshot(env);
  if(typeof body.expectedRevision!=='string'||await digest(snapshot)!==body.expectedRevision)throw new WorkspaceError(409,'Settings changed. Reload saved settings before preparing the build.');
  const plan=await makePrebidPlan(snapshot,config,{draft:body.draft,version:body.version,options:body.options});
  return {snapshot,config,plan};
}
export async function previewBuildPlan(env,body){return {...publicPlan((await prepareBuildPlan(env,body)).plan),persisted:false};}
export async function saveBuildPlan(env,actor,body){
  fields(body,['expectedRevision','acknowledge','draft','version','options'],'save plan request');
  if(body.acknowledge!==true)throw new WorkspaceError(422,'Confirm these are TEST settings.');
  const {acknowledge,...request}=body,{snapshot,config,plan}=await prepareBuildPlan(env,request);
  const after=structuredClone(snapshot);
  after.config.config_json=JSON.stringify({...config,testPrebidPlan:publicPlan(plan)});
  const result=await commitPrebidSettings(prebidStore(env),{before:snapshot,after,selectedRow:null,planOnly:true},actor);
  // Return exactly the committed revision, never rebase the form onto a later tab's edit.
  return {...result,revision:await digest(after),plan:publicPlan(plan),selectionChanged:false};
}
export async function preparePrebidSettings(env, body) {
  const withPlan=Object.hasOwn(body,'version')||Object.hasOwn(body,'options');
  fields(body,withPlan?['expectedRevision','acknowledge','draft','version','options']:['expectedRevision','acknowledge','draft'],'save request');
  if(body.acknowledge!==true)throw new WorkspaceError(422,'Confirm these are TEST settings.');
  const {snapshot:before,config}=await prebidSnapshot(env);
  if(typeof body.expectedRevision!=='string'||await digest(before)!==body.expectedRevision)throw new WorkspaceError(409,'Settings changed. Reload saved settings before saving.');
  if(config.testPrebidPlan&&!withPlan)throw new WorkspaceError(422,'Reload the updated Prebid form to retain the saved build preparation.');
  const draft=normalizePrebidDraft(body.draft,before.units);
  const buildPlan=withPlan?await makePrebidPlan(before,config,{draft,version:body.version,options:body.options}):null;
  const after=buildPlan?buildPlan.after:structuredClone(before);
  let selected=null;
  // OFF does not consume file bytes. Preserve the already-current record so an
  // unavailable/corrupt object cannot trap the user in enabled mode. Choosing a
  // different file still verifies it, even while OFF; ON always verifies bytes.
  if(!draft.enablePrebid && draft.buildId && draft.buildId===before.prebidBuilds[0]?.id)selected={row:structuredClone(before.prebidBuilds[0])};
  else if(draft.buildId)selected=await readPrebidFile(prebidStore(env),draft.buildId);
  else if(before.prebidBuilds.length)throw new WorkspaceError(422,'Keep the stored file selected when turning Prebid off. Uploaded files are retained.');
  if(draft.enablePrebid&&buildPlan&&selected.row.version!==buildPlan.version)throw new WorkspaceError(422,`Build version mismatch: the plan requires ${buildPlan.version}; the selected file is ${selected.row.version}. Return the file for the planned version or explicitly change the plan version.`);
  after.bidders=draft.bidders.map((b)=>({bidder:b.bidder,params_json:JSON.stringify(b.params),enabled:b.enabled?1:0}));
  after.overrides=draft.overrides.map((o)=>({bidder:o.bidder,scope_type:o.scopeType,scope_key:o.scopeKey,params_json:JSON.stringify(o.params),enabled:o.enabled?1:0}));
  after.prebidBuilds=selected?[{...selected.row,status:'current'}]:[];
  const next={...(buildPlan?buildPlan.config:config),enablePrebid:draft.enablePrebid,testPrebidDraft:{schemaVersion:1,candidateOnly:true}};
  delete next.testPrebidPlan;
  after.config.config_json=JSON.stringify(next);
  const planned=await prepareSiteRuntimeSelection({siteId:TEST_SITE,snapshot:after,catalog:runtimeCatalog,expectedRevision:await digest(after),
    selection:{runtime:config.builtinRuntimeSelection.runtime,allowPreview:true,enablePrebid:draft.enablePrebid,prebidBuildId:draft.enablePrebid?draft.buildId:null}},env.BUILDS);
  after.config.config_json=planned.configJson;
  return {before,after,selectedRow:selected?.row??null};
}
export async function commitPrebidSettings(store, plan, actor) {
  const before=reviewedProjections(plan.before),after=reviewedProjections(plan.after),source=plan.selectedRow?structuredClone(plan.selectedRow):null;
  const value=structuredClone(plan.after),changed=before.some((r,i)=>r.json!==after[i].json);
  if(store?.isolation!=='explicit-test-store'||typeof store.db?.withSession!=='function')throw new WorkspaceError(503,'An isolated TEST store is required.');
  if(typeof actor!=='string'||!actor.trim()||actor.length>320||/[\r\n]/.test(actor))throw new WorkspaceError(422,'An authenticated TEST actor is required.');
  const db=store.db.withSession('first-primary'),id=crypto.randomUUID(),afterId=crypto.randomUUID(),sourceId=crypto.randomUUID(),stamp=new Date().toISOString();
  const assertion=(aid,rows)=>db.prepare(`INSERT INTO builtin_draft_assertions(id,valid) VALUES (?,CASE WHEN (${rows.map((r)=>r.sql).join(' AND ')}) THEN 1 ELSE 0 END)`).bind(aid,...rows.flatMap((r)=>[TEST_SITE,r.json]));
  const writes=[assertion(id,before)];
  if(source)writes.push(db.prepare(`INSERT INTO builtin_draft_assertions(id,valid) VALUES (?,CASE WHEN EXISTS(SELECT 1 FROM prebid_builds WHERE id=? AND publisher_id=? AND version=? AND file_key=? AND modules_json=? AND status=? AND uploaded_at=? AND file_url IS NULL) THEN 1 ELSE 0 END)`)
    .bind(sourceId,source.id,TEST_SITE,source.version,source.file_key,source.modules_json,source.status,source.uploaded_at));
  if(changed){
    const bidders=JSON.stringify(value.bidders.map((b)=>({...b,id:crypto.randomUUID()}))),overrides=JSON.stringify(value.overrides.map((o)=>({...o,id:crypto.randomUUID()})));
    if(source){
      writes.push(db.prepare("UPDATE prebid_builds SET status='archived' WHERE publisher_id=? AND status='current' AND id<>?").bind(TEST_SITE,source.id));
      writes.push(db.prepare("UPDATE prebid_builds SET status='current' WHERE publisher_id=? AND id=?").bind(TEST_SITE,source.id));
    }
    writes.push(db.prepare('UPDATE publisher_configs SET config_json=?,config_hash=NULL,updated_at=? WHERE publisher_id=?').bind(value.config.config_json,stamp,TEST_SITE));
    if(!plan.planOnly){
    writes.push(db.prepare(`INSERT INTO bidders(id,publisher_id,bidder,params_json,enabled)
      SELECT json_extract(value,'$.id'),?,json_extract(value,'$.bidder'),json_extract(value,'$.params_json'),json_extract(value,'$.enabled') FROM json_each(?) WHERE 1
      ON CONFLICT(publisher_id,bidder) DO UPDATE SET params_json=excluded.params_json,enabled=excluded.enabled,updated_at=?`).bind(TEST_SITE,bidders,stamp));
    writes.push(db.prepare(`INSERT INTO bidder_overrides(id,publisher_id,bidder,scope_type,scope_key,params_json,enabled)
      SELECT json_extract(value,'$.id'),?,json_extract(value,'$.bidder'),json_extract(value,'$.scope_type'),json_extract(value,'$.scope_key'),json_extract(value,'$.params_json'),json_extract(value,'$.enabled') FROM json_each(?) WHERE 1
      ON CONFLICT(publisher_id,bidder,scope_type,scope_key) DO UPDATE SET params_json=excluded.params_json,enabled=excluded.enabled,updated_at=?`).bind(TEST_SITE,overrides,stamp));
    writes.push(db.prepare("DELETE FROM bidders WHERE publisher_id=? AND bidder NOT IN (SELECT json_extract(value,'$.bidder') FROM json_each(?))").bind(TEST_SITE,bidders));
    writes.push(db.prepare(`DELETE FROM bidder_overrides WHERE publisher_id=? AND NOT EXISTS (SELECT 1 FROM json_each(?) WHERE json_extract(value,'$.bidder')=bidder_overrides.bidder AND json_extract(value,'$.scope_type')=bidder_overrides.scope_type AND json_extract(value,'$.scope_key')=bidder_overrides.scope_key)`).bind(TEST_SITE,overrides));
    }
    writes.push(assertion(afterId,after));
    writes.push(db.prepare('INSERT INTO audit_log(id,actor,action,publisher_id,details_json) VALUES (?,?,?,?,?)')
      .bind(crypto.randomUUID(),actor,plan.planOnly?'test_workspace.prebid_plan_saved':'test_workspace.prebid_settings_saved',TEST_SITE,JSON.stringify({enablePrebid:JSON.parse(value.config.config_json).enablePrebid,buildId:source?.id??null,bidders:value.bidders.length,overrides:value.overrides.length,publishable:false})));
  }
  writes.push(db.prepare('DELETE FROM builtin_draft_assertions WHERE id IN (?,?,?)').bind(id,afterId,sourceId));
  try{
    const result=await db.batch(writes);
    if(!Array.isArray(result)||result.length!==writes.length||result.some((r)=>r.success!==true))throw Error('Unconfirmed');
  }catch(error){
    const detail=[error?.message,error?.cause?.message].join(' ');
    if(/CHECK constraint failed:\s*valid\s*=\s*1/i.test(detail))throw new SelectionWriteError('configuration_changed','Settings or the selected file changed in another tab. Reload saved settings.',409);
    throw new WorkspaceError(503,'The save result could not be confirmed. Reload saved settings. Existing files were retained.');
  }
  return {persisted:true,changed,publishable:false};
}
export async function savePrebidSettings(env,actor,body){return commitPrebidSettings(prebidStore(env),await preparePrebidSettings(env,body),actor);}
