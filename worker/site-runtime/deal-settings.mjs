/** Authenticated, site-scoped configuration; caller owns auth and Origin checks. */
import {readPreviewSnapshot} from '../runtime/builtin-preview-service.mjs';
import {digest} from '../runtime/preview-snapshot.mjs';
import {commitSiteConfiguration} from './service.mjs';
import {normalizeDeals,assertManagedDealParams,DEAL_NOTICE} from '../../shared/deals/contract.mjs';
import {dealPlan} from '../../shared/deals/gam-plan.mjs';
const fail=(message,status=422)=>{throw Object.assign(Error(message),{status});};
async function snapshot(env,siteId){
 if(!/^[a-z0-9][a-z0-9-]{0,97}$/.test(siteId))fail('Invalid site.',400);
 const db=env.DB?.withSession('first-primary');if(!db)fail('Site storage is unavailable.',503);
 if(!await db.prepare('SELECT id FROM publishers WHERE id=? LIMIT 1').bind(siteId).first())fail('Site not found.',404);
 const value=await readPreviewSnapshot(db,siteId,{includePrebid:true});if(!value.site)fail('Site not found.',404);return value;
}
export async function getDealSettings(env,siteId){
 const saved=await snapshot(env,siteId),config=JSON.parse(saved.config.config_json);
 const settings=config.runtimeControls?.deals??{schemaVersion:1,entries:[]};let validationIssue=null;
 try{normalizeDeals(settings,{bidders:saved.bidders,units:saved.units});assertManagedDealParams(settings,saved);}catch(error){validationIssue=error.message;}
 return {revision:await digest(saved),settings,bidders:saved.bidders.map(b=>({bidder:b.bidder,enabled:b.enabled===1})),units:saved.units.map(u=>({code:u.code,enabled:u.enabled===1})),plan:dealPlan(saved,settings),notice:DEAL_NOTICE,
  validationIssue,servingAvailable:['tessera-3.16.2','tessera-3.16.1','tessera-3.16.0','tessera-revenue-preview-1','tessera-revenue-preview-2','tessera-revenue-preview-3'].includes(config.builtinRuntimeSelection?.runtime?.runtimeId),publishable:false};
}
export async function saveDealSettings(env,siteId,actor,body){
 if(!body||Object.keys(body).sort().join(',')!=='revision,settings')fail('Use the displayed deal settings.');
 const saved=await snapshot(env,siteId);if(body.revision!==await digest(saved))fail('Site settings changed. Reload before saving deals.',409);
 const config=JSON.parse(saved.config.config_json),settings=normalizeDeals(body.settings,{bidders:saved.bidders,units:saved.units});
 // One source of outgoing PubMatic filtering. Do not silently erase manual values.
 assertManagedDealParams(settings,saved);
 config.runtimeControls={...config.runtimeControls,deals:settings};
 const result=await commitSiteConfiguration(env,saved,JSON.stringify(config),actor,{audit:{action:'deals.saved',entityType:'publisher',entityId:siteId,details:{count:settings.entries.length}}});
 return {...result,revision:await digest({...saved,config:{...saved.config,config_json:JSON.stringify(config)}}),settings,plan:dealPlan(saved,settings)};
}
export async function dealSettingsResponse(request,env,siteId,actor){
 const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json','cache-control':'private, no-store','x-content-type-options':'nosniff'}});
 try{
  if(request.method==='GET')return json(await getDealSettings(env,siteId));
  if(request.method!=='POST')return json({error:'Method not allowed.'},405);
  if(request.headers.get('content-type')?.split(';')[0]!=='application/json')return json({error:'JSON required.'},415);
  const reader=request.body?.getReader();if(!reader)fail('JSON required.',400);
  let size=0;const chunks=[];try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>24000){await reader.cancel();fail('Deal settings exceed 24 KB.',413);}chunks.push(value);}}finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  let body;try{body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{fail('Invalid JSON.',400);}
  return json(await saveDealSettings(env,siteId,actor,body));
 }catch(error){return json({error:error.status?error.message:'Deal settings could not be loaded or saved. Retry without leaving this site.'},error.status??503);}
}
