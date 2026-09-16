/** Site-scoped built-in settings. The caller must authenticate and enforce its
 * environment/site boundary before entering. No templates, migrations or publish. */
import { readPreviewSnapshot } from '../runtime/builtin-preview-service.mjs';
import { digest } from '../runtime/preview-snapshot.mjs';
import { pinRuntime } from '../runtime/version-pin.mjs';
import { describeRuntimeReleases } from '../runtime/runtime-release-history.mjs';
import { runtimeCatalog, descriptorForPin, previewInput, prepareSiteRuntimeSelection, readPinnedSiteRuntime, buildArtifactCandidate } from '../test-workspace/runtime-catalog.mjs';
import { readPositions, normalizeOverlay, normalizeLazy } from '../runtime-next/position-settings.mjs';
import { takeOverForBuild } from '../test-workspace/takeover-settings.mjs';
import { zipSync } from 'fflate';
import { siteSetupState } from './setup-state.mjs';

export class SiteRuntimeError extends Error { constructor(message,status=422){super(message);this.status=status;} }
const fail=(message,status)=>{throw new SiteRuntimeError(message,status);};
const specs=[
 ['site','publishers',['id','name','domain','gam_path'],'id=? LIMIT 1',true],
 ['config','publisher_configs',['config_json'],'publisher_id=? LIMIT 1',true],
 ['units','ad_units',['code','type','media_type','size_map_key','enabled','sort_order'],'publisher_id=? ORDER BY sort_order,code'],
 ['bidders','bidders',['bidder','params_json','enabled'],'publisher_id=? ORDER BY bidder'],
 ['overrides','bidder_overrides',['bidder','scope_type','scope_key','params_json','enabled'],'publisher_id=? ORDER BY bidder,scope_type,scope_key'],
 ['maps','size_maps',['name','map_json'],'publisher_id=? ORDER BY name'],
 ['rules','unit_rules',['rule_key','rule_json'],'publisher_id=? ORDER BY rule_key'],
 ['prebidBuilds','prebid_builds',['id','publisher_id','version','file_key','modules_json','status','uploaded_at'],"publisher_id=? AND status='current' ORDER BY uploaded_at DESC,id LIMIT 2"],
];
const keys=(value,expected)=>{if(!value||Array.isArray(value)||typeof value!=='object'||Object.keys(value).sort().join('|')!==[...expected].sort().join('|'))fail('Use the displayed settings fields only.');};
async function read(env,siteId){
 if(!/^[a-z0-9][a-z0-9-]{0,97}$/.test(siteId))fail('Invalid site ID.',400);
 const db=env.DB?.withSession('first-primary');if(!db)fail('Site storage is unavailable.',503);
 const exists=await db.prepare('SELECT id FROM publishers WHERE id=? LIMIT 1').bind(siteId).first();
 if(!exists)fail('Site not found.',404);
 return readPreviewSnapshot(db,siteId,{includePrebid:true});
}
/** The exact reviewed snapshot is compared inside the UPDATE and audit batch.
 * No extra assertion table or schema change is required in the main app. */
