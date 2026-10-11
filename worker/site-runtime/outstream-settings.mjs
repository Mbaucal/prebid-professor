import {readPreviewSnapshot} from '../runtime/builtin-preview-service.mjs';
import {digest} from '../runtime/preview-snapshot.mjs';
import {commitSiteConfiguration} from './service.mjs';
import {normalizeOutstream,hasEnabledOutstream,outstreamContext} from '../../shared/outstream/settings.mjs';
export {hasEnabledOutstream};
async function handle(request,env,siteId,actor) {
  const fail=(message,status=422)=>{throw Object.assign(Error(message),{status});};
  if(!/^[a-z0-9][a-z0-9-]{0,97}$/.test(siteId)) fail('Invalid site ID.',400);
  const db=env.DB?.withSession('first-primary');if(!db)fail('Site storage is unavailable.',503);
  if(!await db.prepare('SELECT id FROM publishers WHERE id=? LIMIT 1').bind(siteId).first())fail('Site not found.',404);
  const saved=await readPreviewSnapshot(db,siteId,{includePrebid:true});
  let config=JSON.parse(saved.config.config_json);
  if(request.method==='POST') {
    if(!(request.headers.get('content-type')??'').toLowerCase().startsWith('application/json'))fail('Use JSON format settings.',415);
    const reader=request.body?.getReader();if(!reader)fail('Missing settings.');
    const chunks=[];let bytes=0;while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>32768){await reader.cancel();fail('Settings are too large.',413);}chunks.push(part.value);}
    const text=new TextDecoder().decode(Uint8Array.from(chunks.flatMap(c=>Array.from(c))));
    let body;try{body=JSON.parse(text);}catch{fail('Invalid JSON settings.',400);}
    if(!body||Object.keys(body).sort().join(',')!=='outstream,revision')fail('Use the displayed outstream fields only.');
    if(body.revision!==await digest(saved))fail('Site settings changed. Reload before saving.',409);
    const outstream=normalizeOutstream(body.outstream,outstreamContext(saved));
    config={...config,runtimeControls:{...config.runtimeControls,outstream}};
    await commitSiteConfiguration(env,saved,JSON.stringify(config),actor,{audit:{action:'outstream.settings_saved',details:{positions:Object.keys(outstream.units),published:false}}});
    // Return the persisted snapshot revision, including the updated config only.
    saved.config={...saved.config,config_json:JSON.stringify(config)};
  } else if(request.method!=='GET') fail('Method not allowed.',405);
  const ctx=outstreamContext(saved);
  return Response.json({revision:await digest(saved),outstream:config.runtimeControls?.outstream??{schemaVersion:1,units:{}},
    prebidVersion:ctx.prebidVersion,modules:ctx.modules,bidders:ctx.bidders.map(b=>({bidder:b.bidder,enabled:b.enabled===1})),
    enablePrebid:ctx.enablePrebid===true,units:ctx.units.map(u=>({code:u.code,enabled:u.enabled===1})),
    runtimeEligible:config.builtinRuntimeSelection?.runtime?.version==='3.16.0-revenue.preview.1',published:false},{headers:{'cache-control':'no-store'}});
}

export async function outstreamSettingsResponse(request,env,siteId,actor) {
  try{return await handle(request,env,siteId,actor);}
  catch(error){return Response.json({error:error?.status?error.message:'Could not process outstream settings.'},{status:error?.status??500,headers:{'cache-control':'no-store'}});}
}
