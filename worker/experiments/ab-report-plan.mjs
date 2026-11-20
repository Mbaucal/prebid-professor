import {sha256} from '../runtime/prebid-artifact-check.mjs';
import {readAbTest,AB_TEST_ID} from './ab-store.mjs';
import {AB_REPORT_PLAN_KIND} from './ab-measurement-contracts.mjs';
import {canonical,check,fail,isRecord,HASH,normalizeInventoryPath,normalizeReport} from './ab-measurement-utils.mjs';

const encode=new TextEncoder(),decode=new TextDecoder('utf-8',{fatal:true});
const SITE=/^[a-z0-9][a-z0-9-]{0,97}$/;
export const AB_REPORT_PLAN_ID=/^abm-[a-f0-9]{64}$/;
// Admission is best-effort under concurrent distinct creates; committed plans remain readable.
const KIND='ab-measurement-report-plan',MAX_BYTES=65536,MAX_PLANS=50,MAX_READ_PLANS=250;
const PLAN_KEYS='arms,createdAt,createdBy,experimentId,id,kind,loader,measurement,prebidSha256,recordSha256,report,schemaVersion,site,source,testId,trafficBPercent,zipSha256';
const prefix=(site,id)=>{check(SITE.test(site)&&AB_TEST_ID.test(id),'A/B test not found.',404);return `site-experiments/measurement-v1/${site}/${id}/plans/`;};
const path=(site,id,planId)=>{check(AB_REPORT_PLAN_ID.test(planId),'Reporting plan not found.',404);return prefix(site,id)+planId+'.json';};
const corrupt=()=>fail('This saved reporting plan does not match its immutable identity.',409,'report-plan-unverified');

