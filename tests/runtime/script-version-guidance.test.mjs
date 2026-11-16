import test from 'node:test';
import assert from 'node:assert/strict';
import {runtimeCatalog,previewInput,buildArtifactCandidate} from '../../worker/test-workspace/runtime-catalog.mjs';
import {assertSnapshotCompilerCompatibility} from '../../worker/compiler-input-compatibility.mjs';
import {requireSupportedCacheGenerator,BID_CACHE_GENERATOR_MESSAGE} from '../../worker/site-runtime/prebid-cache-settings.mjs';
import {configurationErrorMessage} from '../../worker/runtime/configuration-error.mjs';
import {pinRuntime} from '../../worker/runtime/version-pin.mjs';
import {runtimeReleaseHistory} from '../../worker/runtime/runtime-release-history.mjs';
import {runtimeNotices} from '../../shared/runtime-notices.mjs';
import {siteRuntimeSettings,siteRuntimeResponse} from '../../worker/site-runtime/service.mjs';
import {packageState} from '../../worker/site-runtime/releases.mjs';
import {configure} from './artifact-fixture.mjs';
import {bidCacheSite} from './bid-cache323-site.mjs';
import {runtime324Site} from './runtime324-site.mjs';
import {adminAuditStore} from '../support/admin-audit-store.mjs';
import {BIDDER_RULES_WITHOUT_BID_CACHE_MESSAGE} from '../../worker/test-workspace/bid-cache-messages.mjs';

// The versions an operator is sent to when the selected script lacks bidder rules or bidder accounts. The expectation
// is computed here from the registry, independently of the admin code: every numeric release with all the needed
// capabilities, without a runtime notice, and not superseded by a newer patch of its minor line.
// TEST keeps its own wording for enabled bidder rules on 3.23.0 (worker/test-workspace/bid-cache-messages.mjs), checked
// before the shared guidance; it names 3.24.0 Preview, which applies every saved option, and is checked the same way.
const TS='20261116_120000';
const RULES={schemaVersion:1,enabled:true,rules:[{id:'r',name:'RS only',enabled:true,bidder:'openx',positions:[],countries:{mode:'include',values:['RS'],unknown:'skip'},devices:['desktop','tablet','mobile']}]};
const CACHE={enabled:true,maxBidAgeSeconds:60};
const numeric=version=>/^\d+\.\d+\.\d+$/.test(version);
const parts=version=>version.split('.').map(Number);
function expectedVersions(capabilities){
  const has=(release,list)=>list.every(capability=>release.capabilities.includes(capability));
  const offered=runtimeReleaseHistory.filter(r=>numeric(r.version)&&has(r,capabilities)&&!runtimeNotices.some(n=>n.version===r.version&&n.runtimeSha256===r.codeSha256));
  return offered.filter(r=>!offered.some(o=>{const [a,b,c]=parts(o.version),[x,y,z]=parts(r.version);return a===x&&b===y&&c>z&&has(o,r.capabilities);}))
    .sort((a,b)=>{const x=parts(a.version),y=parts(b.version);return x[0]-y[0]||x[1]-y[1]||x[2]-y[2];})
    .map(r=>r.version+(r.channel==='preview'?' (Preview)':''));
}
const CASES={
  'rules':{make:()=>configure(bidCacheSite({}),c=>{c.runtimeControls.bidderRules=RULES;}),needs:['bidder-rules']},
  'rules+cache':{make:()=>configure(bidCacheSite({cache:CACHE}),c=>{c.runtimeControls.bidderRules=RULES;}),needs:['bidder-rules','bid-cache']},
  'accounts':{make:()=>configure(runtime324Site({cache:false}),c=>{c.runtimeControls.bidderRules={schemaVersion:1,enabled:false,rules:[]};}),needs:['bidder-accounts']},
  'accounts+cache':{make:()=>configure(runtime324Site({}),c=>{c.runtimeControls.bidderRules={schemaVersion:1,enabled:false,rules:[]};}),needs:['bidder-accounts','bid-cache']},
  'accounts+rules':{make:()=>runtime324Site({cache:false}),needs:['bidder-accounts','bidder-rules']},
  'accounts+rules+cache':{make:()=>runtime324Site({}),needs:['bidder-accounts','bidder-rules','bid-cache']},
};
const selectable=runtimeCatalog.filter(r=>numeric(r.version));
// What Script setup and Generate check for one saved site and one selected script (null when accepted).
function refusal(snapshot,descriptor){
  try{requireSupportedCacheGenerator(JSON.parse(snapshot.config.config_json),descriptor);assertSnapshotCompilerCompatibility(snapshot,descriptor);previewInput(snapshot,descriptor,TS);return null;}
  catch(error){return error.message;}
}
const namedVersions=(message,selected)=>[...new Set(message.match(/\b\d+\.\d+\.\d+\b/g)??[])].filter(version=>version!==selected);

