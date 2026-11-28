import {creativeTemplatesJs,creativeTemplatesCss} from '../../.generated/creative-templates.mjs';
// Called after the existing TEST boundary, TEST session and same-origin checks.
export async function creativeTemplatesResponse(request,env,actor,headers){
  const url=new URL(request.url);
  if(!['/creative-templates','/creative-templates.js'].includes(url.pathname))return null;
  if(request.method!=='GET'||url.search)return new Response('Not found',{status:404,headers});
  if(url.pathname.endsWith('.js'))return new Response(creativeTemplatesJs,{headers:{...headers,'content-type':'application/javascript; charset=utf-8'}});
  return new Response(`<!doctype html><html lang="sr-Latn"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tessera · Creative templates</title><style>${creativeTemplatesCss.replace(/<\/style/gi,'<\\/style')}</style></head><body><div id="root"></div><script src="/creative-templates.js" defer></script></body></html>`,{headers:{...headers,'content-type':'text/html; charset=utf-8'}});
}