export function reportPlanIdentity(plan){
  return canonical({schemaVersion:plan.schemaVersion,kind:plan.kind,site:plan.site,experimentId:plan.experimentId,testId:plan.testId,
    recordSha256:plan.recordSha256,zipSha256:plan.zipSha256,loader:plan.loader,arms:plan.arms,prebidSha256:plan.prebidSha256,
    trafficBPercent:plan.trafficBPercent,report:plan.report,source:plan.source,measurement:plan.measurement});
}
export function assertReportPlan(plan){
  check(isRecord(plan)&&Object.keys(plan).sort().join(',')===PLAN_KEYS&&plan.schemaVersion===1&&plan.kind===AB_REPORT_PLAN_KIND&&AB_REPORT_PLAN_ID.test(plan.id)&&SITE.test(plan.site)&&AB_TEST_ID.test(plan.experimentId),'A verified immutable reporting plan is required.');
  check(/^[a-z0-9_]{1,24}$/.test(plan.testId)&&HASH.test(plan.recordSha256)&&HASH.test(plan.zipSha256)&&HASH.test(plan.loader?.sha256)&&typeof plan.loader?.version==='string','Reporting identity is incomplete.');
  check(isRecord(plan.arms)&&Object.keys(plan.arms).sort().join(',')==='A,B'&&Number.isInteger(plan.trafficBPercent)&&plan.trafficBPercent>=0&&plan.trafficBPercent<=100,'Reporting allocation is invalid.');
  for(const side of ['A','B']){const arm=plan.arms[side];check(isRecord(arm)&&Object.keys(arm).sort().join(',')==='release,runtimeSha256,runtimeVersion,scriptSha256'&&/^builtin-(draft|release)-[a-f0-9]{64}$/.test(arm.release)&&typeof arm.runtimeVersion==='string'&&HASH.test(arm.scriptSha256)&&HASH.test(arm.runtimeSha256),'Reporting source pins are invalid.');}
  check(plan.prebidSha256===null||HASH.test(plan.prebidSha256),'Reporting Prebid pin is invalid.');
  check(canonical(normalizeReport(plan.report))===canonical(plan.report),'Reporting metadata is not canonical.');
  check(canonical(plan.source)===canonical({savedPackageScopeVerified:true,gamReportSourceVerified:false})&&canonical(plan.measurement)===canonical({collection:'disabled',coverage:'unknown',revenueReady:false}),'Unverified coverage cannot enable revenue comparison.');
  check(typeof plan.createdBy==='string'&&plan.createdBy.length>0&&typeof plan.createdAt==='string'&&new Date(plan.createdAt).toISOString()===plan.createdAt,'Reporting creation metadata is invalid.');
  return plan;
}
async function testContext(bucket,site,id){
  prefix(site,id);
  const result=await readAbTest(bucket,site,id);
  return {site,id,record:result.record,recordSha256:result.recordSha256};
}
/** Resolve only immutable source packages; mutable publisher settings are never consulted. */
async function savedScope(context,readVersion){
  const {record,site}=context,arms={};let inventoryPath=null;
  for(const side of ['A','B']){
    const source=record.arms[side];let pkg;
    try{pkg=await readVersion(source.release);}catch(error){if(error?.status!==404)fail('The saved source metadata could not be read. Retry.',503,'report-source-unavailable');}
    check(pkg,'Source version '+side+' is unavailable. Restore its saved package before preparing a new report plan.',422,'report-source-missing');
    try{
      const files=pkg.files,manifest=JSON.parse(decode.decode(files['manifest.json'])),config=JSON.parse(decode.decode(files['config.json']));
      check(pkg.release.id===source.release&&manifest.siteId===site&&HASH.test(manifest.runtime?.runtimeSha256)&&manifest.runtime.runtimeVersion===source.runtimeVersion,'Source version '+side+' has mismatched runtime identity.');
      check(config.runtime?.runtimeVersion===manifest.runtime.runtimeVersion&&config.runtime?.runtimeSha256===manifest.runtime.runtimeSha256,'Source version '+side+' has inconsistent runtime pins.');
      check(await sha256(files['ads.min.js'])===source.sha256&&await sha256(files['config.json'])===manifest.configHash,'Source version '+side+' differs from its saved experiment.');
      check((record.prebid===null&&!files['prebid.js'])||(record.prebid!==null&&await sha256(files['prebid.js'])===record.prebid.sha256),'The saved Prebid file differs from this experiment.');
      const current=normalizeInventoryPath(config.core?.gamPath);
      check(inventoryPath===null||current===inventoryPath,'The saved source inventory paths differ.');inventoryPath=current;
      arms[side]={release:source.release,runtimeVersion:source.runtimeVersion,scriptSha256:source.sha256,runtimeSha256:manifest.runtime.runtimeSha256};
    }catch(error){if(error?.status)throw error;fail('Source version '+side+' has incomplete saved reporting metadata.',422,'report-source-invalid');}
  }
  return {inventoryPath,networkCode:inventoryPath.split('/')[1],arms};
}
async function readStored(bucket,context,planId){
  const key=path(context.site,context.id,planId),object=await bucket.get(key);
  if(!object)return null;
  if(object.size<=0||object.size>MAX_BYTES||object.customMetadata?.kind!==KIND||!HASH.test(object.customMetadata?.sha256??''))corrupt();
  const bytes=new Uint8Array(await object.arrayBuffer());
  if(bytes.length!==object.size||await sha256(bytes)!==object.customMetadata.sha256)corrupt();
  let plan;
  try{
    plan=assertReportPlan(JSON.parse(decode.decode(bytes)));
    if(plan.site!==context.site||plan.experimentId!==context.id||plan.id!==planId||plan.recordSha256!==context.recordSha256||plan.zipSha256!==context.record.bundle.zipSha256||plan.testId!==context.record.testId||'abm-'+await sha256(encode.encode(reportPlanIdentity(plan)))!==planId)corrupt();
    if(canonical(plan.loader)!==canonical(context.record.loader)||plan.trafficBPercent!==context.record.trafficBPercent||plan.prebidSha256!==(context.record.prebid?.sha256??null))corrupt();
    for(const side of ['A','B']){const saved=context.record.arms[side],arm=plan.arms[side];if(arm.release!==saved.release||arm.runtimeVersion!==saved.runtimeVersion||arm.scriptSha256!==saved.sha256)corrupt();}
  }catch{corrupt();}
  return {plan,planSha256:object.customMetadata.sha256};
}
async function storedPlans(bucket,context){
  const ids=[];let cursor;
  for(let page=0;page<=MAX_READ_PLANS;page++){
    const result=await bucket.list({prefix:prefix(context.site,context.id),limit:MAX_PLANS+1,...(cursor?{cursor}:{})});
    for(const row of result.objects){const name=row.key.slice(prefix(context.site,context.id).length);check(/^abm-[a-f0-9]{64}\.json$/.test(name),'The report plan index is invalid.',409,'report-plan-unverified');ids.push(name.slice(0,-5));}
    check(ids.length<=MAX_READ_PLANS,'The report plan index exceeds its supported read limit.',409,'report-plan-limit');
    if(!result.truncated)return Promise.all(ids.map(id=>readStored(bucket,context,id)));
    check(typeof result.cursor==='string'&&result.cursor!==cursor,'The report plan index is incomplete. Retry.',503);cursor=result.cursor;
  }
  fail('The report plan index is incomplete. Retry.',503);
}
export async function listMeasurementPlans(bucket,{site,id,readVersion}){
  const context=await testContext(bucket,site,id),plans=await storedPlans(bucket,context);
  let scope=null,sourceError=null;
  try{scope=await savedScope(context,readVersion);}catch(error){if(error.status!==422)throw error;sourceError=error.message;}
  return {plans:plans.map(({plan,planSha256})=>({id:plan.id,createdAt:plan.createdAt,report:plan.report,planSha256})).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||a.id.localeCompare(b.id)),
    defaults:{networkCode:scope?.networkCode??null,inventoryPath:scope?.inventoryPath??null,startDate:null,endDate:null,currency:null,timeZone:'UTC',revenueBasis:'unknown',revenueMetric:'total'},sourceError};
}
export async function createMeasurementPlan(bucket,{site,id,actor,report,readVersion,now=new Date()}){
  check(typeof actor?.email==='string'&&actor.email.length>0&&actor.email.length<=254,'An authenticated actor is required.',401);
  const context=await testContext(bucket,site,id),normalized=normalizeReport(report),plans=await storedPlans(bucket,context);
  // A lost save response must remain recoverable after the source versions move
  // to Trash. Each candidate is already verified against this exact saved abx.
  const matches=plans.filter(({plan})=>canonical(plan.report)===canonical(normalized));
  check(matches.length<=1,'The saved report identity is ambiguous.',409,'report-plan-unverified');
  if(matches.length)return {created:false,...matches[0]};
  const scope=await savedScope(context,readVersion);
  check(normalized.networkCode===scope.networkCode&&normalized.inventoryPath===scope.inventoryPath,'Use the GAM network and inventory path from both saved source packages.',422,'report-scope-mismatch');
  const record=context.record;
  const plan={schemaVersion:1,kind:AB_REPORT_PLAN_KIND,id:null,site,experimentId:id,testId:record.testId,recordSha256:context.recordSha256,
    zipSha256:record.bundle.zipSha256,loader:record.loader,trafficBPercent:record.trafficBPercent,arms:scope.arms,prebidSha256:record.prebid?.sha256??null,report:normalized,
    source:{savedPackageScopeVerified:true,gamReportSourceVerified:false},measurement:{collection:'disabled',coverage:'unknown',revenueReady:false},createdAt:now.toISOString(),createdBy:actor.email};
  plan.id='abm-'+await sha256(encode.encode(reportPlanIdentity(plan)));assertReportPlan(plan);
  const existing=await readStored(bucket,context,plan.id);if(existing)return {created:false,...existing};
  check(plans.length<MAX_PLANS,'This test already has the maximum number of reporting plans.',409,'report-plan-limit');
  const bytes=encode.encode(JSON.stringify(plan)),digest=await sha256(bytes);
  check(bytes.length<=MAX_BYTES,'This reporting plan is too large.');
  const written=await bucket.put(path(site,id,plan.id),bytes,{onlyIf:new Headers({'If-None-Match':'*'}),sha256:digest,httpMetadata:{contentType:'application/json; charset=utf-8',cacheControl:'private, no-store'},customMetadata:{kind:KIND,sha256:digest}});
  const saved=await readStored(bucket,context,plan.id);check(saved,'The report plan save is unconfirmed. Retry the same values.',503,'report-plan-unconfirmed');
  return {created:written!==null,...saved};
}
export async function readMeasurementPlan(bucket,{site,id,planId}){
  const found=await readStored(bucket,await testContext(bucket,site,id),planId);
  check(found,'Reporting plan not found.',404,'report-plan-missing');return found;
}
