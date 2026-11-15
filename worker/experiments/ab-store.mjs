import {sha256} from '../runtime/prebid-artifact-check.mjs';
import {deletedPackage,changePackageDeletion} from '../site-runtime/saved-package-trash.mjs';
import {AB_TEST_SCHEMA,abTestIdentity,composeAbBundle} from './ab-bundle.mjs';

/* Immutable A/B test store in one R2 bucket (MBA-416). Shared by both lines: the bucket, the
 * site and the actor are passed in, and nothing here reads a binding or a line-only module.
 * Every write is create-only and read back. Bytes are never deleted; trash is a separate marker.
 *
 * Keys under site-experiments/v1/<site>/:
 *   records/<abx>.json        the record (the commit point), customMetadata {kind, sha256, summary}
 *   files/<abx>/<path>        each bundle file, customMetadata {kind, sha256}
 *   zips/<abx>.zip            the exact bundle ZIP, customMetadata {kind, sha256, zipByteSize}
 *   test-ids/<testId>.json    the claim that makes a TestId unique per site; never released
 *   deleted/<abx>.json        trash marker (saved-package-trash.mjs)
 *   events/<abx>/<nnnn>.json  numbered "marked live" / "marked stopped" events */
const MiB=1024*1024;
// file, bundle and zip equal the delivery limits of worker/test-workspace/deployment-contract.mjs (a test pins this).
export const AB_LIMITS=Object.freeze({file:8*MiB,bundle:12*MiB,zip:13*MiB,record:256*1024,summary:1800,armName:150,tests:100,events:50,pages:5,pageSize:100,name:60});
export const AB_EVENT_TYPES=Object.freeze(['marked-live','marked-stopped']);
export const AB_TEST_ID=/^abx-[a-f0-9]{64}$/;
const SITE=/^[a-z0-9][a-z0-9-]{0,97}$/,TEST_ID=/^[a-z0-9_]{1,24}$/,HASH=/^[a-f0-9]{64}$/;
const encode=new TextEncoder(),decode=new TextDecoder('utf-8',{fatal:true});
const createOnly=()=>new Headers({'If-None-Match':'*'});
const isRecord=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const canonical=v=>Array.isArray(v)?`[${v.map(canonical).join(',')}]`:isRecord(v)?`{${Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')}}`:JSON.stringify(v??null);
const fail=(status,message,code)=>{throw Object.assign(new Error(message),{status,...(code?{code}:{})});};
const unverified=()=>fail(409,'This saved A/B test does not match its stored record. Nothing was changed.','record-unverified');
const zipDiffers=()=>fail(409,'ZIP differs from its record.','zip-unverified');
// A stored object that is not what this module wrote: an R2 or storage fault, never the caller's input (503).
const storageFault=message=>{throw new Error(message);};
const contentType=path=>path.endsWith('.js')?'application/javascript; charset=utf-8':path.endsWith('.json')?'application/json; charset=utf-8'
  :path.endsWith('.zip')?'application/zip':'text/plain; charset=utf-8';

export const abPrefix=site=>{if(typeof site!=='string'||!SITE.test(site))throw new TypeError('Invalid A/B test site.');return `site-experiments/v1/${site}/`;};
const keys={
  record:(site,id)=>abPrefix(site)+`records/${id}.json`,
  file:(site,id,path)=>abPrefix(site)+`files/${id}/${path}`,
  zip:(site,id)=>abPrefix(site)+`zips/${id}.zip`,
  testId:(site,testId)=>abPrefix(site)+`test-ids/${testId}.json`,
  deleted:(site,id)=>abPrefix(site)+`deleted/${id}.json`,
  events:(site,id)=>abPrefix(site)+`events/${id}/`,
  event:(site,id,seq)=>abPrefix(site)+`events/${id}/${String(seq).padStart(4,'0')}.json`,
};
const checkId=id=>{if(typeof id!=='string'||!AB_TEST_ID.test(id))fail(404,'A/B test not found.');};

/** Cuts a name to at most AB_LIMITS.armName bytes of JSON-escaped UTF-8 (a control character counts six) on a
 * code-point boundary, adding … when cut, so version names alone can never overflow the summary. */
