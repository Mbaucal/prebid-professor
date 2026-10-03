import {inspectPrebidArtifact,prebidFailureMessage} from './runtime/prebid-artifact-check.mjs';

/** Verify the original bytes before giving a duplicate its own immutable object.
 * Never remove an object on SQL failure: the transaction may have committed and
 * only its response been lost. An unreferenced copy is safe to review later.
 */
export async function prepareDuplicatedPrebid(env, sourceId, siteId, config, copyBuild) {
 const rows=(await env.DB.prepare("SELECT * FROM prebid_builds WHERE publisher_id=? AND status='current' ORDER BY uploaded_at DESC,id LIMIT 2").bind(sourceId).all()).results??[];
 const selection=config.builtinRuntimeSelection;
 if(!copyBuild || rows.length===0){
  if(selection)selection.prebid=null; // Keep the exact script version; setup explains the missing build.
  return {build:null,sourceRows:rows};
 }
 if(rows.length!==1)throw Error('Choose one current Prebid build on the source site before duplicating it.');
 if(!env.BUILDS)throw Error('Prebid storage is unavailable. The site was not duplicated.');
 let bytes;
 const report=await inspectPrebidArtifact({siteId:sourceId,builds:rows,requirements:{required:true,modules:[],issues:[]}}, {
  async get(key){const object=await env.BUILDS.get(key);if(!object)return null;return {size:object.size,customMetadata:object.customMetadata,async arrayBuffer(){bytes=await object.arrayBuffer();return bytes;}};},
 });
 if(report.status!=='checked'||!bytes)throw Error('The source Prebid file must be verified before copying. '+prebidFailureMessage(report));
 if(config.enablePrebid===true&&selection?.prebid){
  // Compare by value, independent of the JSON field order in an imported config.
  const pin=selection.prebid,build=report.build;
  if(pin.id!==build.id||pin.version!==build.version||pin.sha256!==build.sha256||pin.byteSize!==build.byteSize||JSON.stringify(pin.modules)!==JSON.stringify(report.declaredModules))throw Error('Save the source site’s Script setup before duplicating its changed Prebid build.');
 }
 const id=crypto.randomUUID(),key=`publishers/${siteId}/prebid-builds/${id}/prebid.js`;
 const stored=await env.BUILDS.put(key,bytes,{onlyIf:new Headers({'If-None-Match':'*'}),httpMetadata:{contentType:'application/javascript; charset=utf-8',cacheControl:'private, no-store'},customMetadata:{sha256:report.build.sha256,version:report.build.version,sourceSiteId:sourceId,sourceBuildId:rows[0].id}});
 if(!stored)throw Error('The copied Prebid file could not be stored. Reload before retrying.');
 if(selection)selection.prebid=config.enablePrebid===true?{...report.build,id,modules:report.declaredModules}:null;
 return {build:{id,version:report.build.version,file_key:key,file_url:`/api/publishers/${siteId}/prebid-builds/${id}/download`,modules_json:JSON.stringify(report.declaredModules)},sourceRows:rows};
}
