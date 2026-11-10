/** Independent MBA-397 package fixtures. Never invokes live demand. */
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const candidateRoot=resolve(process.argv[2]||'.');
const out=resolve(process.argv[3]||'.generated/qa-gam-codes');
const version=process.argv[4]||'3191';
const from=path=>import(pathToFileURL(resolve(candidateRoot,path)).href);
const {buildArtifactCandidate}=await from(`worker/runtime-${version}/artifact-candidate.mjs`);
const {descriptor}=await from(`.generated/runtime-${version}-manifest.mjs`);
const {previewInput}=await from(`worker/runtime-${version}/snapshot.mjs`);
const {pinRuntime}=await from('worker/runtime/version-pin.mjs');
const {prebidRequirements,inspectPrebidArtifact,sha256}=await from('worker/runtime/prebid-artifact-check.mjs');
await mkdir(out,{recursive:true});
const codes=['m.box_3','m.InText_1','1Banner','_leading','-leading','.leading','slot:main','slot*main','slot"main','slot\\main','slot/main','slot!main','slot<main','slot(main)','Članak','投放','__proto__','constructor','prototype','toString','hasOwnProperty','A'.repeat(100),'mixed._-:*"\\/!<()'];
function snapshot(prebid){return {
 site:{id:'code-qa',name:'Code identity QA',domain:'example.invalid',gam_path:'/123/test/'},
 config:{config_json:JSON.stringify({enablePrebid:prebid,userSync:{syncEnabled:false,userIds:[]},runtimeControls:{sticky:{bottomAdUnitId:''},floors:{enabled:false},currencyConversion:{enabled:false},output:{cleanComments:true}}})},
 units:[],maps:[{name:'base',map_json:JSON.stringify([{viewport:[0,0],sizes:[[300,250]]}])},{name:'home',map_json:JSON.stringify([{viewport:[0,0],sizes:[[300,100]]}])}],
 rules:[{rule_key:'__DEFAULT__',rule_json:JSON.stringify({refresh:{enabled:false},lazy:{enabled:false}})}],
 bidders:prebid?[{bidder:'ix',enabled:1,params_json:'{"siteId":"fixture"}'}]:[],overrides:[]};}
const unit=code=>({code,type:'ATF',enabled:1,media_type:'banner',size_map_key:'base'});
function configure(s,fn){const c=JSON.parse(s.config.config_json);fn(c);s.config.config_json=JSON.stringify(c);}
async function checked(s,input){const requirements=prebidRequirements(input,JSON.parse(s.config.config_json));if(!requirements.required)return null;
 const bytes=new TextEncoder().encode(`/* prebid.js v11.11.0\nModules: ${requirements.modules.join(', ')} */\nvoid 0;`).buffer;
 const build={id:'fixture-build',publisher_id:s.site.id,status:'current',version:'11.11.0',file_key:`publishers/${s.site.id}/prebid-builds/fixture-build/prebid.js`,modules_json:JSON.stringify(requirements.modules)};
 const object={size:bytes.byteLength,customMetadata:{sha256:await sha256(bytes),version:'11.11.0'},async arrayBuffer(){return bytes;}};
 const report=await inspectPrebidArtifact({siteId:s.site.id,builds:[build],requirements},{async get(){return object;}});return{bytes,report};}
const plan=[];
for(const mode of ['gam','prebid']){
 const s=snapshot(mode==='prebid');s.units=codes.map(unit);
 s.overrides=mode==='prebid'?codes.map(code=>({bidder:'ix',scope_type:'adunit',scope_key:code,enabled:1,params_json:JSON.stringify({siteId:'exact-'+code,unrelated:code})})):[];
 s.rules.push({rule_key:'m.box_3',rule_json:JSON.stringify({conditionalMappings:[{id:'home',name:'Homepage',enabled:true,priority:100,match:'all',conditions:[{id:'category',key:'category',operator:'equals',value:'Naslovna'}],sizeMapKey:'home',slotAction:'inherit'}]})});
 plan.push({name:'all-'+mode,mode,s,kind:'banner',codes,home:'m.box_3'});
 for(const code of ['m.Sticky','1Sticky','sticky"\\<:!()*','__proto__']){
  const t=snapshot(mode==='prebid');t.units=[unit('Control'),unit(code)];configure(t,c=>c.runtimeControls.sticky.bottomAdUnitId=code);
  plan.push({name:'sticky-'+mode+'-'+plan.length,mode,s:t,kind:'sticky',codes:['Control',code],sticky:code});
 }
 for(const code of ['m.Overlay','overlay"\\<:!()*']){
  const t=snapshot(mode==='prebid');t.units=[unit('Control'),unit(code)];
  configure(t,c=>c.runtimeControls.adPositions=Object.fromEntries([[code,{demand:mode==='prebid'?'site':'gam',desktopMinWidth:1024,desktopSeconds:0,mobileSeconds:0,countdown:false,frequencyMinutes:0}]]));
  plan.push({name:'overlay-'+mode+'-'+plan.length,mode,s:t,kind:'overlay',codes:['Control',code],overlay:code});
 }
 {
  const t=snapshot(mode==='prebid'),lazyCodes=['m.InText_1','lazy\"\\<:!()*','__proto__'];t.units=lazyCodes.map(code=>({...unit(code),type:'BTF'}));
  t.rules=[{rule_key:'__DEFAULT__',rule_json:JSON.stringify({refresh:{enabled:false},lazy:{enabled:true,fetchMarginPx:500,renderMarginPx:0}})}];
  plan.push({name:'lazy-'+mode,mode,s:t,kind:'lazy',codes:lazyCodes});
 }
 for(const code of ['m.Legacy','legacy\"\\<:!()*']){
  const t=snapshot(mode==='prebid');t.units=[unit('Control')];
  const takeOver={enabled:true,adUnitCode:code,codelessAdUnitPath:'/123/test/Interstitial',desktopSize:[800,600],mobileSize:[300,250],desktopMinWidth:1024,autoCloseDesktopSec:0,autoCloseMobileSec:0};
  plan.push({name:'legacy-'+mode+'-'+plan.length,mode,s:t,kind:'legacy',codes:['Control'],overlay:code,takeOver});
 }
}
const results=[];
for(const p of plan){try{
 const before=JSON.stringify(p.s);const input=previewInput(p.s,descriptor,'20261109_230000',p.takeOver,'test');
 const prebid=await checked(p.s,input),candidate=await buildArtifactCandidate({snapshot:p.s,pin:pinRuntime(descriptor,{allowPreview:true}),buildTimestamp:'20261109_230000',prebid,takeOver:p.takeOver,countryTarget:'test'});
 assert.equal(JSON.stringify(p.s),before,'Generation mutated saved configuration');
 const config=JSON.parse(new TextDecoder().decode(candidate.files['config.json']));
 assert.deepEqual(config.core.explicitUnits.map(u=>u.id),p.codes,'Public IDs changed');
 for(const code of p.codes)assert.ok(config.core.explicitUnits.some(u=>u.id===code));
 const dir=resolve(out,p.name);await mkdir(dir,{recursive:true});for(const[name,bytes]of Object.entries(candidate.files))await writeFile(resolve(dir,name),bytes);
 results.push({...p,s:undefined,pass:true,runtime:descriptor.version,hash:descriptor.codeSha256});
 }catch(e){results.push({...p,s:undefined,pass:false,error:e.stack});}}
await writeFile(resolve(out,'cases.json'),JSON.stringify(results,null,2));
console.log(JSON.stringify(results.map(({name,pass,error})=>({name,pass,error})),null,2));
if(results.some(r=>!r.pass))process.exitCode=1;
