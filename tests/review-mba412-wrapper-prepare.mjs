/** Build full 3.22.1 programs from saved account, PPS and GEO settings. */
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve, dirname} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
const root = resolve(process.env.ACCOUNTS_RUNTIME_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const imp = name => import(pathToFileURL(resolve(root, name)));
const {fixture, configure} = await imp('tests/runtime/artifact-fixture.mjs');
const {descriptor} = await imp('.generated/runtime-3221-manifest.mjs');
const {previewInput} = await imp('worker/runtime-3221/snapshot.mjs');
const {compileRuntime3221, idempotentStickyStyles} = await imp('worker/runtime-3221/compiler.mjs');
const {finalizeJavaScript} = await imp('worker/runtime/artifact-minifier.mjs');
const {stickyStyles, installSharedStickyStyles} = await imp('worker/runtime-3191/styles.mjs');
const out = resolve(process.env.ACCOUNTS_WRAPPER_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '../.generated/accounts-wrapper'));
await mkdir(out, {recursive: true});
const hash = value => createHash('sha256').update(value).digest('hex');
const chain = sid => ({ver:'1.0', complete:1, nodes:[{asi:'seller.invalid', sid, hp:1}]});
const accounts = [{bidder:'adf_smn',baseAdapter:'adf',schain:{mode:'inherit'}}, {bidder:'adf_ag',baseAdapter:'adf',schain:{mode:'none'}}, {bidder:'adf_custom',baseAdapter:'adf',schain:{mode:'custom',config:chain('custom-seller')}}];
const manifest = {schemaVersion:1, descriptor, cases:[]};
for (const name of ['rs','de','unknown','disabled-rules','punctuated-position','position-rule','pubmatic-deal']) {
  const accountSet = name==='pubmatic-deal' ? accounts.map(account=>({...account,bidder:account.bidder.replace('adf_','pm_'),baseAdapter:'pubmatic'})) : accounts;
  const prefix=name==='pubmatic-deal'?'pm_':'adf_';
  const snapshot = configure(fixture(), config => {
    config.runtimeControls.sticky.bottomAdUnitId = '';
    config.runtimeControls.currencyConversion = {enabled:false};
    config.runtimeControls.schain = {enabled:true,version:'1.0',complete:1,nodes:chain('site-seller').nodes};
    config.runtimeControls.bidderRules = {schemaVersion:1, enabled:name!=='disabled-rules', rules:[{id:'smn-rs', name:'SMN Serbia', enabled:true, bidder:prefix+'smn', positions:name==='position-rule'?['m.box_1']:[], countries:{mode:'include',values:['RS'],unknown:'skip'},devices:['mobile','tablet','desktop']}]};
    config.runtimeControls.contextualSignals = {schemaVersion:1,enabled:true,sourceKey:'category',gam:{enabled:true},
      bidders:[{bidder:prefix+'smn',taxonomy:'iab-content-2.2'},{bidder:prefix+'custom',taxonomy:'iab-content-3.0'}],
      mappings:[{value:'Sports',taxonomies:{'iab-content-2.2':['483'],'iab-content-3.0':['VK7KD0']}}]};
  });
  snapshot.units=snapshot.units.filter(unit=>unit.code!=='Sticky').map(unit=>({...unit,type:'ATF'}));
  if (['punctuated-position','position-rule','pubmatic-deal'].includes(name)) snapshot.units=snapshot.units.map(unit=>unit.code==='P1'?{...unit,code:'m.box_1'}:unit);
  snapshot.overrides=[];
  snapshot.bidders=accountSet.map((account,index)=>({bidder:account.bidder,enabled:1,params_json:JSON.stringify(name==='pubmatic-deal'?{publisherId:String(999991+index),adSlot:'synthetic@300x250'}:{mid:999991+index}),account_json:JSON.stringify(account)}));
  snapshot.prebidBuilds=[{status:'current',version:'11.34.0',modules_json:JSON.stringify(['adfBidAdapter','rtdModule','contextualSignalsRtdProvider'])}];
  if(name==='pubmatic-deal') configure(snapshot,config=>{config.runtimeControls.deals={schemaVersion:1,entries:[{id:'alias-deal',name:'Agency only',bidder:'pm_ag',dealId:'qa-deal-1234',positions:['m.box_1'],startsAt:'2026-01-01T00:00:00.000Z',endsAt:'2027-01-01T00:00:00.000Z',enabled:true,mode:'price'}]};});
  const input=previewInput(snapshot,descriptor,'20261115_120000');
  const compiled=compileRuntime3221(input);
  const output=await finalizeJavaScript(idempotentStickyStyles(installSharedStickyStyles(compiled.adsJs,stickyStyles(''))));
  const files={};
  for(const [extension,text] of [['js',output.adsJs],['min.js',output.adsMinJs]]) {
    const file=name+'.'+extension;await writeFile(resolve(out,file),text);files[extension]={file,sha256:hash(text)};
  }
  manifest.cases.push({name,files,accounts:input.bidderAccounts,contextual:input.contextualSignals});
}
await writeFile(resolve(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log('Prepared 3.22.1 full account/PPS/GEO wrappers: '+out);
