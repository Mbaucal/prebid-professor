import {sha256} from '../runtime/prebid-artifact-check.mjs';
import {readAbTest,AB_TEST_ID} from './ab-store.mjs';
import {abGamIdentity} from './ab-bundle.mjs';
import {HASH,normalizeInventoryPath} from './ab-measurement-utils.mjs';
import {GAM_REPORT_V2_KIND} from './gam-report-v2-contracts.mjs';
import {canonical,check,fail,isRecord,normalizeGamReportV2Input} from './gam-report-v2-utils.mjs';

export {normalizeGamReportV2Input};
export const GAM_REPORT_V2_PLAN_ID=/^abr-[a-f0-9]{64}$/;
const SITE=/^[a-z0-9][a-z0-9-]{0,97}$/;
const KIND='gam-report-plan-v2',MAX_BYTES=160*1024,MAX_PLANS=50,MAX_READ=250;
const KEYS='arms,createdAt,createdBy,experimentId,id,identityKey,kind,loader,measurement,prebidSha256,recordSha256,report,schemaVersion,site,source,trafficBPercent,versionId,zipSha256';
const encode=new TextEncoder(),decode=new TextDecoder('utf-8',{fatal:true});
const prefix=(site,id)=>{check(SITE.test(site)&&AB_TEST_ID.test(id),'A/B test not found.',404);return `site-experiments/measurement-v2/${site}/${id}/plans/`;};
const path=(site,id,planId)=>{check(GAM_REPORT_V2_PLAN_ID.test(planId),'Detailed reporting plan not found.',404);return prefix(site,id)+planId+'.json';};
const corrupt=()=>fail('This detailed reporting plan does not match its immutable identity.',409,'gam-v2-plan-unverified');

export function gamReportV2PlanIdentity(plan){return canonical({schemaVersion:plan.schemaVersion,kind:plan.kind,site:plan.site,experimentId:plan.experimentId,versionId:plan.versionId,identityKey:plan.identityKey,
  recordSha256:plan.recordSha256,zipSha256:plan.zipSha256,loader:plan.loader,arms:plan.arms,prebidSha256:plan.prebidSha256,trafficBPercent:plan.trafficBPercent,report:plan.report,source:plan.source,measurement:plan.measurement});}
export function assertGamReportV2Plan(plan){
  check(isRecord(plan)&&Object.keys(plan).sort().join(',')===KEYS&&plan.schemaVersion===2&&plan.kind===GAM_REPORT_V2_KIND&&GAM_REPORT_V2_PLAN_ID.test(plan.id)&&SITE.test(plan.site)&&AB_TEST_ID.test(plan.experimentId),'A verified immutable detailed reporting plan is required.');
  check(/^[a-z0-9_]{1,24}$/.test(plan.versionId)&&HASH.test(plan.recordSha256)&&HASH.test(plan.zipSha256)&&HASH.test(plan.loader?.sha256)&&typeof plan.loader?.version==='string','Detailed report identity is incomplete.');
  const identity=abGamIdentity({loader:plan.loader,testId:plan.versionId});
  check(plan.identityKey===identity.key&&plan.versionId===identity.value,'The reporting identity key does not match the saved loader.');
  check(isRecord(plan.arms)&&Object.keys(plan.arms).sort().join(',')==='A,B'&&Number.isInteger(plan.trafficBPercent)&&plan.trafficBPercent>=0&&plan.trafficBPercent<=100,'Detailed report allocation is invalid.');
  for(const side of ['A','B']){const arm=plan.arms[side];check(isRecord(arm)&&Object.keys(arm).sort().join(',')==='release,runtimeSha256,runtimeVersion,scriptSha256'&&/^builtin-(draft|release)-[a-f0-9]{64}$/.test(arm.release)&&typeof arm.runtimeVersion==='string'&&HASH.test(arm.scriptSha256)&&HASH.test(arm.runtimeSha256),'Detailed reporting source pins are invalid.');}
  check(plan.prebidSha256===null||HASH.test(plan.prebidSha256),'Detailed reporting Prebid pin is invalid.');
  check(canonical(normalizeGamReportV2Input(plan.report))===canonical(plan.report),'Detailed report metadata is not canonical.');
  check(canonical(plan.source)===canonical({savedPackageScopeVerified:true,gamReportSourceVerified:false,scopeDeclaration:'operator'})&&canonical(plan.measurement)===canonical({collection:'disabled',coverage:'unknown',revenueReady:false}),'Declared scope cannot enable verified source or assignment coverage.');
  check(typeof plan.createdBy==='string'&&plan.createdBy.length>0&&plan.createdBy.length<=254&&typeof plan.createdAt==='string'&&new Date(plan.createdAt).toISOString()===plan.createdAt,'Detailed reporting creation metadata is invalid.');
  return plan;
}
async function context(bucket,site,id){prefix(site,id);const saved=await readAbTest(bucket,site,id);return {site,id,record:saved.record,recordSha256:saved.recordSha256};}

