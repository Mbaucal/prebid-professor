/** Site-scoped PPS settings. The route owns authentication and Origin checks. */
import {readPreviewSnapshot} from '../runtime/builtin-preview-service.mjs';
import {digest} from '../runtime/preview-snapshot.mjs';
import {commitSiteConfiguration} from './service.mjs';
import {normalizeContextualSignals,defaultContextualSignals} from '../../shared/contextual-signals/settings.mjs';
import {CONTEXTUAL_TAXONOMIES} from '../../shared/contextual-signals/catalog.mjs';
import {contextualCompatibility} from '../../shared/contextual-signals/compatibility.mjs';

const fail=(message,status=422)=>{throw Object.assign(Error(message),{status});};
async function read(env,siteId){
  if(!/^[a-z0-9][a-z0-9-]{0,97}$/.test(siteId))fail('Invalid site.',400);
  const db=env.DB?.withSession('first-primary');
  if(!db)fail('Site storage is unavailable.',503);
  if(!await db.prepare('SELECT id FROM publishers WHERE id=? LIMIT 1').bind(siteId).first())fail('Site not found.',404);
  return readPreviewSnapshot(db,siteId,{includePrebid:true});
}
function payload(saved,config,revision){
  const settings=config.runtimeControls?.contextualSignals??defaultContextualSignals();
  const bidders=saved.bidders.map(b=>({bidder:b.bidder,enabled:b.enabled===1,configured:true}));
  for(const route of settings.bidders){if(!bidders.some(b=>b.bidder===route.bidder))bidders.push({bidder:route.bidder,enabled:false,configured:false});}
  const prebidVersion=saved.prebidBuilds?.length===1?saved.prebidBuilds[0].version:null;
  return {
    revision,
    settings,
    bidders,
    enablePrebid:config.enablePrebid===true,
    prebidVersion,
    runtimeEligible:config.builtinRuntimeSelection?.runtime?.capabilities?.includes('contextual-signals')===true,
    compatibility:bidders.map(row=>contextualCompatibility(row.bidder,prebidVersion)),
    taxonomies:CONTEXTUAL_TAXONOMIES,
    published:false,
  };
}
export async function getContextualSignalSettings(env,siteId){
  const saved=await read(env,siteId),config=JSON.parse(saved.config.config_json);
  return payload(saved,config,await digest(saved));
}
export async function saveContextualSignalSettings(env,siteId,actor,body){
  if(!body||Array.isArray(body)||Object.keys(body).sort().join(',')!=='revision,settings')fail('Use the displayed contextual signal settings.');
  const saved=await read(env,siteId);
  if(body.revision!==await digest(saved))fail('Site settings changed. Reload saved settings before saving again.',409);
  let settings;
  try{settings=normalizeContextualSignals(body.settings,{bidders:saved.bidders});}
  catch(error){fail(error.message);}
  const config=JSON.parse(saved.config.config_json);
  config.runtimeControls={...config.runtimeControls,contextualSignals:settings};
  const configJson=JSON.stringify(config);
  await commitSiteConfiguration(env,saved,configJson,actor,{audit:{action:'contextual_signals.saved',entityType:'publisher',entityId:siteId,details:{enabled:settings.enabled,mappingCount:settings.mappings.length,bidderCount:settings.bidders.length,published:false}}});
  const next={...saved,config:{...saved.config,config_json:configJson}};
  return payload(next,config,await digest(next));
}
export async function contextualSignalSettingsResponse(request,env,siteId,actor){
  const json=(value,status=200)=>Response.json(value,{status,headers:{'cache-control':'private, no-store','x-content-type-options':'nosniff'}});
  try{
    if(request.method==='GET')return json(await getContextualSignalSettings(env,siteId));
    if(request.method!=='POST')return json({error:'Method not allowed.'},405);
    if(request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json')return json({error:'JSON required.'},415);
    const reader=request.body?.getReader();if(!reader)fail('JSON required.',400);
    const chunks=[];let size=0;
    try{
      for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>131072){await reader.cancel();fail('Contextual signal settings exceed 128 KB.',413);}chunks.push(value);}
    }finally{reader.releaseLock();}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
    let body;try{body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{fail('Invalid JSON.',400);}
    return json(await saveContextualSignalSettings(env,siteId,actor,body));
  }catch(error){return json({error:error.status?error.message:'Contextual signals could not be loaded or saved. Retry without leaving this site.'},error.status??503);}
}