const escapedSize=text=>encode.encode(JSON.stringify(text)).length-2;
function cutName(name){
  if(escapedSize(name)<=AB_LIMITS.armName)return name;
  let out='',size=0;
  for(const ch of name){const n=escapedSize(ch);if(size+n>AB_LIMITS.armName)break;out+=ch;size+=n;}
  return out+'…';
}
const arm=a=>({release:a.release,runtimeVersion:a.runtimeVersion,name:cutName(a.name)});
/** The list summary kept in the record's customMetadata (at most AB_LIMITS.summary bytes of JSON). */
export function abSummary(record){
  return {id:record.id,name:record.name,testId:record.testId,trafficBPercent:record.trafficBPercent,createdAt:record.createdAt,createdBy:record.createdBy,
    zipSha256:record.bundle.zipSha256,prebidVersion:record.prebid?.version??null,fileCount:record.bundle.files.length,
    arms:{A:arm(record.arms.A),B:arm(record.arms.B)}};
}
const SUMMARY_KEYS='arms,createdAt,createdBy,fileCount,id,name,prebidVersion,testId,trafficBPercent,zipSha256';
function validSummary(s){
  const armOk=a=>isRecord(a)&&Object.keys(a).sort().join(',')==='name,release,runtimeVersion'&&['name','release','runtimeVersion'].every(k=>typeof a[k]==='string');
  return isRecord(s)&&Object.keys(s).sort().join(',')===SUMMARY_KEYS&&AB_TEST_ID.test(s.id)&&typeof s.name==='string'&&TEST_ID.test(s.testId)
    &&Number.isInteger(s.trafficBPercent)&&s.trafficBPercent>=0&&s.trafficBPercent<=100&&typeof s.createdAt==='string'&&Number.isFinite(Date.parse(s.createdAt))
    &&typeof s.createdBy==='string'&&HASH.test(s.zipSha256)&&(s.prebidVersion===null||typeof s.prebidVersion==='string')
    &&Number.isInteger(s.fileCount)&&s.fileCount>0&&isRecord(s.arms)&&Object.keys(s.arms).sort().join(',')==='A,B'&&armOk(s.arms.A)&&armOk(s.arms.B);
}

/** Bytes of an object this module stored, checked against its own sha256 metadata and the expected kind. */
async function storedBytes(bucket,key,{kind,max,sha256:expected}){
  const object=await bucket.get(key);
  if(!object)return null;
  const meta=object.customMetadata??{};
  if(meta.kind!==kind||!HASH.test(meta.sha256??'')||(expected&&meta.sha256!==expected)||!(object.size>0&&object.size<=max))return {object,bytes:null};
  const bytes=new Uint8Array(await object.arrayBuffer());
  if(bytes.length!==object.size||await sha256(bytes)!==meta.sha256)return {object,bytes:null};
  return {object,bytes};
}
/** Create-only put that accepts existing identical bytes and reads every write back. */
async function immutablePut(bucket,key,bytes,{kind,max,metadata={}}){
  const digest=await sha256(bytes),entry={kind,max,sha256:digest};
  const existing=await storedBytes(bucket,key,entry);
  if(existing?.bytes)return digest;
  if(existing)storageFault('A stored A/B test file differs from its checksum.');
  // If a concurrent call created the same key, put returns null; never overwrite it.
  await bucket.put(key,bytes,{onlyIf:createOnly(),sha256:digest,
    httpMetadata:{contentType:contentType(key),cacheControl:'private, no-store'},customMetadata:{kind,sha256:digest,...metadata}});
  if(!(await storedBytes(bucket,key,entry))?.bytes)storageFault('The A/B test file was not stored.');
  return digest;
}
/** Every object under prefix, following the cursor; at most AB_LIMITS.pages pages. */
async function listAll(bucket,prefix,{include}={}){
  const objects=[];let cursor;
  for(let page=0;page<AB_LIMITS.pages;page++){
    const result=await bucket.list({prefix,limit:AB_LIMITS.pageSize,...(include?{include}:{}),...(cursor?{cursor}:{})});
    objects.push(...result.objects);
    if(!result.truncated)return objects;
    cursor=result.cursor;
  }
  return storageFault('Too many A/B test objects to list.');
}

/** The verified record, its exact bytes and their sha256, or null when the record does not exist.
 * Throws 409 record-unverified when it exists but is not exactly what the store wrote. An error while reading the
 * body is a storage fault (503 Retry), not a mismatch, so it is not caught here. */
