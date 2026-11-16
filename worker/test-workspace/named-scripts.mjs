import {namedScriptsJs,namedScriptsCss} from '../../.generated/named-script-test.mjs';
import {scriptLibraryResponse} from '../site-runtime/script-library.mjs';
import {getPrebidMode,updatePrebidMode} from '../prebid-mode.ts';
import {withAuthenticatedActor} from '../http.ts';
import {jsonBody} from './boundary.mjs';
import {NAMED_TEST_SITE,namedScriptStatus,prepareNamedScriptFixture,requireNamedScriptFixture} from './named-script-fixture.mjs';

const base='/api/publishers/'+NAMED_TEST_SITE;
const libraryPattern=new RegExp('^'+base+'/script-library(?:/(scripts|tests)(?:/(tanjug-(?:script-[12]|test-1)\\.0\\.0-[a-f0-9]{64})\\.zip)?)?$');
export function namedScriptMethodAllowed(request){
  const path=new URL(request.url).pathname,match=path.match(libraryPattern);
  return (path===base+'/prebid-mode'&&request.method==='PUT')||Boolean(match?.[2]&&['PUT','DELETE'].includes(request.method));
}
const json=(value,headers,status=200)=>new Response(JSON.stringify(value),{status,headers:{...headers,'content-type':'application/json'}});
// Called only after the existing TEST boundary, same-origin and session guards.
export async function namedScriptsResponse(request,env,actor,headers){
  const url=new URL(request.url),path=url.pathname,match=path.match(libraryPattern);
  if(!['/named-scripts','/named-scripts.js','/test-api/named-scripts/status','/test-api/named-scripts/prepare',base+'/prebid-mode'].includes(path)&&!match)return null;
  if(url.search&&!match)return json({error:'Unknown query.'},headers,400);
  if(path==='/named-scripts'||path==='/named-scripts.js'){
    if(request.method!=='GET')return json({error:'Method not allowed.'},headers,405);
    if(path.endsWith('.js'))return new Response(namedScriptsJs,{headers:{...headers,'content-type':'application/javascript'}});
    return new Response('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tessera · TEST named scripts</title><style>'+namedScriptsCss.replace(/<\/style/gi,'<\\/style')+'</style><div id="root"></div><script src="/named-scripts.js" defer></script></html>',{headers:{...headers,'content-type':'text/html; charset=utf-8'}});
  }
  if(path==='/test-api/named-scripts/status')return request.method==='GET'?json(await namedScriptStatus(env),headers):json({error:'Method not allowed.'},headers,405);
  if(path==='/test-api/named-scripts/prepare')return request.method==='POST'?json(await prepareNamedScriptFixture(request,env,actor.email),headers):json({error:'Method not allowed.'},headers,405);
  await requireNamedScriptFixture(env);
  // The reused services receive only the isolated storage bindings, not integrations or credentials.
  const store={DB:env.DB,BUILDS:env.BUILDS};
  if(match)return scriptLibraryResponse(request,store,NAMED_TEST_SITE,match[1]||null,match[2]||null,actor.email);
  if(request.method==='GET')return getPrebidMode(store,NAMED_TEST_SITE);
  if(request.method==='PUT'){
    const body=await jsonBody(request,['enabled','revision','bidCache'],4096);
    const bounded=new Request(request.url,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    return updatePrebidMode(withAuthenticatedActor(bounded,actor.email),store,NAMED_TEST_SITE);
  }
  return json({error:'Method not allowed.'},headers,405);
}
