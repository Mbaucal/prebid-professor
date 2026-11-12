/** Site-scoped bidder eligibility. Authentication and Origin checks belong to the route. */
import {readPreviewSnapshot} from '../runtime/builtin-preview-service.mjs';
import {digest} from '../runtime/preview-snapshot.mjs';
import {commitSiteConfiguration} from './service.mjs';
import {normalizeBidderRules,defaultBidderRules} from '../../shared/bidder-rules/settings.mjs';

const fail=(message,status=422)=>{throw Object.assign(Error(message),{status});};
async function read(env,siteId){
  if(!/^[a-z0-9][a-z0-9-]{0,97}$/.test(siteId))fail('Invalid site.',400);
  const db=env.DB?.withSession('first-primary');
  if(!db)fail('Site storage is unavailable.',503);
  if(!await db.prepare('SELECT id FROM publishers WHERE id=? LIMIT 1').bind(siteId).first())fail('Site not found.',404);
  return readPreviewSnapshot(db,siteId,{includePrebid:true});
}
function payload(saved,config,revision){
  const settings=config.runtimeControls?.bidderRules??defaultBidderRules();
  const bidders=saved.bidders.map(b=>({bidder:b.bidder,enabled:b.enabled===1,configured:true}));
  const positions=saved.units.map(u=>({code:u.code,enabled:u.enabled===1&&u.type!=='DRAFT',configured:true}));
  for(const rule of settings.rules){
    if(!bidders.some(b=>b.bidder===rule.bidder))bidders.push({bidder:rule.bidder,enabled:false,configured:false});
    for(const code of rule.positions)if(!positions.some(p=>p.code===code))positions.push({code,enabled:false,configured:false});
  }
  return {revision,settings,bidders,positions,enablePrebid:config.enablePrebid===true,
    runtimeEligible:config.builtinRuntimeSelection?.runtime?.capabilities?.includes('bidder-rules')===true,published:false};
}
export async function getBidderRuleSettings(env,siteId){
  const saved=await read(env,siteId),config=JSON.parse(saved.config.config_json);
  return payload(saved,config,await digest(saved));
}
export async function saveBidderRuleSettings(env,siteId,actor,body){
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).sort().join(',')!=='revision,settings')fail('Use the displayed bidder rule settings.');
  const saved=await read(env,siteId);
  if(body.revision!==await digest(saved))fail('Site settings changed. Reload saved settings before saving again.',409);
  const settings=normalizeBidderRules(body.settings),config=JSON.parse(saved.config.config_json);
  config.runtimeControls={...config.runtimeControls,bidderRules:settings};
  const configJson=JSON.stringify(config);
  await commitSiteConfiguration(env,saved,configJson,actor,{audit:{action:'bidder_rules.saved',entityType:'publisher',entityId:siteId,details:{enabled:settings.enabled,ruleCount:settings.rules.length,published:false}}});
  const next={...saved,config:{...saved.config,config_json:configJson}};
  return payload(next,config,await digest(next));
}
export async function bidderRuleSettingsResponse(request,env,siteId,actor){
  const json=(value,status=200)=>Response.json(value,{status,headers:{'cache-control':'private, no-store','x-content-type-options':'nosniff'}});
  try{
    if(request.method==='GET')return json(await getBidderRuleSettings(env,siteId));
    if(request.method!=='POST')return json({error:'Method not allowed.'},405);
    if(request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json')return json({error:'JSON required.'},415);
    const reader=request.body?.getReader();if(!reader)fail('JSON required.',400);
    const chunks=[];let size=0;
    try{
      for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>131072){await reader.cancel();fail('Bidder rule settings exceed 128 KB.',413);}chunks.push(value);}
    }finally{reader.releaseLock();}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
    let body;try{body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{fail('Invalid JSON.',400);}
    return json(await saveBidderRuleSettings(env,siteId,actor,body));
  }catch(error){return json({error:error.status?error.message:'Bidder rules could not be loaded or saved. Retry without leaving this site.'},error.status??503);}
}
