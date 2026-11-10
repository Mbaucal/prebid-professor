import {mkdir,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {conditionalFixture,mapping} from '../tests/support/conditional-maps-fixture.mjs';
import {checkedFixture,configure} from '../tests/runtime/artifact-fixture.mjs';
import {pinRuntime} from '../worker/runtime/version-pin.mjs';

const version=process.argv[2]||'319';
const {descriptor}=await import(`../.generated/runtime-${version}-manifest.mjs`);
const {buildArtifactCandidate}=await import(`../worker/runtime-${version}/artifact-candidate.mjs`);
const root=new URL(`../.generated/qa-size-map-${version}/`,import.meta.url);
await mkdir(root,{recursive:true});
const row=(width,height,sizes)=>({viewport:[width,height],sizes});
const small=[[320,50]],large=[[728,90]],wide=[[970,90]];
const maps={
 width:[row(0,0,small),row(768,0,large)],
 height:[row(0,0,small),row(768,1000,large)],
 duplicate:[row(0,0,small),row(768,0,large),row(768,1000,wide)],
 reversed:[row(768,1000,wide),row(768,0,large),row(0,0,small)],
 empty:[row(0,0,small),row(768,1000,[])],
 fluid:[row(0,0,['fluid']),row(768,1000,large)],
 nofallback:[row(768,1000,large)],
 crossed:[row(0,0,small),row(900,1000,large),row(1000,500,wide)],
 exactduplicate:[row(0,0,small),row(768,1000,large),row(768,1000,wide)],
};
const cases=[];
for(const sticky of [false,true])for(const kind of Object.keys(maps)){
 const s=conditionalFixture({prebid:true,sticky});
 const code=sticky?'Sticky':'P2';
 s.units=s.units.filter(u=>u.code===code);s.rules=[{rule_key:'__DEFAULT__',rule_json:JSON.stringify({refresh:{enabled:true,minSeconds:30,minGapBetweenRequestsSeconds:0,minViewPct:0}})}];
 s.maps=[{name:'P2',map_json:JSON.stringify(maps[kind])}];
 cases.push({name:`${sticky?'sticky':'banner'}-${kind}`,snapshot:s,code,rows:maps[kind],keywords:{},country:'RS',expectReject:kind==='exactduplicate',requireResizeStart:kind==='nofallback'});
}
for(const sticky of [false,true]){
 const s=conditionalFixture({prebid:true,sticky});
 const code=sticky?'Sticky':'P2';s.units=s.units.filter(u=>u.code===code);
 s.maps[1].map_json=JSON.stringify(maps.height);
 cases.push({name:`${sticky?'sticky':'banner'}-conditional-height`,snapshot:s,code,rows:maps.height,keywords:{category:'Naslovna'},country:'RS'});
}
for(const sticky of [false,true])for(const kind of ['width','nofallback']){
 const s=conditionalFixture({prebid:true,sticky});
 const code=sticky?'Sticky':'P2';s.units=s.units.filter(u=>u.code===code);s.rules=[];
 s.maps=[{name:'P2',map_json:JSON.stringify(maps[kind])}];
 cases.push({name:`${sticky?'sticky':'banner'}-pending-cmp-${kind}`,snapshot:s,code,rows:maps[kind],keywords:{},country:'RS',pendingCmp:true,requireResizeStart:kind==='nofallback'});
}
{
 const s=conditionalFixture({prebid:true,sticky:true});s.units=s.units.filter(u=>u.code==='Sticky');s.rules=[];
 s.maps=[{name:'P2',map_json:JSON.stringify(maps.nofallback)}];
 cases.push({name:'sticky-closed-before-first',snapshot:s,code:'Sticky',rows:maps.nofallback,keywords:{},country:'RS',closeAfterInitial:true});
}
for(const sticky of [false,true])for(const kind of ['width','height']){
 const s=conditionalFixture({prebid:true,sticky});
 const code=sticky?'Sticky':'P2';s.units=s.units.filter(u=>u.code===code);s.rules=[];
 const selected=kind==='width'?[row(0,0,[[300,250]]),row(768,0,[[970,250]])]:maps.height;
 s.maps=[{name:'P2',map_json:JSON.stringify(maps.width)},{name:'home_P2',map_json:JSON.stringify(selected)}];
 cases.push({name:`${sticky?'sticky':'banner'}-legacy-prefix-${kind}`,snapshot:s,code,rows:selected,keywords:{pageType:'home'},country:'RS'});
}
for(const kind of ['unassigned','disabled-unit','disabled-mapping']){
 const s=conditionalFixture({prebid:true});
 s.maps=[{name:'P2',map_json:JSON.stringify(maps.width)},{name:'UnusedDraft',map_json:JSON.stringify([row(0,0,small),row(0,0,large)])}];
 s.rules=[];
 if(kind==='disabled-unit')s.units.push({code:'UnusedPosition',type:'ATF',media_type:'banner',enabled:0,size_map_key:'UnusedDraft'});
 if(kind==='disabled-mapping')s.rules=[{rule_key:'P2',rule_json:JSON.stringify({conditionalMappings:[mapping({enabled:false,sizeMapKey:'UnusedDraft'})]})}];
 cases.push({name:`unused-duplicate-${kind}`,snapshot:s,code:'P2',rows:maps.width,keywords:{category:'Naslovna'},country:'RS'});
}
for(const category of ['Naslovna','Article','missing']){
 const s=conditionalFixture({prebid:true});
 cases.push({name:`category-${category}`,snapshot:s,code:'P2',rows:JSON.parse(s.maps[category==='Naslovna'?1:0].map_json),keywords:category==='missing'?{}:{category},country:'RS'});
}
for(const country of ['RS','DE','unknown','timeout']){
 const s=conditionalFixture({prebid:true});
 s.rules=[{rule_key:'P2',rule_json:JSON.stringify({conditionalMappings:[mapping({sizeMapKey:null,slotAction:'disable',match:'any',conditions:[{key:'geo_country',operator:'notEquals',value:'RS'},{key:'geo_country',operator:'notExists'}]})]})}];
 cases.push({name:`geo-onlyRS-${country}`,snapshot:s,code:'P2',rows:JSON.parse(s.maps[0].map_json),keywords:{category:'Naslovna'},country,disabled:country!=='RS'});
}
const output=[];
for(const c of cases){
 const before=JSON.stringify(c.snapshot),check=structuredClone(c.snapshot);check.rules=[];
 try{
  const prebid=await checkedFixture(check);
  const artifact=await buildArtifactCandidate({snapshot:c.snapshot,pin:pinRuntime(descriptor),prebid,buildTimestamp:'20261109_210000',countryTarget:'test'});
  for(const file of ['ads.js','ads.min.js','min-height.css'])await writeFile(new URL(`${c.name}.${file}`,root),artifact.files[file]);
  output.push({...c,snapshot:undefined,generated:true,sourceUnchanged:before===JSON.stringify(c.snapshot)});
 }catch(error){output.push({...c,snapshot:undefined,generated:false,error:error.message,sourceUnchanged:before===JSON.stringify(c.snapshot)});}
}
await writeFile(new URL('cases.json',root),JSON.stringify({version,runtimeDescriptor:descriptor,commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),cases:output},null,2));
console.log(JSON.stringify(output.map(({name,generated,error})=>({name,generated,error})),null,2));
if(process.argv.includes('--require-pass')&&output.some(c=>c.generated===Boolean(c.expectReject)||!c.sourceUnchanged))process.exitCode=1;