async function readRecord(bucket,site,id){
  const object=await bucket.get(keys.record(site,id));
  if(!object)return null;
  const meta=object.customMetadata??{};
  if(meta.kind!=='ab-test-record'||!HASH.test(meta.sha256??'')||!(object.size>0&&object.size<=AB_LIMITS.record))unverified();
  const bytes=new Uint8Array(await object.arrayBuffer());
  try{
    const recordSha256=await sha256(bytes);
    if(bytes.length!==object.size||recordSha256!==meta.sha256)unverified();
    const record=JSON.parse(decode.decode(bytes));
    if(!isRecord(record)||record.schema!==AB_TEST_SCHEMA||record.site!==site||record.id!==id)unverified();
    if('abx-'+await sha256(encode.encode(abTestIdentity(record)))!==id)unverified();
    if(canonical(JSON.parse(meta.summary))!==canonical(abSummary(record)))unverified();
    return {record,bytes,recordSha256};
  }catch(error){if(error?.code==='record-unverified')throw error;return unverified();}
}
async function requireRecord(bucket,site,id){
  checkId(id);
  return (await readRecord(bucket,site,id))??fail(404,'A/B test not found.');
}
const deletedAtOf=async(bucket,site,id)=>(await deletedPackage(bucket,keys.deleted(site,id)))?.deletedAt??null;

function checkSizes(bundle,recordBytes){
  const tooLarge=()=>fail(422,'This A/B test is too large to store. Each file can be at most 8 MB, all files together 12 MB and the ZIP 13 MB. Choose smaller versions.','bundle-too-large');
  let total=0;
  for(const file of bundle.record.bundle.files){if(file.bytes>AB_LIMITS.file)tooLarge();total+=file.bytes;}
  if(total>AB_LIMITS.bundle||bundle.zip.length>AB_LIMITS.zip||recordBytes.length>AB_LIMITS.record)tooLarge();
}

/** Composes and stores one A/B test. a and b are saved packages as readPackage returns them.
 * Everything that can refuse runs before the first put, and the record is written last.
 * Returns {created, record, recordSha256, deletedAt}. Throws Error {status, code, check?}. */
export async function createAbTest(bucket,{site,actor,a,b,name,testId,trafficBPercent,now=new Date()}){
  if(typeof actor?.email!=='string'||!actor.email)throw new TypeError('An authenticated actor is required.');
  const bundle=await composeAbBundle({site,a,b,trafficBPercent,testId,name});
  const id=bundle.id,record={...bundle.record,createdBy:actor.email,createdAt:now.toISOString()};
  const recordBytes=encode.encode(JSON.stringify(record,null,2)+'\n');
  checkSizes(bundle,recordBytes);
  // Version names are cut to fit, so only the test name (and the actor) can make the summary too long.
  const summary=JSON.stringify(abSummary(record));
  if(encode.encode(summary).length>AB_LIMITS.summary)fail(422,'The test name is too long to store. Shorten the test name and try again.','names-too-long');
  // The same inputs give the same id: a saved test is returned as it is, with no write.
  const existing=await readRecord(bucket,site,id);
  if(existing)return {created:false,record:existing.record,recordSha256:existing.recordSha256,deletedAt:await deletedAtOf(bucket,site,id)};
  if((await listAll(bucket,abPrefix(site)+'records/')).length>=AB_LIMITS.tests)
    fail(409,`This TEST site has reached its lifetime limit of ${AB_LIMITS.tests} A/B tests. Deleted tests still count, because their bytes are kept.`,'limit');
  // The claim makes the TestId unique per site; a retry of this exact test reuses it.
  const claimKey=keys.testId(site,testId),claimBytes=encode.encode(JSON.stringify({schemaVersion:1,site,testId,id})),claimSha256=await sha256(claimBytes);
  await bucket.put(claimKey,claimBytes,{onlyIf:createOnly(),sha256:claimSha256,
    httpMetadata:{contentType:'application/json; charset=utf-8',cacheControl:'private, no-store'},customMetadata:{kind:'ab-test-id',sha256:claimSha256}});
  const claim=await storedBytes(bucket,claimKey,{kind:'ab-test-id',max:1024});
  if(!claim?.bytes)storageFault('The TestId claim was not stored.');
  const owner=JSON.parse(decode.decode(claim.bytes));
  if(owner.schemaVersion!==1||owner.site!==site||owner.testId!==testId||!AB_TEST_ID.test(owner.id))storageFault('The TestId claim is invalid.');
  if(owner.id!==id){
    // A claim without its record is a save that failed or is still running: the TestId is reserved for those exact values.
    if(!await bucket.get(keys.record(site,owner.id)))
      fail(409,`TestId ${testId} is reserved by an A/B test whose save has not finished. Each TestId is used once. Choose another TestId.`,'testid-taken');
    fail(409,`TestId ${testId} is already used by another A/B test on this site. Each TestId is used once. Choose another TestId.`,'testid-taken');
  }
  for(const path of Object.keys(bundle.files))await immutablePut(bucket,keys.file(site,id,path),bundle.files[path],{kind:'ab-bundle-file',max:AB_LIMITS.file});
  await immutablePut(bucket,keys.zip(site,id),bundle.zip,{kind:'ab-bundle-zip',max:AB_LIMITS.zip,metadata:{zipByteSize:String(bundle.zip.length)}});
  const recordSha256=await sha256(recordBytes);
  const put=await bucket.put(keys.record(site,id),recordBytes,{onlyIf:createOnly(),sha256:recordSha256,
    httpMetadata:{contentType:'application/json; charset=utf-8',cacheControl:'private, no-store'},customMetadata:{kind:'ab-test-record',sha256:recordSha256,summary}});
  const stored=await readRecord(bucket,site,id);
  if(!stored)storageFault('The A/B test record was not stored.');
  // put returns null when an identical concurrent create wrote the record first.
  if(put===null)return {created:false,record:stored.record,recordSha256:stored.recordSha256,deletedAt:await deletedAtOf(bucket,site,id)};
  if(stored.recordSha256!==recordSha256)storageFault('The A/B test record differs from what was written.');
  return {created:true,record:stored.record,recordSha256};
}

