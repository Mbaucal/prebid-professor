// MBA-396: one-off maintenance of the explicitly authorized TEST draft packages.
// No publisher settings, runtime sources, Prebid library or deployment ZIPs change.
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

export const TARGET = Object.freeze({account:'b5e5e6f70b811e8f97af71df1af46308',
  database:'d27843e4-a53c-403a-baed-04a193f6d5c6', bucket:'prebid-professor-test-builds',site:'test-site'});
const HASH=/^[a-f0-9]{64}$/;
const FILES=new Set(['README.txt','ads.js','ads.min.js','config.json','div-export.csv','implementation.html','manifest.json','min-height.css','sticky.css','prebid.js','gam-reporting.json','deals-plan.json']);
const assert=(ok,message)=>{if(!ok)throw Error(message);};
export const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function planRows(rows, now=Date.now()) {
  assert(Array.isArray(rows)&&rows.length<=20,'Unexpected TEST package count.');
  return rows.map(row=>{
    const d=JSON.parse(row.descriptor_json);
    assert(row.publisher_id===TARGET.site&&d.siteId===TARGET.site,'Foreign site refused.');
    assert(HASH.test(d.packageSha256)&&d.packageSha256===row.package_sha256&&row.release_id==='builtin-draft-'+d.packageSha256&&d.releaseId===row.release_id,'Package identity mismatch.');
    assert(d.kind==='builtin-stored-draft'&&d.completeRelease===false,'Only generated drafts may be removed.');
    assert(row.state==='stored'&&row.release_status==='draft'&&row.published_at===null&&row.current_release_id!==row.release_id,'Only stored, unpublished drafts may be removed.');
    assert(Number.isFinite(Date.parse(row.created_at))&&Date.parse(row.created_at)<now-600000,'Recent upload refused.');
    assert(Array.isArray(d.files)&&d.files.length>=9&&d.files.length<=12&&new Set(d.files.map(f=>f.name)).size===d.files.length,'Invalid file inventory.');
    assert(d.files.every(f=>FILES.has(f.name)&&HASH.test(f.sha256)&&Number.isSafeInteger(f.byteSize)&&f.byteSize>0&&f.byteSize<=8388608),'Invalid package files.');
    assert(hash({siteId:TARGET.site,inventory:d.files})===d.packageSha256,'Package inventory checksum differs.');
    for(const [column,name] of [['ads_js_key','ads.js'],['ads_min_js_key','ads.min.js'],['config_key','config.json'],['manifest_key','manifest.json']])
      assert(row[column]===`publishers/${TARGET.site}/releases/${row.release_id}/${name}`,'Release key outside reviewed package.');
    return {id:row.release_id,packageSha256:d.packageSha256,createdAt:row.created_at,runtimeVersion:d.runtime.runtimeVersion,
      descriptorHash:hash(row.descriptor_json),files:d.files.map(f=>({key:`publishers/${TARGET.site}/releases/${row.release_id}/${f.name}`,sha256:f.sha256,byteSize:f.byteSize}))};
  }).sort((a,b)=>a.id.localeCompare(b.id));
}
export function cfClient(token,fetcher=fetch){
  assert(typeof token==='string'&&token.length>=20,'Configured Cloudflare maintenance credential unavailable.');
  return async(path,options={})=>{
    assert(path.startsWith(`/accounts/${TARGET.account}/`),'Foreign account refused.');
    const r=await fetcher('https://api.cloudflare.com/client/v4'+path,{...options,redirect:'error',signal:AbortSignal.timeout(30000),
      headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...options.headers}});
    if(r.status===404&&options.allowMissing)return null;
    assert(r.ok,`Cloudflare operation failed: HTTP ${r.status}.`);
    if(options.raw)return r;
    const body=await r.json();
    assert(body.success===true,`Cloudflare operation rejected (${(body.errors||[]).map(e=>e.code).join(',')}).`);
    return body.result;
  };
}
export async function inspect(client){
  const query=async(sql,params=[])=>{
    const result=await client(`/accounts/${TARGET.account}/d1/database/${TARGET.database}/query`,{method:'POST',body:JSON.stringify({sql,params})});
    assert(result.length===1&&result[0].success,'D1 read failed.');return result[0].results;
  };
  const [marker]=await query('SELECT * FROM tessera_test_environment WHERE id=1');
  assert(marker?.database_id===TARGET.database&&marker.bucket_name===TARGET.bucket,'TEST identity marker differs.');
  const rows=await query(`SELECT u.*,r.status AS release_status,r.published_at,r.ads_js_key,r.ads_min_js_key,r.config_key,r.manifest_key,p.current_release_id
    FROM builtin_draft_uploads u LEFT JOIN releases r ON r.id=u.release_id AND r.publisher_id=u.publisher_id
    LEFT JOIN publishers p ON p.id=u.publisher_id ORDER BY u.release_id`);
  const plan=planRows(rows);
  // Read access to the precise bucket is checked before any cleanup can be approved.
  const bucket=await client(`/accounts/${TARGET.account}/r2/buckets/${TARGET.bucket}`);
  assert(bucket.name===TARGET.bucket,'TEST bucket identity differs.');
  const configTables=['publishers','publisher_configs','ad_units','bidders','bidder_overrides','size_maps','unit_rules','prebid_builds'];
  const fingerprints={};
  for(const table of configTables)fingerprints[table]=hash(await query(`SELECT * FROM ${table} ORDER BY id`));
  const ledger=await client(`/accounts/${TARGET.account}/r2/buckets/${TARGET.bucket}/objects/test-deployments/v1/state.json`,{raw:true,allowMissing:true});
  let delivery={present:false};
  if(ledger){const state=await ledger.json();assert(Array.isArray(state.runs),'Invalid TEST delivery history.');delivery={present:true,sha256:hash(state),runs:state.runs.length};}
  return {target:TARGET,count:plan.length,files:plan.reduce((n,p)=>n+p.files.length,0),bytes:plan.reduce((n,p)=>n+p.files.reduce((s,f)=>s+f.byteSize,0),0),planHash:hash(plan),plan,fingerprints,delivery};
}
export async function main(){
  assert(process.env.GITHUB_REPOSITORY==='Mbaucal/prebid-professor'&&process.env.GITHUB_REF==='refs/heads/ops/mba396-test-package-cleanup','Dedicated maintenance branch required.');
  const request=JSON.parse(readFileSync(new URL('../ops/runtime-test/package-cleanup.json',import.meta.url),'utf8'));
  assert(request.operation==='inspect'&&request.issue==='MBA-396','Only inspection is currently enabled.');
  const result=await inspect(cfClient(process.env.CLOUDFLARE_API_TOKEN));
  console.log('TEST_PACKAGE_INVENTORY '+JSON.stringify(result));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{console.error(error.message);process.exitCode=1;});
