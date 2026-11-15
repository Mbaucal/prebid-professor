import {zipSync} from 'fflate';
import {sha256} from '../runtime/prebid-artifact-check.mjs';
import {describeCandidate} from '../runtime/draft-release-store.mjs';
import {PAGES_HEADERS} from '../../scripts/pages-release-verification.mjs';
import {AB_LOADER_CONFIG_SCHEMA,AB_LOADER_VERSION,renderAbLoader} from './ab-loader-1.0.0.mjs';
import registry from './ab-loader-registry.json' with {type:'json'};

/* Generic A/B bundle composer (MBA-416, layout publisher-ab-v1). It never rebuilds a script:
 * each arm is the exact saved ads.min.js of one version, and Prebid.js is the one file both
 * versions already ship.
 *
 * Input a, b: a saved package exactly as worker/site-runtime/releases.mjs readPackage returns it.
 *  - TEST draft (testOnly): {files, release}, release = the stored draft
 *    {id:'builtin-draft-<64 hex>', siteId, note, runtime, prebidBuild, packageSha256, ...};
 *    files['manifest.json'] is the candidate manifest (kind 'builtin-runtime-candidate').
 *  - MAIN release: {files, release, manifest}, release = the D1 releases row
 *    {id:'builtin-release-<64 hex>', publisher_id, notes, ...}; manifest kind 'builtin-runtime-release'.
 *  files maps a file name (ads.min.js, config.json, manifest.json, prebid.js, div-export.csv,
 *  min-height.css, sticky.css, ...) to its Uint8Array bytes. Everything compared below is read
 *  from these bytes, so both lines behave the same; release only supplies the id, the name
 *  (note or notes, 'Generated package' when empty) and the owning site, which must match. */
export const AB_TEST_SCHEMA='tessera-ab-test-1';
export const AB_BUNDLE_LAYOUT='publisher-ab-v1';
const SITE=/^[a-z0-9][a-z0-9-]{0,97}$/,TEST_ID=/^[a-z0-9_]{1,24}$/;
const RELEASE_ID=/^builtin-(draft|release)-[a-f0-9]{64}$/;
// Files that shape the page around the slots; both arms must leave the page the same.
const LAYOUT=[['div-export.csv','inventory-differs','ad positions'],['min-height.css','css-differs','reserved ad space'],['sticky.css','css-differs','sticky position styling']];
const STORAGE_APIS=['document.cookie','indexedDB','localStorage','sessionStorage'];
const encode=new TextEncoder(),decode=new TextDecoder('utf-8',{fatal:true});
const record=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const fail=(status,code,message,check)=>{throw Object.assign(new Error(message),{status,code,...(check?{check}:{})});};
const refuse=(code,message,check)=>fail(422,code,message,check);
const invalid=message=>fail(400,'invalid-request',message);
// Sorted keys at every level, so equal values give equal text whatever their key order.
const canonical=v=>Array.isArray(v)?`[${v.map(canonical).join(',')}]`:record(v)?`{${Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')}}`:JSON.stringify(v??null);
const same=(a,b)=>canonical(a)===canonical(b);
const sorted=list=>[...new Set(list)].sort();
const only=(list,other)=>list.filter(x=>!other.includes(x));
async function sri(bytes){
  const hash=new Uint8Array(await crypto.subtle.digest('SHA-384',bytes));
  return 'sha384-'+btoa(String.fromCharCode(...hash));
}
const json=(bytes,message)=>{try{return JSON.parse(decode.decode(bytes));}catch{return refuse('package-unverified',message,'packages');}};