test('today the guidance names 3.22.2 or 3.24.0 without bid caching and only 3.24.0 with it',()=>{
  assert.deepEqual(expectedVersions(['bidder-rules']),['3.22.2 (Preview)','3.24.0 (Preview)']);
  assert.deepEqual(expectedVersions(['bidder-accounts']),['3.22.2 (Preview)','3.24.0 (Preview)']);
  assert.deepEqual(expectedVersions(['bidder-accounts','bidder-rules']),['3.22.2 (Preview)','3.24.0 (Preview)']);
  for(const needs of [['bidder-rules','bid-cache'],['bidder-accounts','bid-cache'],['bidder-accounts','bidder-rules','bid-cache']])assert.deepEqual(expectedVersions(needs),['3.24.0 (Preview)']);
});

test('a script without bidder rules or accounts names only versions that apply every saved option, and each of them is accepted',async()=>{
  let checked=0,other=0;
  for(const [name,{make,needs}] of Object.entries(CASES))for(const descriptor of selectable){
    const message=refusal(make(),descriptor);
    if(needs.every(capability=>descriptor.capabilities.includes(capability))){assert.equal(message,null,`${name} on ${descriptor.version}`);continue;}
    assert.ok(message,`${name} on ${descriptor.version} is refused`);
    if(message===BID_CACHE_GENERATOR_MESSAGE){assert.ok(!descriptor.capabilities.includes('bid-cache'));continue;}
    if(message===BIDDER_RULES_WITHOUT_BID_CACHE_MESSAGE){
      assert.ok(descriptor.capabilities.includes('bid-cache')&&!descriptor.capabilities.includes('bidder-rules'),name);
      const expected=expectedVersions(needs).map(version=>version.replace(' (Preview)',''));
      assert.ok(namedVersions(message,descriptor.version).every(version=>expected.includes(version)),`${name}: ${message}`);
      for(const version of namedVersions(message,descriptor.version))assert.equal(refusal(make(),runtimeCatalog.find(r=>r.version===version)),null,`${name} -> ${version}`);
      assert.equal(configurationErrorMessage(Object.assign(Error(message),{status:422})),message,name);
      checked++;continue;
    }
    // Older engines may first refuse another saved setting (size maps, contextual signals); that reason is not this guidance.
    if(!/bidder rules|bidder accounts/i.test(message)){other++;continue;}
    const label=`${name} on ${descriptor.version}: ${message}`;
    assert.doesNotMatch(message,/or later/,label);
    const expected=expectedVersions(needs);
    assert.ok(expected.every(version=>message.includes(version)),label);
    assert.deepEqual(namedVersions(message,descriptor.version),expected.map(version=>version.replace(' (Preview)','')),label);
    // Following the advice never leads to another refusal for a saved option.
    for(const version of namedVersions(message,descriptor.version)){
      const next=runtimeCatalog.find(r=>r.version===version);
      assert.equal(refusal(make(),next),null,`${label} -> ${version}`);
    }
    // Generate shows the reason, not the generic configuration text.
    assert.equal(configurationErrorMessage(Object.assign(Error(message),{status:422})),message,label);
    checked++;
  }
  assert.ok(checked>=30&&other<checked,`checked ${checked} refusals, ${other} for other settings`);
});