/** Every saved test of the site from the record summaries, newest first: {tests, deleted}.
 * Each item is abSummary(record) plus deletedAt; trashed tests are in deleted. */
export async function listAbTests(bucket,site){
  const prefix=abPrefix(site);
  const records=await listAll(bucket,prefix+'records/',{include:['customMetadata']});
  const trash=new Map();
  for(const object of await listAll(bucket,prefix+'deleted/')){
    const id=object.key.slice(prefix.length+'deleted/'.length).replace(/\.json$/,'');
    if(!AB_TEST_ID.test(id))continue;
    const marker=await deletedPackage(bucket,object.key);
    if(marker?.id===id)trash.set(id,marker.deletedAt);
  }
  const rows=records.map(object=>{
    const id=object.key.slice(prefix.length+'records/'.length).replace(/\.json$/,'');
    let summary;try{summary=JSON.parse(object.customMetadata?.summary??'null');}catch{unverified();}
    if(!validSummary(summary)||summary.id!==id||object.key!==keys.record(site,id))unverified();
    return {...summary,deletedAt:trash.get(id)??null};
  });
  rows.sort((x,y)=>y.createdAt.localeCompare(x.createdAt)||x.id.localeCompare(y.id));
  return {tests:rows.filter(r=>!r.deletedAt),deleted:rows.filter(r=>r.deletedAt)};
}

async function readEvents(bucket,site,id){
  const listed=(await listAll(bucket,keys.events(site,id))).map(o=>o.key).sort();
  if(listed.length>AB_LIMITS.events)unverified();
  const events=[];
  for(const [index,key] of listed.entries()){
    const seq=index+1;
    if(key!==keys.event(site,id,seq))unverified();
    const stored=await storedBytes(bucket,key,{kind:'ab-test-event',max:1024});
    if(!stored?.bytes)unverified();
    let event;try{event=JSON.parse(decode.decode(stored.bytes));}catch{unverified();}
    if(!isRecord(event)||Object.keys(event).sort().join(',')!=='at,by,id,schemaVersion,seq,type'||event.schemaVersion!==1||event.id!==id||event.seq!==seq
      ||!AB_EVENT_TYPES.includes(event.type)||typeof event.at!=='string'||!Number.isFinite(Date.parse(event.at))||typeof event.by!=='string')unverified();
    events.push(event);
  }
  return events;
}

