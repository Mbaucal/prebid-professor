import { createHash } from 'node:crypto';
import { describeDelivery, SCRIPT_LAYOUT } from '../worker/test-workspace/delivery-layout.mjs';
import { requireThat, same } from '../worker/test-workspace/deployment-contract.mjs';
import { boundedGet, deploymentOrigin, previewOrigin, verifyPublicPackage } from './pages-release-verification.mjs';

const sha = bytes=>createHash('sha256').update(bytes).digest('hex');
async function scriptsAt(origin, delivery, fetcher) {
  const results=[];
  for (const file of delivery.files) {
    const url=origin+'/'+file.name;
    const {bytes,headers}=await boundedGet(url,file.byteSize,{fetcher});
    requireThat(bytes.byteLength === file.byteSize && sha(bytes) === file.sha256,'Published bytes differ: '+file.name);
    requireThat(['application/javascript','text/javascript'].includes((headers.get('content-type')||'').split(';')[0].trim().toLowerCase()),'Wrong JavaScript content type: '+file.name);
    requireThat(headers.get('access-control-allow-origin') === '*' && headers.get('x-content-type-options') === 'nosniff'
      && (headers.get('x-robots-tag')||'').split(',').map(x=>x.trim().toLowerCase()).includes('noindex'),'Missing publisher delivery headers: '+file.name);
    const cache=(headers.get('cache-control')||'').toLowerCase().split(',').map(x=>x.trim()).filter(x=>x!=='no-transform').sort();
    requireThat(same(cache,['max-age=0','must-revalidate','public']),'Publisher cache policy differs: '+file.name);
    const etag=headers.get('etag');
    requireThat(etag && /^(?:W\/)?"[^"\r\n]+"$/.test(etag),'Missing Pages ETag: '+file.name);
    const conditional=await fetcher(url,{method:'GET',headers:{'If-None-Match':etag},redirect:'error',signal:AbortSignal.timeout(20000)});
    await conditional.body?.cancel();
    requireThat(conditional.status === 304 && !conditional.redirected,'Pages cache revalidation failed: '+file.name);
    results.push({name:file.name,sha256:file.sha256,byteSize:file.byteSize,etag,revalidated:true});
  }
  // A new Pages deployment must not retain the old public source/archive files.
  for (const name of ['ads.min.js','config.json','manifest.json','implementation.html','implementation','README.txt','div-export.csv','sticky.css','min-height.css','_headers']) {
    const response=await fetcher(origin+'/'+name,{method:'GET',headers:{},redirect:'manual',signal:AbortSignal.timeout(20000)});
    await response.body?.cancel();
    requireThat(response.status === 404 && !response.redirected,'An excluded source file is still public: '+name);
  }
  return {url:origin,files:results,excludedFilesAbsent:true};
}
export async function verifyDeliveryPublication(url, input, descriptor, delivery, fetcher=fetch) {
  requireThat(same(delivery,await describeDelivery(descriptor,delivery?.profile)), 'Public delivery inventory differs from its original source.');
  const origin=deploymentOrigin(url,input.project_name), alias=previewOrigin(`https://${input.branch}.${input.project_name}.pages.dev`,input.project_name,input.branch);
  let immutable,preview;
  if(delivery.profile === SCRIPT_LAYOUT) {
    immutable=await scriptsAt(origin,delivery,fetcher);
    preview=await scriptsAt(alias,delivery,fetcher);
  } else {
    immutable=await verifyPublicPackage(origin,input.project_name,descriptor,fetcher);
    preview=await verifyPublicPackage(alias,input.project_name,descriptor,fetcher,input.branch);
  }
  return {verified:true,deploymentUrl:origin,previewAliasUrl:alias,fileCount:delivery.files.length,
    manifestSha256:descriptor.manifestSha256,deliverySha256:delivery.sha256,deliveryProfile:delivery.profile,immutable,preview};
}