/** Reads one saved version and checks its bytes against its own manifest. */
async function savedVersion(pkg,side){
  if(!record(pkg)||!record(pkg.files)||!record(pkg.release))refuse('package-incomplete',`Version ${side} is not a saved package. Choose a saved version under Releases.`,'packages');
  const id=pkg.release.id,files=pkg.files;
  if(typeof id!=='string'||!RELEASE_ID.test(id))refuse('package-unverified',`Version ${side} is not a saved built-in version. Choose a version saved under Releases.`,'packages');
  for(const name of ['ads.min.js','manifest.json','config.json'])
    if(!(files[name] instanceof Uint8Array)||!files[name].length)refuse('package-incomplete',`Version ${side} has no ${name}. Generate that version again, or choose another saved version.`,'packages');
  const unverified=`Version ${side} does not match its saved manifest. Generate that version again, or choose another saved version.`;
  const manifest=json(files['manifest.json'],unverified),config=json(files['config.json'],unverified);
  if(!record(manifest)||!record(config)||!record(manifest.runtime)||typeof manifest.siteId!=='string')refuse('package-unverified',unverified,'packages');
  const owner=pkg.release.siteId??pkg.release.publisher_id;
  if(owner!==undefined&&owner!==manifest.siteId)refuse('package-unverified',unverified,'packages');
  if(id.startsWith('builtin-draft-')){
    // The draft id is the hash of the site and the exact file inventory, so this re-proves every byte.
    let checked;try{checked=await describeCandidate(manifest.siteId,{files});}catch{refuse('package-unverified',unverified,'packages');}
    if(checked.descriptor.releaseId!==id)refuse('package-unverified',unverified,'packages');
  }else{
    const names=Object.keys(files).filter(n=>n!=='manifest.json').sort();
    if(manifest.kind!=='builtin-runtime-release'||manifest.releaseId!==id||!record(manifest.files)||!same(names,Object.keys(manifest.files).sort()))refuse('package-unverified',unverified,'packages');
    for(const name of names)if(!(files[name] instanceof Uint8Array)||await sha256(files[name])!==manifest.files[name]?.sha256)refuse('package-unverified',unverified,'packages');
  }
  const note=pkg.release.note??pkg.release.notes;
  return {side,id,siteId:manifest.siteId,name:typeof note==='string'&&note.trim()?note.trim():'Generated package',
    runtime:manifest.runtime,prebidVersion:manifest.prebidBuild?.version??null,config,files};
}

/** Hard compatibility checks, in a fixed order; the first failure refuses the test. */
async function compatibilityChecks(site,A,B){
  const checks=[];
  for(const v of [A,B])if(v.siteId!==site)refuse('site-differs',`Version ${v.side} belongs to site ${v.siteId}. Choose two saved versions of ${site}.`,'site');
  checks.push({check:'site',result:'same'});
  const pa=A.files['prebid.js'],pb=B.files['prebid.js'];
  if(!pa!==!pb)refuse('prebid-differs',`Version ${pa?'A':'B'} loads Prebid.js and version ${pa?'B':'A'} is GAM only. Choose two versions with the same Prebid setting.`,'prebid');
  if(pa&&await sha256(pa)!==await sha256(pb))refuse('prebid-differs','Versions A and B use different Prebid.js files. Generate both versions with the same Prebid build, then create the test again.','prebid');
  checks.push({check:'prebid',result:pa?'same':'gam-only'});
  // A script version can write a layout file differently from the same settings (3.20.0 changed
  // min-height.css), so across script versions aligning the settings alone may not help.
  const va=A.runtime.runtimeVersion,vb=B.runtime.runtimeVersion;
  for(const [name,code,what] of LAYOUT){
    const fa=A.files[name],fb=B.files[name];
    if(!fa!==!fb||(fa&&await sha256(fa)!==await sha256(fb)))refuse(code,va===vb
      ?`Versions A and B differ in ${what} (${name}). Both versions must lay out the page the same way: generate them from the same ad positions, size maps and sticky settings, or choose other versions.`
      :`Versions A and B differ in ${what} (${name}), and they were generated with different script versions (${va} and ${vb}), which can write this file differently even from the same settings. The page keeps one layout for both groups: choose two versions whose ${name} files match, for example both generated with script ${vb} from the same ad positions, size maps and sticky settings.`,name);
    checks.push({check:name,result:fa?'same':'absent'});
  }
  const ga=A.config.core?.gamPath??null,gb=B.config.core?.gamPath??null;
  if(ga!==gb)refuse('gam-path-differs',`Versions A and B use different GAM ad unit paths (${ga} and ${gb}). Choose two versions with the same GAM path.`,'gamPath');
  checks.push({check:'gamPath',result:'same'});
  for(const [what,read] of [['the CMP timeout (core.maxCmpTimeout)',c=>c.core?.maxCmpTimeout],['user sync (core.userSync)',c=>c.core?.userSync],['the country lookup (countrySignal)',c=>c.countrySignal]])
    if(!same(read(A.config),read(B.config)))refuse('consent-differs',`Versions A and B differ in ${what}. Consent, user sync and country lookup must be the same in both groups: generate both versions with the same setting, or choose other versions.`,'consent');
  checks.push({check:'consent',result:'same'});
  return checks;
}

