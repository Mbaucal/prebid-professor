import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fixture,configure} from '../runtime/artifact-fixture.mjs';
import {descriptor} from '../../.generated/runtime-322-manifest.mjs';
import {previewInput} from '../../worker/runtime-322/snapshot.mjs';
import {compileRuntime322,idempotentStickyStyles} from '../../worker/runtime-322/compiler.mjs';
import {finalizeJavaScript} from '../../worker/runtime/artifact-minifier.mjs';
import {stickyStyles,installSharedStickyStyles} from '../../worker/runtime-3191/styles.mjs';
const out=new URL('../../.generated/bidder-rules-native/',import.meta.url);await mkdir(out,{recursive:true});
const scenarios=['country-refresh','layout-refresh','unknown-skip','unknown-allow','all-skipped','disabled'];
const hash=value=>createHash('sha256').update(value).digest('hex');
const manifest={schemaVersion:1,descriptor,prebidSha256:hash(await readFile(new URL('../../vendor/prebid/tanjug-11.34.0/prebid.js',import.meta.url))),cases:[]};
for(const name of scenarios){
  const rule=bidder=>({id:bidder+'-rule',name:bidder+' Serbia desktop',enabled:true,bidder,positions:[],countries:{mode:'include',values:['RS'],unknown:name==='unknown-allow'?'allow':'skip'},devices:name==='layout-refresh'?['desktop']:['mobile','tablet','desktop']});
  const snapshot=configure(fixture(),config=>{config.runtimeControls.sticky.bottomAdUnitId='';config.runtimeControls.currencyConversion={enabled:false};config.runtimeControls.bidderRules={schemaVersion:1,enabled:name!=='disabled',rules:[rule('pubmatic'),...(name==='all-skipped'?[rule('openx')]:[])]};config.runtimeControls.schain={ver:'1.0',complete:1,nodes:[{asi:'publisher.invalid',sid:'fixture-seller',hp:1}]};});
  snapshot.units=snapshot.units.filter(u=>u.code!=='Sticky').map(u=>({...u,type:'ATF'}));
  snapshot.overrides=[];snapshot.bidders=[{bidder:'pubmatic',enabled:1,params_json:'{"publisherId":"fixture","adSlot":"fixture"}'},{bidder:'openx',enabled:1,params_json:'{"unit":"fixture","delDomain":"fixture.invalid"}'}];
  snapshot.rules=[{rule_key:'__DEFAULT__',rule_json:JSON.stringify({refresh:{enabled:true,minSeconds:30,minViewPct:50,minGapSeconds:0}})}];
  const input=previewInput(snapshot,descriptor,'20261112_120000');
  const compiled=compileRuntime322(input);
  const output=await finalizeJavaScript(idempotentStickyStyles(installSharedStickyStyles(compiled.adsJs,stickyStyles(''))));
  const files={};for(const [extension,text]of [['js',output.adsJs],['min.js',output.adsMinJs]]){const file=name+'.'+extension;await writeFile(new URL(file,out),text);files[extension]={file,sha256:hash(text)};}
  manifest.cases.push({name,files});
}
await writeFile(new URL('manifest.json',out),JSON.stringify(manifest,null,2)+'\n');
console.log('Prepared 3.22.0 native synthetic-demand fixtures; no publisher/SSP traffic.');