/** {record, recordSha256, deletedAt, events}. 404 when missing, 409 record-unverified when it differs. */
export async function readAbTest(bucket,site,id){
  const {record,recordSha256}=await requireRecord(bucket,site,id);
  return {record,recordSha256,deletedAt:await deletedAtOf(bucket,site,id),events:await readEvents(bucket,site,id)};
}
/** The exact stored record bytes: {bytes, record, recordSha256}. */
export async function readAbRecordBytes(bucket,site,id){
  const {record,bytes,recordSha256}=await requireRecord(bucket,site,id);
  return {bytes,record,recordSha256};
}
/** The stored bundle ZIP, checked against its own size metadata and the record's zipSha256: {bytes, record, zipSha256}. */
export async function readAbZip(bucket,site,id){
  const {record}=await requireRecord(bucket,site,id);
  const object=await bucket.get(keys.zip(site,id));
  if(!object)zipDiffers();
  const meta=object.customMetadata??{};
  if(meta.kind!=='ab-bundle-zip'||!(object.size>0&&object.size<=AB_LIMITS.zip)||object.size!==Number(meta.zipByteSize)||meta.sha256!==record.bundle.zipSha256)zipDiffers();
  const bytes=new Uint8Array(await object.arrayBuffer());
  if(bytes.length!==object.size||await sha256(bytes)!==record.bundle.zipSha256)zipDiffers();
  return {bytes,record,zipSha256:record.bundle.zipSha256};
}

/** Trash (remove=true) or restore one test. body must be exactly {confirmId, sha256} with the ZIP sha256.
 * Bytes are never deleted; restore deletes only the marker. */
export async function changeAbTestDeletion(bucket,site,id,actor,body,remove){
  const {record}=await requireRecord(bucket,site,id);
  return changePackageDeletion(bucket,keys.deleted(site,id),{id,sha256:record.bundle.zipSha256,actor:actor.email},body,remove);
}

/** Adds the next numbered event. The first must be marked-live and each one must differ from the last. */
export async function addAbTestEvent(bucket,site,id,actor,type,now=new Date()){
  if(!AB_EVENT_TYPES.includes(type))fail(422,'Mark the test live or stopped.');
  await requireRecord(bucket,site,id);
  if(await deletedAtOf(bucket,site,id))fail(409,'This A/B test is deleted. Restore it before you mark it live or stopped.');
  const events=await readEvents(bucket,site,id),last=events.at(-1),n=last?.seq??0;
  if(n>=AB_LIMITS.events)fail(409,`This A/B test already has ${AB_LIMITS.events} live and stopped marks, the most it can keep.`);
  if(!last&&type!=='marked-live')fail(409,'Mark the test live before you mark it stopped.');
  if(last?.type===type)fail(409,type==='marked-live'?'This A/B test is already marked live.':'This A/B test is already marked stopped.');
  const event={schemaVersion:1,id,seq:n+1,type,at:now.toISOString(),by:actor.email};
  const bytes=encode.encode(JSON.stringify(event)),digest=await sha256(bytes);
  const put=await bucket.put(keys.event(site,id,n+1),bytes,{onlyIf:createOnly(),sha256:digest,
    httpMetadata:{contentType:'application/json; charset=utf-8',cacheControl:'private, no-store'},customMetadata:{kind:'ab-test-event',sha256:digest}});
  // A concurrent click took this number first.
  if(put===null)fail(409,'Someone else changed this test. Reload A/B tests.');
  if(!(await storedBytes(bucket,keys.event(site,id,n+1),{kind:'ab-test-event',max:1024,sha256:digest}))?.bytes)storageFault('The event was not stored.');
  return event;
}

/** The next free <slug>_<n> TestId of the site, for example test_site_1. */
export async function proposeTestId(bucket,site){
  const prefix=abPrefix(site)+'test-ids/',slug=site.replace(/[^a-z0-9]+/g,'_').slice(0,18);
  let n=0;
  for(const object of await listAll(bucket,prefix)){
    const match=object.key.slice(prefix.length).match(/^([a-z0-9_]{1,24})\.json$/)?.[1]?.match(/^(.*)_(\d+)$/);
    if(match&&match[1]===slug)n=Math.max(n,Number(match[2]));
  }
  const proposed=`${slug}_${n+1}`;
  return TEST_ID.test(proposed)?proposed:null;
}