// Storage the arm may touch: storage APIs its code names, and the TakeOver interval cap,
// which is kept in sessionStorage. A difference is reported, never refused.
function storageUse(v){
  const text=new TextDecoder().decode(v.files['ads.min.js']);
  return {apis:STORAGE_APIS.filter(api=>text.includes(api)),takeOverIntervalMinutes:v.config.adPosition?.frequencyMinutes??0};
}
function warnings(A,B){
  const list=[];
  if(A.runtime.runtimeVersion!==B.runtime.runtimeVersion)list.push({code:'runtime-differs',a:A.runtime.runtimeVersion,b:B.runtime.runtimeVersion,
    message:`Versions A and B run different script versions (${A.runtime.runtimeVersion} and ${B.runtime.runtimeVersion}). The result measures every change between them.`});
  const ca=sorted(A.runtime.capabilities??[]),cb=sorted(B.runtime.capabilities??[]);
  if(!same(ca,cb))list.push({code:'capabilities-differ',a:only(ca,cb),b:only(cb,ca),
    message:'Versions A and B have different script capabilities. Check that only the feature under test differs.'});
  const sa=storageUse(A),sb=storageUse(B);
  if(!same(sa,sb))list.push({code:'storage-differs',a:sa,b:sb,
    message:'Versions A and B use browser storage differently. Each version keeps its own consent handling; check that this is expected.'});
  return list;
}

const bidCache=c=>{const p=Object.entries(c.bidCache?.positions??{}).filter(([,on])=>on===true).map(([code])=>code).sort();return {on:p.length>0,maxAge:p.length?c.bidCache.maxAgeSeconds??null:null,positions:p};};
const bidderSettings=(c,code)=>({params:(c.core?.bidders??[]).filter(b=>b.bidder===code).map(b=>b.params??null),
  slot:c.core?.bidderSlotParams?.[code]??null,device:c.core?.bidderDeviceParams?.[code]??null,adUnit:c.core?.bidderAdUnitParams?.[code]??null});
const ruleField=(c,field)=>Object.fromEntries(Object.keys(c.core?.adUnitRules??{}).sort().filter(k=>c.core.adUnitRules[k]?.[field]!==undefined).map(k=>[k,c.core.adUnitRules[k][field]]));
// [field, read, list]: for a list field, a and b hold only the items the other side lacks.
const DIFF=[
  ['runtimeVersion',v=>v.runtime.runtimeVersion??null],
  ['capabilities',v=>sorted(v.runtime.capabilities??[]),true],
  ['bidCache.enabled',v=>bidCache(v.config).on],
  ['bidCache.maxAgeSeconds',v=>bidCache(v.config).maxAge],
  ['bidCache.positions',v=>bidCache(v.config).positions,true],
  ['refresh.default',v=>v.config.core?.globalRefresh??null],
  ['refresh.rules',v=>ruleField(v.config,'refresh')],
  ['refresh.stickySeconds',v=>v.config.options?.sticky?.refreshSeconds??null],
  ['floors',v=>v.config.options?.floors??null],
  ['bidders',v=>sorted((v.config.core?.bidders??[]).map(b=>b.bidder)),true],
  ['timeouts',v=>({default:v.config.core?.defaultTimeout??null,atf:v.config.core?.atfTimeout??null,btf:v.config.core?.btfTimeout??null,sticky:v.config.core?.stickyTimeout??null})],
  ['timeouts.rules',v=>ruleField(v.config,'timeout')],
];
// config.json paths left out of otherSettings: build stamps and the script pin differ on every
// build, the prebid check compares the Prebid.js file itself, and DIFF above reports the rest.
const NOT_OTHER=new Set(['runtime','prebidBuild','bidCache','core.buildVersion','core.generatorProfileId','options.buildTimestamp',
  'core.globalRefresh','options.floors','core.bidders','core.bidderSlotParams','core.bidderDeviceParams','core.bidderAdUnitParams',
  'core.defaultTimeout','core.atfTimeout','core.btfTimeout','core.stickyTimeout']);