export async function commitSiteConfiguration(env,snapshot,configJson,actor,{activation=null,audit=null}={}){
 const siteId=snapshot.site.id,conditions=[],args=[];
 for(const [key,table,columns,where,single] of specs){
  const rows=single?[snapshot[key]]:snapshot[key];
  conditions.push(`(SELECT json_group_array(json_array(${columns.join(',')})) FROM (SELECT ${columns.join(',')} FROM ${table} WHERE ${where}))=?`);
  args.push(siteId,JSON.stringify(rows.map(row=>columns.map(c=>row[c]))));
 }
 if(activation){
  const columns=specs.find(([key])=>key==='prebidBuilds')[2];
  conditions.push(`(SELECT json_array(${columns.join(',')}) FROM prebid_builds WHERE publisher_id=? AND id=?)=?`);
  args.push(siteId,activation.id,JSON.stringify(columns.map(c=>activation[c])));
 }
 const changed=configJson!==snapshot.config.config_json;
 const db=env.DB.withSession('first-primary');let result;
 try{result=await db.batch([
  db.prepare(`UPDATE publisher_configs SET config_json=?,config_hash=CASE WHEN ? THEN NULL ELSE config_hash END,updated_at=CASE WHEN ? THEN ? ELSE updated_at END WHERE publisher_id=? AND ${conditions.join(' AND ')}`).bind(configJson,Number(changed),Number(changed),new Date().toISOString(),siteId,...args),
  ...(activation?[
   db.prepare(`UPDATE prebid_builds SET status=CASE WHEN id=? THEN 'current' ELSE 'archived' END WHERE publisher_id=? AND (status='current' OR id=?) AND changes()=1`).bind(activation.id,siteId,activation.id),
   db.prepare("INSERT INTO audit_log (id,actor,action,publisher_id,entity_type,entity_id,details_json) SELECT ?,?,'prebid_build.activated',?,'prebid_build',?,? WHERE changes()>0").bind(crypto.randomUUID(),actor,siteId,activation.id,JSON.stringify({version:activation.version,fileKey:activation.file_key,runtimeSelectionSynchronized:true})),
  ]:[db.prepare('INSERT INTO audit_log (id,actor,action,publisher_id,entity_type,entity_id,details_json) SELECT ?,?,?,?,?,?,? WHERE changes()=1 AND ?=1').bind(crypto.randomUUID(),actor,audit?.action??'builtin_runtime.settings_saved',siteId,audit?.entityType??null,audit?.entityId??null,JSON.stringify(audit?.details??{kind:'site-runtime-settings',published:false}),Number(changed))]),
 ]);}catch{fail('The save result is unconfirmed. Reload this site before trying again.',503);}
 if(result?.some(r=>r.success!==true))fail('The save result is unconfirmed. Reload this site before trying again.',503);
 if(result?.[0]?.meta?.changes!==1)fail('Site settings changed in another tab. Reload this site before saving.',409);
 return {changed,persisted:true,publishable:false};
}
export async function siteRuntimeSettings(env,siteId){
 const saved=await read(env,siteId),config=JSON.parse(saved.config.config_json);
 const pin=config.builtinRuntimeSelection?.runtime;let validationIssue=null;
 try{if(pin)previewInput(saved,descriptorForPin(pin),'20000101_000000');}catch(e){validationIssue=e.message;}
 const positions=readPositions(config,saved.units),sticky=config.runtimeControls?.sticky;
 const stickyId=Object.hasOwn(sticky??{},'bottomAdUnitId')?sticky.bottomAdUnitId:(saved.units.some(u=>u.code==='Sticky'&&u.enabled===1)?'Sticky':'');
 return {site:saved.site,revision:await digest(saved),selected:pin??null,validationIssue,enablePrebid:config.enablePrebid===true,...siteSetupState(saved),
  runtimes:runtimeCatalog.map(r=>({version:r.version,pin:pinRuntime(r,{allowPreview:true})})),history:describeRuntimeReleases(runtimeCatalog,pin),
  positions:saved.units.filter(u=>u.media_type==='banner'&&u.type!=='DRAFT').map(u=>({code:u.code,type:u.type,sizeMap:u.size_map_key,enabled:u.enabled===1,
   display:positions[u.code]?'takeover':stickyId===u.code?'sticky':'standard',overlay:positions[u.code]??null,
   lazy:Object.hasOwn(config.advancedUnitRules?.[u.code]??{},'lazy')?config.advancedUnitRules[u.code].lazy:JSON.parse(saved.rules.find(r=>r.rule_key===u.code)?.rule_json??'{}').lazy??null})),
  publishable:false};
}
export async function changeSiteRuntime(env,siteId,actor,body){
 const saved=await read(env,siteId),config=JSON.parse(saved.config.config_json);
 if(typeof body?.revision!=='string'||body.revision!==await digest(saved))fail('Site settings changed. Reload before saving.',409);
 if(body.action==='version'){
  keys(body,['action','revision','runtime','allowPreview']);
  const setup=siteSetupState(saved);if(setup.nextStep==='prebid')fail(setup.setupMessage);
  const currentId=saved.prebidBuilds.length===1?saved.prebidBuilds[0].id:null;
  const plan=await prepareSiteRuntimeSelection({siteId,snapshot:saved,catalog:runtimeCatalog,expectedRevision:body.revision,
   selection:{runtime:body.runtime,allowPreview:body.allowPreview,enablePrebid:config.enablePrebid,prebidBuildId:config.enablePrebid?currentId:null}},env.BUILDS);
  return commitSiteConfiguration(env,saved,plan.configJson,actor);
 }
 if(body.action!=='position')fail('Unknown settings action.');
 keys(body,['action','revision','position']);keys(body.position,['code','display','overlay','lazy']);
 const p=body.position,unit=saved.units.find(u=>u.code===p.code&&u.media_type==='banner'&&u.type!=='DRAFT');
 if(!unit)fail('Choose an existing banner ad unit for this site.');
 if(!['standard','sticky','takeover'].includes(p.display))fail('Choose a display format.');
 const pin=config.builtinRuntimeSelection?.runtime;if(!pin)fail('Choose and save a Script version first.',409);
 const descriptor=descriptorForPin(pin),positions=readPositions(config,saved.units);
 config.runtimeControls??={};config.runtimeControls.sticky??={};
 if(p.display==='takeover'){
  if(!unit.enabled)fail('Enable this ad unit before selecting TakeOver.');
  if(Object.keys(positions).some(code=>code!==p.code))fail('This site already has a TakeOver position.');
  if(config.runtimeControls.takeOver?.enabled)fail('Move the earlier TakeOver into Ad positions before changing its display settings.');
  positions[p.code]=normalizeOverlay(p.overlay);
  if(positions[p.code].demand==='site'&&!config.enablePrebid)fail('Enable Prebid for this site before selecting Prebid + GAM demand.');
 }else{if(p.overlay!==null)fail('Overlay options belong to TakeOver only.');delete positions[p.code];}
 const oldSticky=Object.hasOwn(config.runtimeControls.sticky,'bottomAdUnitId')?config.runtimeControls.sticky.bottomAdUnitId:(saved.units.some(u=>u.code==='Sticky'&&u.enabled===1)?'Sticky':'');
 if(p.display==='sticky'){if(!unit.enabled)fail('Enable this ad unit before selecting bottom Sticky.');config.runtimeControls.sticky.bottomAdUnitId=p.code;}
 else if(oldSticky===p.code)config.runtimeControls.sticky.bottomAdUnitId='';
 config.runtimeControls.adPositions=positions;
 config.advancedUnitRules??={};config.advancedUnitRules[p.code]??={};
 config.advancedUnitRules[p.code].lazy=normalizeLazy(p.lazy);
 const next={...saved,config:{config_json:JSON.stringify(config)}};
 previewInput(next,descriptor,'20000101_000000');
 return commitSiteConfiguration(env,saved,next.config.config_json,actor);
}
export async function siteRuntimeBundle(env,siteId,body){
 keys(body,['action','revision','acknowledge']);if(body.action!=='bundle'||body.acknowledge!==true)fail('Review this candidate before downloading.');
 const saved=await read(env,siteId);if(body.revision!==await digest(saved))fail('Site settings changed. Reload before generating.',409);
 const selected=await readPinnedSiteRuntime({siteId,snapshot:saved,catalog:runtimeCatalog},env.BUILDS);
 const timestamp=new Date().toISOString().replace(/[-:]/g,'').replace('T','_').slice(0,15);
 const candidate=await buildArtifactCandidate({snapshot:selected.snapshot,pin:selected.pin,prebid:selected.prebid,takeOver:takeOverForBuild(saved),buildTimestamp:timestamp});
 if(await digest(await read(env,siteId))!==body.revision)fail('Site settings changed during generation. Generate again.',409);
 const zip=zipSync(Object.fromEntries(Object.entries(candidate.files).map(([name,bytes])=>[name,[bytes,{level:0,mtime:new Date('1980-01-01T00:00:00Z')}]])),{level:0});
 return new Response(zip,{headers:{'content-type':'application/zip','cache-control':'private, no-store','x-content-type-options':'nosniff','content-disposition':`attachment; filename="${siteId}-${selected.descriptor.version}-candidate.zip"`}});
}
export async function siteRuntimeResponse(request,env,siteId,actor){
 const headers={'content-type':'application/json; charset=utf-8','cache-control':'private, no-store','x-content-type-options':'nosniff'};
 const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers});
 try{
  if(request.method==='GET')return json(await siteRuntimeSettings(env,siteId));
  if(request.method!=='POST')return json({error:'Method not allowed.'},405);
  if((request.headers.get('content-type')??'').split(';')[0]!=='application/json')return json({error:'JSON required.'},415);
  const reader=request.body?.getReader();if(!reader)fail('JSON required.',400);
  let size=0;const chunks=[];try{for(;;){const item=await reader.read();if(item.done)break;size+=item.value.length;if(size>24000){await reader.cancel();fail('Request exceeds 24 KB.',413);}chunks.push(item.value);}}finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
  let body;try{body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{fail('Invalid JSON.',400);}
  return body?.action==='bundle'?await siteRuntimeBundle(env,siteId,body):json(await changeSiteRuntime(env,siteId,actor,body));
 }catch(e){return json({error:e.status?e.message:'These saved settings need review before using this script version.'},e.status??422);}
}