test('3.23.0 with bid caching names 3.24.0 (Preview) only, in the real Generate order',async()=>{
  const r323=runtimeCatalog.find(r=>r.version==='3.23.0'),r324=runtimeCatalog.find(r=>r.version==='3.24.0');
  for(const name of ['rules+cache','accounts+cache','accounts+rules+cache']){
    const generate=snapshot=>buildArtifactCandidate({snapshot,pin:pinRuntime(r323,{allowPreview:true}),buildTimestamp:TS,prebid:null});
    await assert.rejects(generate(CASES[name].make()),error=>{
      // Rules alone keep the TEST wording; saved accounts are refused first, with the shared guidance.
      if(name==='rules+cache')assert.equal(error.message,BIDDER_RULES_WITHOUT_BID_CACHE_MESSAGE,name);
      else{assert.match(error.message,/^Script 3\.23\.0 cannot apply /,name);assert.match(error.message,/select 3\.24\.0 \(Preview\) in Script setup and save/i,name);}
      assert.doesNotMatch(error.message,/3\.22|or later/,name);
      return true;
    });
    assert.equal(refusal(CASES[name].make(),r324),null,name);
  }
});

test('patterns for the guidance are anchored and refuse altered text',()=>{
  const message=refusal(CASES['accounts+cache'].make(),runtimeCatalog.find(r=>r.version==='3.23.0'));
  const generic=configurationErrorMessage(Error('x'));
  assert.match(message,/^Script 3\.23\.0 cannot apply bidder accounts/);
  assert.equal(configurationErrorMessage(Error(message)),message);
  for(const altered of [message+' ',' '+message,message.replace('3.24.0 (Preview)','3.24.0 (Preview) or later'),message.replace('Script 3.23.0','Script <b>'),message+'\nmore',message.replace('select 3.24.0','select https://example.invalid')])
    assert.equal(configurationErrorMessage(Error(altered)),generic,altered);
  // The TEST rules message is allowed only exactly as written.
  const rules=BIDDER_RULES_WITHOUT_BID_CACHE_MESSAGE;
  assert.equal(configurationErrorMessage(Error(rules)),rules);
  for(const altered of [rules+' ',' '+rules,rules.replace('3.24.0 Preview','3.24.0 Preview or later'),rules.replace('Script 3.23.0','Script <b>'),rules+'\nmore'])
    assert.equal(configurationErrorMessage(Error(altered)),generic,altered);
});

// Script setup and Releases read the saved site through the Worker services.
const fixtures=[];
test.afterEach(()=>{while(fixtures.length)fixtures.pop().close();});
function savedSite({cache=false,rules=false,alias=false,version}){
  const f=adminAuditStore({config:{...(cache?{prebidBidCache:CACHE}:{}),runtimeControls:{sticky:{bottomAdUnitId:''},...(rules?{bidderRules:{...RULES,rules:[{...RULES.rules[0],bidder:'pubmatic'}]}}:{})}}});
  fixtures.push(f);
  if(alias)f.sqlite.prepare("INSERT INTO bidders(id,publisher_id,bidder,params_json,account_json) VALUES('alias','audit-site','pm_ag','{}',?)").run(JSON.stringify({baseAdapter:'pubmatic',displayName:'Agency',schain:{mode:'none'}}));
  if(version){
    const config=f.readConfig(),pin=pinRuntime(runtimeCatalog.find(r=>r.version===version),{allowPreview:true});
    f.writeConfig({...config,builtinRuntimeSelection:{schemaVersion:1,runtime:pin,prebid:{id:'audit-prebid',version:'11.34.0',sha256:'0'.repeat(64),byteSize:1,modules:['pubmaticBidAdapter']}}});
  }
  return f;
}
const post=(f,body)=>siteRuntimeResponse(new Request('https://fixture.invalid/api/publishers/audit-site/builtin-site-settings',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}),f.env,'audit-site','admin@example.invalid');

test('Script setup, Save and Generate show the same version guidance for a saved 3.23.0',async()=>{
  // Rules alone: the TEST wording, exactly. Accounts: the shared guidance.
  for(const [options,expected] of [[{cache:true,rules:true},BIDDER_RULES_WITHOUT_BID_CACHE_MESSAGE],[{cache:true,alias:true},/^Script 3\.23\.0 cannot apply bidder accounts \(pm_ag\)\. To keep them with your saved bid caching, select 3\.24\.0 \(Preview\) in Script setup and save/]]){
    const f=savedSite({...options,version:'3.23.0'}),label=JSON.stringify(options);
    const state=await siteRuntimeSettings(f.env,'audit-site');
    if(typeof expected==='string')assert.equal(state.validationIssue,expected,label);else assert.match(state.validationIssue,expected,label);
    assert.doesNotMatch(state.validationIssue,/3\.22|or later/,label);
    // Saving 3.23.0 again from Script setup is refused with the same reason.
    const r323=state.runtimes.find(r=>r.version==='3.23.0');
    const saved=await post(f,{action:'setup',revision:state.revision,runtime:r323.pin,allowPreview:false,enablePrebid:true});
    assert.equal(saved.status,422,label);assert.equal((await saved.json()).error,state.validationIssue,label);
    // Generate and releases name the setting, not the generic validation text.
    const packages=await packageState(f.env,'audit-site');
    assert.equal(packages.ready,false,label);assert.equal(packages.error,state.validationIssue,label);
  }
});