// Values DIFF reports only in part: compare what is left.
const PARTLY={'core.adUnitRules':rules=>Object.fromEntries(Object.entries(rules??{}).map(([key,rule])=>{const {refresh,timeout,...rest}=rule??{};return [key,rest];})),
  'options.sticky':sticky=>{const {refreshSeconds,...rest}=sticky??{};return rest;}};
/** Every other setting that differs, as {path: value} on each side, so two versions whose settings
 * differ never show an empty summary. Paths are top-level keys and, for objects, their children.
 * A top-level key only one script version writes is a schema change between versions, which the
 * runtime and capability entries already report; a child missing on one side compares as null. */
function otherSettings(ca,cb){
  const a={},b={};
  const compare=(path,va,vb)=>{
    if(NOT_OTHER.has(path))return;
    const read=PARTLY[path]??(v=>v??null),x=read(va),y=read(vb);
    if(!same(x,y)){a[path]=x;b[path]=y;}
  };
  for(const key of sorted([...Object.keys(ca),...Object.keys(cb)])){
    if(!Object.hasOwn(ca,key)||!Object.hasOwn(cb,key)||NOT_OTHER.has(key))continue;
    if(record(ca[key])&&record(cb[key]))for(const child of sorted([...Object.keys(ca[key]),...Object.keys(cb[key])]))compare(`${key}.${child}`,ca[key][child],cb[key][child]);
    else compare(key,ca[key],cb[key]);
  }
  return Object.keys(a).length?{field:'otherSettings',a,b}:null;
}
/** The summary of differences: [{field, a, b}] in DIFF order, only for fields that differ, then otherSettings. */
function configDiff(A,B){
  const list=[];
  for(const [field,read,isList] of DIFF){
    const a=read(A),b=read(B);
    if(!same(a,b))list.push(isList?{field,a:only(a,b),b:only(b,a)}:{field,a,b});
    // Bidder settings follow the bidder list: only bidders on both sides, only where they differ.
    if(field==='bidders'){
      const changed=a.filter(code=>b.includes(code)&&!same(bidderSettings(A.config,code),bidderSettings(B.config,code)));
      if(changed.length)list.push({field:'bidderParams',a:Object.fromEntries(changed.map(c=>[c,bidderSettings(A.config,c)])),b:Object.fromEntries(changed.map(c=>[c,bidderSettings(B.config,c)]))});
    }
  }
  const other=otherSettings(A.config,B.config);
  if(other)list.push(other);
  return list;
}

/** The text the test id hashes: everything that defines the bundle except the id itself,
 * so ads.js (which embeds the id), the ZIP, createdBy and createdAt are left out. Derived
 * compatibility and configDiff are left out too: saving the same test again keeps its id. */
export function abTestIdentity(record){
  return canonical({schema:record.schema,layout:record.bundle.layout,site:record.site,name:record.name,testId:record.testId,
    trafficBPercent:record.trafficBPercent,arms:record.arms,prebid:record.prebid,loader:record.loader,
    files:record.bundle.files.filter(f=>f.path!=='ads.js')});
}
// Stored entries at a fixed 1980 time, sorted, as the package download ZIP (releases.mjs) does.
const zip=files=>zipSync(Object.fromEntries(Object.keys(files).sort().map(p=>[p,[files[p],{level:0,mtime:new Date(1980,0,1)}]])),{level:0});

