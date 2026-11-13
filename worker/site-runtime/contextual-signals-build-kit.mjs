import {zipSync} from 'fflate';
import {readPreviewSnapshot} from '../runtime/builtin-preview-service.mjs';
import {PREBID_CONTEXTUAL_MODULE_SOURCE} from '../runtime-321/prebid-module.mjs';
const pins={
  '11.11.0':'0f6ba177203d5f63e0a11453ed0c887fcf5efe33',
  '11.34.0':'195e0c6069928ed906bde550cb4e4183d1dc8474',
};
const encoder=new TextEncoder();
export function contextualBuildKit(snapshot){
  if(snapshot.prebidBuilds?.length>1)throw Error('Resolve multiple current Prebid builds before downloading the integration kit.');
  const build=snapshot.prebidBuilds?.length===1?snapshot.prebidBuilds[0]:null;
  const version=build?.version?.replace(/^v/,'')??null;
  if(version&&!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9._-]+)?$/.test(version))throw Error('Review the current Prebid version metadata.');
  let original=[];
  try{original=build?JSON.parse(build.modules_json):[];}catch{throw Error('Review the current Prebid module metadata.');}
  if(!Array.isArray(original)||original.some(m=>typeof m!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(m)))throw Error('Review the current Prebid module metadata.');
  const modules=[...new Set([...original,'rtdModule','contextualSignalsRtdProvider'])].sort();
  const manifest={schemaVersion:1,siteId:snapshot.site.id,prebidVersion:version,upstreamCommit:pins[version]??null,
    reviewedVersion:!!pins[version],provider:'contextualSignals',modules,
    note:'A build kit, not a compiled Prebid file or proof of SSP acceptance. Preserve all approved modules and verify against the exact version before upload.'};
  const readme=`Contextual signals: Prebid integration kit\n\nThis kit does not change the current build or publisher settings. The standard Prebid.org download builder does not contain this custom provider.\n\nCurrent metadata: ${version??'No current Prebid build'}\n${manifest.upstreamCommit?'Reviewed upstream commit: '+manifest.upstreamCommit:'This exact upstream version has not been reviewed. Select and validate an approved exact version before building.'}\n\n1. Use an isolated checkout of https://github.com/prebid/Prebid.js at the exact verified version/commit above. Preserve its package-lock.json and use its supported Node version. Never copy this module into an unrelated compiled binary.\n2. Copy modules/contextualSignalsRtdProvider.js from this kit into the checkout modules/ directory. Copy modules.json to the checkout root. The module list preserves the saved current module metadata and adds rtdModule and contextualSignalsRtdProvider. If there is no current build, select all required bidder, consent and other approved modules first; the two-module list is not a replacement for the site's build.\n3. Run npm ci, then npx --no-install gulp build --modules=modules.json. Review build/dist/prebid.js and its version/module header. Run synthetic integration checks before use.\n4. Upload the resulting Prebid file through the site's existing Prebid.js workflow. Select and save script 3.21.1 explicitly; Generate a new package. Uploading the module alone does not enable signals.\n5. In Contextual signals, choose the adsKeywords key, exact category values and separate IAB 2.2 / 3.0 mappings. Enable only destinations whose supported taxonomy has been confirmed. GAM accepts Content 2.2 in this implementation and requires an eligible GAM 360 account.\n6. Test the generated package on isolated inventory. Read window.__AD_CONTEXT.snapshot(), then inspect the actual adapter HTTP payload. A configured mapping, module presence or auction fragment is not an SSP acknowledgement.\n\nThe provider never fetches data or reads/writes cookies/storage. It enriches only the selected bidder's auction-local site.content.data; it does not overwrite global/bidder config or SChain. Missing module and unmapped categories omit this optional data without blocking ads. Script 3.21.1 fixes RTD configuration ownership. If ads.js is the only RTD writer, it configures contextualSignals. If the page uses any other RTD provider, configure ALL providers together in the FIRST realTimeData.dataProviders call, BEFORE ads.js; include {name: 'contextualSignals', waitForIt: false, params: {}} alongside your existing providers and preserve their options. Native Prebid RTD consumes its first dataProviders configuration, even an empty array. Merging a later getConfig() result does not activate new providers. A later publisher configuration is diagnosed, not silently rewritten. Reload after correcting the initial configuration.\n\nInspect window.__AD_CONTEXT.snapshot().rtd for configuration ownership/conflicts and providerObserved. provider-not-observed or prebid-modules-missing means optional bidder enrichment is unverified; ads continue. The editor checks the current build module metadata, and the runtime checks installedModules when available. Neither proves SSP receipt.\n\nGAM PPS is a separate opt-in. It gives the wrapper sole control of the entire page-level GPT PPS feature, including clearing stale values. Do not combine it with another PPS writer. No consent changes, user IDs or inferred audience segments are added.\n\nSource-reviewed adapter behavior is not a guarantee of SSP acceptance. Teads/RichAudience content routes are omitted for reviewed versions; Rubicon banner flattens taxonomy labels, so mixed existing taxonomy data can require skipping this contribution.\n`;
  return {'modules/contextualSignalsRtdProvider.js':encoder.encode(PREBID_CONTEXTUAL_MODULE_SOURCE),'modules.json':encoder.encode(JSON.stringify(modules,null,2)+'\n'),'integration.json':encoder.encode(JSON.stringify(manifest,null,2)+'\n'),'README.txt':encoder.encode(readme)};
}
export async function contextualBuildKitResponse(request,env,siteId){
  const fail=(error,status)=>Response.json({error},{status,headers:{'cache-control':'private, no-store'}});
  if(request.method!=='GET')return fail('Method not allowed.',405);
  const db=env.DB?.withSession('first-primary');if(!db)return fail('Site storage is unavailable.',503);
  try{
    if(!await db.prepare('SELECT id FROM publishers WHERE id=? LIMIT 1').bind(siteId).first())return fail('Site not found.',404);
    const saved=await readPreviewSnapshot(db,siteId,{includePrebid:true});
    const files=contextualBuildKit(saved);
    const zip=zipSync(Object.fromEntries(Object.entries(files).map(([name,bytes])=>[name,[bytes,{level:0,mtime:new Date(1980,0,1)}]])),{level:0});
    return new Response(zip,{headers:{'content-type':'application/zip','content-disposition':'attachment; filename="contextual-signals-build-kit.zip"','cache-control':'private, no-store','x-content-type-options':'nosniff'}});
  }catch{return fail('Build kit unavailable. Review the current Prebid version and module metadata, then retry.',409);}
}