test('Script setup on 3.21.2 without bid caching names both versions with bidder rules',async()=>{
  const f=savedSite({rules:true,version:'3.21.2'});
  const state=await siteRuntimeSettings(f.env,'audit-site');
  assert.equal(state.validationIssue,'Script 3.21.2 cannot apply enabled bidder rules. Select 3.22.2 (Preview) or 3.24.0 (Preview) in Script setup and save, or turn off bidder rules. Your saved settings and previous packages are unchanged.');
  assert.equal((await packageState(f.env,'audit-site')).error,state.validationIssue);
});

test('versions come from release capabilities: notices, superseded patches and the empty case',async()=>{
  const {scriptVersionsWith,scriptVersionText,scriptGuidance}=await import('../../worker/site-runtime/script-version-guidance.mjs');
  // Every named release is bundled in the catalog with the same source, so it can be selected.
  for(const needs of [['bidder-rules'],['bidder-accounts'],['bid-cache'],['bidder-rules','bid-cache']])
    for(const release of scriptVersionsWith(needs))assert.ok(runtimeCatalog.some(r=>r.id===release.id&&r.version===release.version&&r.codeSha256===release.codeSha256),release.version);
  assert.equal(scriptVersionText(['bid-cache']),'3.24.0 (Preview)');
  const r=(version,channel,capabilities,codeSha256=version)=>({id:'tessera-'+version,version,channel,capabilities,codeSha256});
  const history=[r('4.1.0','preview',['a','b']),r('4.0.2','stable',['a']),r('4.0.1','stable',['a']),r('4.0.0','stable',['a','x']),r('3.22.0','stable',['a'],runtimeNotices[0].runtimeSha256),r('4.2.0-tessera.preview.1','preview',['a','b'])];
  // 4.0.1 is superseded by 4.0.2; 4.0.0 is kept because 4.0.2 lacks its 'x'; 3.22.0 has a notice; the suffixed build is not offered.
  assert.equal(scriptVersionText(['a'],history),'4.0.0, 4.0.2 or 4.1.0 (Preview)');
  assert.equal(scriptVersionText(['a','b','c'],history),'');
  assert.equal(scriptGuidance({accounts:['a1','a2','a3','a4','a5'],rules:true,cache:true},{version:'4.0.2',capabilities:['a']},history),
    'Script 4.0.2 cannot apply bidder accounts (a1, a2, a3 and 2 more) or enabled bidder rules. No available script version applies bidder accounts, bidder rules and bid caching together. Your saved settings and previous packages are unchanged.');
  for(const message of [scriptGuidance({accounts:['a1','a2','a3','a4','a5'],rules:true,cache:true},{version:'4.0.2',capabilities:['a']},history),scriptGuidance({accounts:[],rules:true,cache:false},null)])
    assert.equal(configurationErrorMessage(Error(message)),message);
  assert.equal(scriptGuidance({accounts:[],rules:true,cache:false},null),'This script cannot apply enabled bidder rules. Select 3.22.2 (Preview) or 3.24.0 (Preview) in Script setup and save, or turn off bidder rules. Your saved settings and previous packages are unchanged.');
  // Accounts with a script that has bidder rules: the rules are named as kept, and no rules off-switch is offered.
  const r322=runtimeCatalog.find(x=>x.version==='3.22.0');
  assert.equal(scriptGuidance({accounts:['pm_ag'],rules:true,cache:false},r322),'Script 3.22.0 cannot apply bidder accounts (pm_ag). To keep them with your saved bidder rules, select 3.22.2 (Preview) or 3.24.0 (Preview) in Script setup and save. Your saved settings and previous packages are unchanged.');
  assert.equal(scriptGuidance({accounts:['pm_ag'],rules:true,cache:true},runtimeCatalog.find(x=>x.version==='3.24.0')),null);
});
