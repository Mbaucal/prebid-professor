import {scriptLibraryHistoryPage,readScriptLibraryHistory} from './script-library.mjs';
import {generatedAbHistoryPage,readGeneratedAbHistory,acceptedAbBaseline} from './ab-editor.mjs';

const headers={'cache-control':'private, no-store','x-content-type-options':'nosniff'};
const collections=['scripts','namedTests','generatedTests'];
const CURSOR=/^[A-Za-z0-9_=+/.-]{1,2048}$/;
const ID={scripts:/^tanjug-script-[12]\.0\.0-[a-f0-9]{64}$/,namedTests:/^tanjug-test-1\.0\.0-[a-f0-9]{64}$/,generatedTests:/^tanjug-ab-2\.0\.0-[a-f0-9]{64}$/};
const fail=(message,status)=>{throw Object.assign(Error(message),{status});};
const json=(value,status=200,extra={})=>Response.json(value,{status,headers:{...headers,...extra}});
const readableError=error=>[400,404,409,410].includes(error?.status)?error.message:'This saved package could not be read. Retry.';

function historyRow(site,collection,value){
  const base={id:value.id,name:'Unreadable saved version',createdAt:null,deletedAt:null,state:'unavailable',
    reason:value.error??null,runtimeVersion:null,prebidVersion:null,testId:null,reporting:collection==='scripts'?'not-instrumented':'variant-only',bytes:null,sha256:null,downloadUrl:null};
  if(value.error)return base;
  const record=value.record;
  // All three accepted legacy constructors pin this runtime and include the same
  // verified Prebid 11.34 file. GAM-only built-in packages use the separate generic list.
  const row={...base,name:record.name||record.notes?.trim()||'Earlier A/B package',createdAt:record.createdAt,
    deletedAt:value.deletedAt,state:'stored',reason:null,runtimeVersion:'3.9.1',prebidVersion:'11.34.0',
    bytes:record.bytes,sha256:record.archiveSha256,
    downloadUrl:value.deletedAt?null:`/api/publishers/${site}/ab-tests/history/${collection}/${value.id}/download`};
  if(collection==='scripts')row.settings=record.settings;
  else if(collection==='namedTests'){
    row.trafficBPercent=record.trafficBPercent;
    row.scripts=Object.fromEntries(['A','B'].map(arm=>[arm,{id:record.scripts[arm].id,name:record.scripts[arm].name,settings:record.scripts[arm].settings}]));
  }else{
    row.trafficBPercent=record.settings.trafficBPercent;
    row.scripts=Object.fromEntries(['A','B'].map(arm=>[arm,{id:null,name:`Variant ${arm}`,settings:record.settings.arms[arm]}]));
  }
  return row;
}
async function section(env,site,collection,cursor){
  try{
    const page=collection==='generatedTests'?await generatedAbHistoryPage(env,site,cursor)
      :await scriptLibraryHistoryPage(env,site,collection==='scripts'?'scripts':'tests',cursor);
    if(page.nextCursor!==null&&!CURSOR.test(page.nextCursor??''))fail('Historical page cursor is invalid.',409);
    const rows=page.rows.map(row=>historyRow(site,collection,row));
    rows.sort((a,b)=>(b.createdAt??'').localeCompare(a.createdAt??'')||a.id.localeCompare(b.id));
    return {items:rows.filter(row=>!row.deletedAt),deleted:rows.filter(row=>row.deletedAt),nextCursor:page.nextCursor,error:null};
  }catch{return {items:[],deleted:[],nextCursor:null,error:'Could not load this part of the saved history. Retry.'};}
}
async function baseline(env,site){
  const item=await acceptedAbBaseline(env,site);
  return item?{id:item.id,name:'Accepted A/A baseline',createdAt:null,deletedAt:null,state:'stored',reason:null,
    runtimeVersion:'3.9.1',prebidVersion:'11.34.0',testId:null,reporting:'variant-only',bytes:item.bytes,sha256:item.sha256,
    trafficBPercent:50,downloadUrl:`/api/publishers/${site}/ab-tests/history/baseline/${item.id}/download`}:null;
}

/** The caller has authenticated the administrator and checked that the site exists.
 * These routes only read the site's original records/ZIPs; no historical package is migrated. */
export async function abHistoryResponse(request,env,site){
  const url=new URL(request.url),base=`/api/publishers/${site}/ab-tests/history`,path=url.pathname;
  if(path!==base&&!path.startsWith(base+'/'))return null;
  if(request.method!=='GET')return json({error:'Method not allowed.'},405,{allow:'GET'});
  try{
    if(path===base){
      let selected=collections,cursor;
      if(url.search){
        const params=url.searchParams,collection=params.get('collection');
        if([...params.keys()].sort().join(',')!=='collection,cursor'||!collections.includes(collection)||!CURSOR.test(params.get('cursor')??''))
          fail('Use a historical collection and its saved page cursor.',400);
        selected=[collection];cursor=params.get('cursor');
      }
      const sections=Object.fromEntries(await Promise.all(selected.map(async collection=>[collection,await section(env,site,collection,cursor)])));
      let accepted=null,baselineError=null;
      if(!url.search){try{accepted=await baseline(env,site);}catch{baselineError='Could not check the accepted A/A baseline. Retry.';}}
      return json({site,sections,baseline:accepted,baselineError});
    }
    if(url.search)fail('Unknown query.',400);
    const match=path.slice(base.length).match(/^\/(scripts|namedTests|generatedTests|baseline)\/([^/]+)\/download$/);
    if(!match)fail('Historical package route not found.',404);
    const [,collection,id]=match;let bytes,sha;
    if(collection==='baseline'){
      if(id!=='tanjug-aa-1.0.2')fail('Accepted baseline not found.',404);
      const item=await acceptedAbBaseline(env,site,{download:true});
      if(!item)fail('Accepted baseline not found.',404);
      bytes=item.archive;sha=item.sha256;
    }else{
      if(!ID[collection].test(id))fail('Saved historical package not found.',404);
      const item=collection==='generatedTests'?await readGeneratedAbHistory(env,site,id,{download:true})
        :await readScriptLibraryHistory(env,site,collection==='scripts'?'scripts':'tests',id,{download:true});
      bytes=item.bytes;sha=item.record.archiveSha256;
    }
    return new Response(bytes,{headers:{...headers,'content-type':'application/zip','content-disposition':`attachment; filename="${id}.zip"`,'x-package-sha256':sha}});
  }catch(error){return json({error:readableError(error)},[400,404,409,410].includes(error?.status)?error.status:503);}
}
