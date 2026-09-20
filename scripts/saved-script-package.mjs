import assert from 'node:assert/strict';
import {minify} from 'terser';
import {zipSync,unzipSync} from 'fflate';
import {sha256,integrity} from './static-aa-package.mjs';
import {configurePreparedArm,preparePackageTemplates} from '../worker/experiments/configurable-cache-v1.mjs';
import {savedScriptLoader,scriptSettings,displayName,SCRIPT_ID} from '../worker/experiments/saved-scripts-v1.mjs';

export const BASELINE_SHA='bd0d9a6973903a3ec585f88e4b815eefb7a061ec8a32593f671b53ce211dfb1e';
const SOURCE_SHA='0faec2eccdcedbd29153357c7a94c879cdec4a8d037b16593a94a7884f242e2b';
const PREBID_SHA='384daae36c4fb334e16229d7f3e4b7a2c2caf9c0344580bdca7b185c756bb10b';
const SENTINEL='tanjug-ab-2.0.0-'+'0'.repeat(64),TEST_SENTINEL='tanjug-test-1.0.0-'+'0'.repeat(64);
const compact=async source=>Buffer.from((await minify(source,{ecma:2020,compress:true,mangle:true,sourceMap:false,format:{comments:false}})).code+'\n');
const archive=files=>zipSync(Object.fromEntries(Object.keys(files).sort().map(n=>[n,[files[n],{level:6,mtime:new Date(1980,0,1)}]])),{level:6});
const inventory=files=>Object.fromEntries(Object.entries(files).map(([name,bytes])=>[name,{bytes:bytes.length,sha256:sha256(bytes)}]));
function inputs({base,previousArchive,preparedTemplates}) {
  assert.equal(sha256(base),SOURCE_SHA);assert.equal(sha256(previousArchive),BASELINE_SHA);
  const previous=unzipSync(previousArchive);assert.equal(sha256(previous['prebid.js']),PREBID_SHA);
  const recipe=preparedTemplates??preparePackageTemplates(Buffer.from(base).toString());
  const files=Object.fromEntries(['prebid.js','sticky.css','min-height.css','_headers','404.html'].map(n=>[n,previous[n]]));
  const prebidPath=`releases/prebid-${PREBID_SHA}/prebid.js`;files[prebidPath]=previous['prebid.js'];
  return {recipe,files,context:{baseRuntime:'3.9.1',prebidVersion:'11.34.0',prebidPath,prebidIntegrity:integrity(previous['prebid.js']),
    positions:['Billboard','Billboard_2','Billboard_3','Branding_Left','Branding_Right',...Array.from({length:8},(_,i)=>`P${i+1}`),...Array.from({length:5},(_,i)=>`InText_${i+1}`),'Sticky']}};
}

export async function buildSavedScript(args) {
  const name=displayName(args.name),settings=scriptSettings(args.settings),{recipe,files,context}=inputs(args);
  const paired={schemaVersion:1,trafficBPercent:50,arms:{A:settings,B:settings}};
  let source=configurePreparedArm(settings.mode==='fresh-only'?recipe.fresh:recipe.cached,'A',paired,SENTINEL);
  const guard='window.__adVariantDelivery.release !== '+JSON.stringify(SENTINEL);
  assert.equal(source.split(guard).length,2);
  source=source.replace(guard,'window.__adVariantDelivery.scriptRelease !== '+JSON.stringify(SENTINEL));
  const template=await compact(source);
  // Include actual compiled loader bytes in identity; no request-time function.toString().
  const loaderFingerprint=await compact(savedScriptLoader(recipe.loader,{...context,release:TEST_SENTINEL,deliveryMode:'single',script:{}}));
  const id='tanjug-script-1.0.0-'+sha256(Buffer.concat([Buffer.from(JSON.stringify({profile:1,name,settings,baseline:BASELINE_SHA})),template,loaderFingerprint]));
  const runtime=Buffer.from(template.toString().replaceAll(SENTINEL,id)),path=`releases/${id}/runtime.js`;
  const script={id,name,settings,path,sha256:sha256(runtime),integrity:integrity(runtime)};
  files[path]=runtime;
  const config={...context,release:id,deliveryMode:'single',script};
  files['ads.js']=await compact(savedScriptLoader(recipe.loader,config));
  const manifest={schemaVersion:1,kind:'saved-script-v1',id,name,baseline:BASELINE_SHA,settings,script,config,files:inventory(files)};
  const bytes=archive(files);return {id,name,settings,manifest,archive:bytes,archiveSha256:sha256(bytes)};
}

export function verifySavedScript(manifest,bytes) {
  assert.equal(manifest.kind,'saved-script-v1');assert.equal(manifest.schemaVersion,1);assert.equal(manifest.baseline,BASELINE_SHA);
  assert(SCRIPT_ID.test(manifest.id));assert.equal(displayName(manifest.name),manifest.name);scriptSettings(manifest.settings);
  const seen=new Set();let total=0;
  const files=unzipSync(bytes,{filter(entry){const e=manifest.files[entry.name];assert(!seen.has(entry.name)&&e&&e.bytes===entry.originalSize&&e.bytes>0&&e.bytes<2*1024*1024);seen.add(entry.name);total+=e.bytes;assert(total<8*1024*1024);return true;}});
  assert.deepEqual(Object.keys(files).sort(),Object.keys(manifest.files).sort());
  assert.equal(Object.keys(files).length,8);
  for(const [name,meta] of Object.entries(manifest.files))assert.equal(sha256(files[name]),meta.sha256);
  const s=manifest.script;assert.equal(s.id,manifest.id);assert.equal(s.name,manifest.name);assert.deepEqual(s.settings,manifest.settings);
  assert.equal(s.path,`releases/${s.id}/runtime.js`);assert.equal(sha256(files[s.path]),s.sha256);assert.equal(integrity(files[s.path]),s.integrity);
  assert.equal(sha256(files['prebid.js']),PREBID_SHA);
  return files;
}

/** Compose the exact saved runtime bytes; never rebuild scripts from current settings. */
export async function buildSavedTest(args) {
  const name=displayName(args.name),trafficBPercent=args.trafficBPercent;
  assert(Number.isInteger(trafficBPercent)&&trafficBPercent>=0&&trafficBPercent<=100,'B traffic must be 0–100%.');
  const {recipe,files,context}=inputs(args),scripts={},runtimes={};
  for(const v of ['A','B']){
    const saved=args.scripts[v],parts=verifySavedScript(saved.manifest,saved.archive);
    for(const [path,bytes] of Object.entries(files))assert.deepEqual(parts[path],bytes,'Scripts have incompatible dependencies.');
    scripts[v]=saved.manifest.script;runtimes[scripts[v].path]=parts[scripts[v].path];
  }
  Object.assign(files,runtimes);
  const template=await compact(savedScriptLoader(recipe.loader,{...context,release:TEST_SENTINEL,deliveryMode:'ab',name,trafficBPercent,scripts}));
  const id='tanjug-test-1.0.0-'+sha256(template);
  files['ads.js']=Buffer.from(template.toString().replaceAll(TEST_SENTINEL,id));
  const config={...context,release:id,deliveryMode:'ab',name,trafficBPercent,scripts};
  const manifest={schemaVersion:1,kind:'saved-test-v1',id,name,baseline:BASELINE_SHA,trafficBPercent,scripts,config,files:inventory(files)};
  const bytes=archive(files);return {id,name,trafficBPercent,scripts,manifest,archive:bytes,archiveSha256:sha256(bytes)};
}