/** Independent v2 verifier: existing v1 plans/parsers and their object identities are untouched. */
async function savedScope(current,readVersion){
  const {record,site}=current,arms={};let inventoryPath=null;
  for(const side of ['A','B']){
    const source=record.arms[side];let pkg;
    try{pkg=await readVersion(source.release);}catch(error){if(error?.status!==404)fail('The saved source metadata could not be read. Retry.',503,'gam-v2-source-unavailable');}
    check(pkg,'Source version '+side+' is unavailable. Restore its saved package before creating a new detailed plan.',422,'gam-v2-source-missing');
    try{
      const files=pkg.files,manifest=JSON.parse(decode.decode(files['manifest.json'])),config=JSON.parse(decode.decode(files['config.json']));
      check(pkg.release.id===source.release&&manifest.siteId===site&&HASH.test(manifest.runtime?.runtimeSha256)&&manifest.runtime.runtimeVersion===source.runtimeVersion,'Source version '+side+' has mismatched runtime identity.');
      check(config.runtime?.runtimeVersion===manifest.runtime.runtimeVersion&&config.runtime?.runtimeSha256===manifest.runtime.runtimeSha256,'Source version '+side+' has inconsistent runtime pins.');
      check(await sha256(files['ads.min.js'])===source.sha256&&await sha256(files['config.json'])===manifest.configHash,'Source version '+side+' differs from its saved experiment.');
      check((record.prebid===null&&!files['prebid.js'])||(record.prebid!==null&&await sha256(files['prebid.js'])===record.prebid.sha256),'The saved Prebid file differs from this experiment.');
      const currentPath=normalizeInventoryPath(config.core?.gamPath);
      check(inventoryPath===null||currentPath===inventoryPath,'The saved source inventory paths differ.');inventoryPath=currentPath;
      arms[side]={release:source.release,runtimeVersion:source.runtimeVersion,scriptSha256:source.sha256,runtimeSha256:manifest.runtime.runtimeSha256};
    }catch(error){if(error?.status)throw error;fail('Source version '+side+' has incomplete detailed reporting metadata.',422,'gam-v2-source-invalid');}
  }
  return {inventoryPath,networkCode:inventoryPath.split('/')[1],arms};
}
async function readStored(bucket,current,planId){
  const object=await bucket.get(path(current.site,current.id,planId));if(!object)return null;
  if(object.size<=0||object.size>MAX_BYTES||object.customMetadata?.kind!==KIND||!HASH.test(object.customMetadata?.sha256??''))corrupt();
  const bytes=new Uint8Array(await object.arrayBuffer());if(bytes.length!==object.size||await sha256(bytes)!==object.customMetadata.sha256)corrupt();
  let plan;
  try{
    plan=assertGamReportV2Plan(JSON.parse(decode.decode(bytes)));const record=current.record,identity=abGamIdentity(record);
    if(plan.site!==current.site||plan.experimentId!==current.id||plan.id!==planId||plan.recordSha256!==current.recordSha256||plan.zipSha256!==record.bundle.zipSha256||plan.versionId!==identity.value||plan.identityKey!==identity.key||'abr-'+await sha256(encode.encode(gamReportV2PlanIdentity(plan)))!==planId)corrupt();
    if(canonical(plan.loader)!==canonical(record.loader)||plan.trafficBPercent!==record.trafficBPercent||plan.prebidSha256!==(record.prebid?.sha256??null))corrupt();
    for(const side of ['A','B'])if(plan.arms[side].release!==record.arms[side].release||plan.arms[side].runtimeVersion!==record.arms[side].runtimeVersion||plan.arms[side].scriptSha256!==record.arms[side].sha256)corrupt();
  }catch{corrupt();}
  return {plan,planSha256:object.customMetadata.sha256};
}
async function storedPlans(bucket,current){
  const ids=[];let cursor;
  for(let page=0;page<=MAX_READ;page++){
    const listing=await bucket.list({prefix:prefix(current.site,current.id),limit:MAX_PLANS+1,...(cursor?{cursor}:{})});
    for(const item of listing.objects){const name=item.key.slice(prefix(current.site,current.id).length);check(/^abr-[a-f0-9]{64}\.json$/.test(name),'The detailed plan index is invalid.',409,'gam-v2-plan-unverified');ids.push(name.slice(0,-5));}
    check(ids.length<=MAX_READ,'The detailed plan index exceeds the supported read limit.',409,'gam-v2-plan-limit');
    if(!listing.truncated)return Promise.all(ids.map(id=>readStored(bucket,current,id)));
    check(typeof listing.cursor==='string'&&listing.cursor!==cursor,'The detailed plan index is incomplete. Retry.',503);cursor=listing.cursor;
  }
  fail('The detailed plan index is incomplete. Retry.',503);
}
export async function listGamReportV2Plans(bucket,{site,id,readVersion}){
  const current=await context(bucket,site,id),plans=await storedPlans(bucket,current);let scope=null,sourceError=null;
  try{scope=await savedScope(current,readVersion);}catch(error){if(error.status!==422)throw error;sourceError=error.message;}
  return {plans:plans.map(({plan,planSha256})=>({id:plan.id,createdAt:plan.createdAt,report:plan.report,versionId:plan.versionId,identityKey:plan.identityKey,planSha256})).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||a.id.localeCompare(b.id)),
    defaults:{networkCode:scope?.networkCode??null,inventoryPath:scope?.inventoryPath??null,startDate:null,endDate:null,currency:null,timeZone:'UTC',revenueBasis:'unknown',revenueMetric:'total',purpose:'overall',metricFamily:'total',scope:{orderIds:[],lineItemIds:[]},dimensions:[],metrics:['impressions','revenue'],sourceColumns:{},compatibilityMode:'unknown'},sourceError};
}
export async function createGamReportV2Plan(bucket,{site,id,actor,report,readVersion,now=new Date()}){
  check(typeof actor?.email==='string'&&actor.email.length>0&&actor.email.length<=254,'An authenticated actor is required.',401);
  const current=await context(bucket,site,id),normalized=normalizeGamReportV2Input(report),plans=await storedPlans(bucket,current);
  const matches=plans.filter(({plan})=>canonical(plan.report)===canonical(normalized));check(matches.length<=1,'Detailed reporting identity is ambiguous.',409,'gam-v2-plan-unverified');
  if(matches.length)return {created:false,...matches[0]};
  const scope=await savedScope(current,readVersion);
  check(normalized.networkCode===scope.networkCode&&normalized.inventoryPath===scope.inventoryPath,'Use the GAM network and inventory path from both saved source packages.',422,'gam-v2-scope-mismatch');
  const record=current.record,identity=abGamIdentity(record);
  const plan={schemaVersion:2,kind:GAM_REPORT_V2_KIND,id:null,site,experimentId:id,versionId:identity.value,identityKey:identity.key,recordSha256:current.recordSha256,zipSha256:record.bundle.zipSha256,
    loader:record.loader,trafficBPercent:record.trafficBPercent,arms:scope.arms,prebidSha256:record.prebid?.sha256??null,report:normalized,
    source:{savedPackageScopeVerified:true,gamReportSourceVerified:false,scopeDeclaration:'operator'},measurement:{collection:'disabled',coverage:'unknown',revenueReady:false},createdAt:now.toISOString(),createdBy:actor.email};
  plan.id='abr-'+await sha256(encode.encode(gamReportV2PlanIdentity(plan)));assertGamReportV2Plan(plan);
  const existing=await readStored(bucket,current,plan.id);if(existing)return {created:false,...existing};
  check(plans.length<MAX_PLANS,'This test already has the maximum number of detailed plans.',409,'gam-v2-plan-limit');
  const bytes=encode.encode(JSON.stringify(plan));check(bytes.length<=MAX_BYTES,'This detailed report plan is too large.');const digest=await sha256(bytes);
  const written=await bucket.put(path(site,id,plan.id),bytes,{onlyIf:new Headers({'If-None-Match':'*'}),sha256:digest,httpMetadata:{contentType:'application/json; charset=utf-8',cacheControl:'private, no-store'},customMetadata:{kind:KIND,sha256:digest}});
  const saved=await readStored(bucket,current,plan.id);check(saved,'The detailed reporting plan save is unconfirmed. Retry with the same fields.',503);return {created:written!==null,...saved};
}
export async function readGamReportV2Plan(bucket,{site,id,planId}){const current=await context(bucket,site,id),saved=await readStored(bucket,current,planId);check(saved,'Detailed reporting plan not found.',404);return saved;}