async function arm(v){
  const bytes=v.files['ads.min.js'];
  return {release:v.id,name:v.name,runtimeVersion:v.runtime.runtimeVersion,path:`r/${v.id}/ads.js`,sha256:await sha256(bytes),integrity:await sri(bytes)};
}
function validate({site,a,b,trafficBPercent,testId,name}){
  if(typeof site!=='string'||!SITE.test(site))invalid('Choose a site for the test.');
  if(typeof name!=='string'||!name.trim()||name.length>60)invalid('Give the test a name of 1 to 60 characters.');
  if(typeof testId!=='string'||!TEST_ID.test(testId))invalid('Use a TestId of 1 to 24 lowercase letters, digits or underscores, for example "site_1".');
  if(!Number.isInteger(trafficBPercent)||trafficBPercent<0||trafficBPercent>100)invalid('Use a whole number from 0 to 100 for the B traffic share.');
  if(a==null||b==null)invalid('Choose a saved version for both A and B.');
}

/** Compatibility result and summary of differences without building a bundle (for a dry run).
 * {compatible, refusal:{code, check, message}|null, checks, warnings, configDiff|null} */
export async function checkAbCompatibility({site,a,b}){
  let A,B,diff=null,notes=[];
  try{
    if(typeof site!=='string'||!SITE.test(site))invalid('Choose a site for the test.');
    A=await savedVersion(a,'A');B=await savedVersion(b,'B');diff=configDiff(A,B);notes=warnings(A,B);
    return {compatible:true,refusal:null,checks:await compatibilityChecks(site,A,B),warnings:notes,configDiff:diff};
  }catch(e){
    if(e.status!==422)throw e;
    return {compatible:false,refusal:{code:e.code,check:e.check??null,message:e.message},checks:[],warnings:notes,configDiff:diff};
  }
}

/** Builds the publisher-ab-v1 bundle of one A/B test. Throws Error {status:400, code:'invalid-request'}
 * for invalid fields and {status:422, code, check} when the versions cannot be compared. */
export async function composeAbBundle({site,a,b,trafficBPercent,testId,name}){
  validate({site,a,b,trafficBPercent,testId,name});
  const A=await savedVersion(a,'A'),B=await savedVersion(b,'B');
  const checks=await compatibilityChecks(site,A,B);
  const arms={A:await arm(A),B:await arm(B)};
  const files={_headers:encode.encode(PAGES_HEADERS)};
  if(A.files['prebid.js'])files['prebid.js']=A.files['prebid.js'].slice();
  // For A/A both arms name the same path, so the bundle holds one arm file.
  for(const v of [A,B])files[`r/${v.id}/ads.js`]=v.files['ads.min.js'].slice();
  const inventory=async()=>Promise.all(Object.keys(files).sort().map(async path=>({path,sha256:await sha256(files[path]),bytes:files[path].length})));
  const loader={version:AB_LOADER_VERSION,sha256:registry[AB_LOADER_VERSION].sha256};
  const prebid=files['prebid.js']?{sha256:await sha256(files['prebid.js']),version:A.prebidVersion}:null;
  const record={schema:AB_TEST_SCHEMA,id:null,site,name,testId,trafficBPercent,arms,prebid,loader,
    compatibility:{checks,warnings:warnings(A,B)},configDiff:configDiff(A,B),
    bundle:{layout:AB_BUNDLE_LAYOUT,files:await inventory(),zipSha256:null},createdBy:null,createdAt:null};
  record.id='abx-'+await sha256(encode.encode(abTestIdentity(record)));
  files['ads.js']=encode.encode(renderAbLoader({schema:AB_LOADER_CONFIG_SCHEMA,id:record.id,testId,name,trafficBPercent,arms,loader}));
  const ordered=Object.fromEntries(Object.keys(files).sort().map(p=>[p,files[p]]));
  const archive=zip(ordered);
  record.bundle={layout:AB_BUNDLE_LAYOUT,files:await inventory(),zipSha256:await sha256(archive)};
  return {id:record.id,record,files:ordered,zip:archive,zipSha256:record.bundle.zipSha256};
}
