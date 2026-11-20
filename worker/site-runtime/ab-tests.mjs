import {abTestsResponse} from '../experiments/ab-tests-api.mjs';
import {readPackage} from './releases.mjs';

const SITE=/^[a-z0-9][a-z0-9-]{0,97}$/;
const RELEASE=/^builtin-release-[a-f0-9]{64}$/;
const headers={'cache-control':'private, no-store','x-content-type-options':'nosniff'};
const fail=(message,status)=>{throw Object.assign(new Error(message),{status});};
const json=(error,status)=>Response.json({error},{status,headers});

/** MAIN adapter for saved built-in releases. Authentication and origin checks belong to the router.
 * Reading, checking and saving an experiment never changes a release channel or site settings.
 */
export async function mainAbTestsResponse(request,env,site,actor){
  try{
    if(!SITE.test(site))return json('Site not found.',404);
    if(!env.DB||!env.BUILDS)return json('A/B storage is unavailable. Retry.',503);
    const db=env.DB.withSession('first-primary');
    if(!await db.prepare('SELECT id FROM publishers WHERE id=?').bind(site).first())return json('Site not found.',404);
    const readVersion=async(id,options)=>{
      if(!RELEASE.test(id))fail('Saved built-in release not found.',404);
      return readPackage(env,site,id,options);
    };
    let listing;
    const versions=()=>listing??=(async()=>{
      const published=await db.prepare("SELECT id FROM releases WHERE publisher_id=? AND status='production' LIMIT 2").bind(site).all();
      if(published.results.length>1)fail('The production version is ambiguous. Check the site releases before choosing A.',409);
      // Match Saved versions' 50-item window while retaining the current control even after many new drafts.
      const rows=await db.prepare("SELECT id,notes,status,created_at FROM releases WHERE publisher_id=? AND version LIKE 'builtin-release-%' AND status<>'failed' ORDER BY CASE WHEN status='production' THEN 0 ELSE 1 END,created_at DESC,id DESC LIMIT 50").bind(site).all();
      const available=[];
      for(const row of rows.results){
        const pkg=await readVersion(row.id,{requestedFile:'manifest.json'});
        available.push({id:row.id,name:row.notes?.trim()||'Generated package',createdAt:row.created_at,
          runtimeVersion:pkg.manifest.runtime.runtimeVersion,prebidVersion:pkg.manifest.prebidBuild?.version??null,state:'stored'});
      }
      const selected=published.results[0]?.id;
      return {available,current:available.some(v=>v.id===selected)?selected:null};
    })();
    const response=await abTestsResponse(request,{
      bucket:env.BUILDS,site,actor:{email:actor},base:`/api/publishers/${site}/ab-tests`,headers,
      // Full verified packages, never the manifest-only listing, are given to the composer.
      readVersion:id=>readVersion(id),listVersions:async()=>(await versions()).available,
      current:async()=>(await versions()).current,defaults:{trafficBPercent:50},
    });
    return response??json('A/B test route not found.',404);
  }catch(error){
    return json([404,409,503].includes(error?.status)?error.message:'A/B tests could not be read. Retry.',[404,409,503].includes(error?.status)?error.status:503);
  }
}
