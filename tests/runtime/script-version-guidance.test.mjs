import test from 'node:test';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {runtimeCatalog,previewInput,buildArtifactCandidate} from '../../worker/test-workspace/runtime-catalog.mjs';
import {assertSnapshotCompilerCompatibility} from '../../worker/compiler-input-compatibility.mjs';
import {requireSupportedCacheGenerator,bidCacheGeneratorMessage,bidCacheScriptVersions} from '../../worker/site-runtime/prebid-cache-settings.mjs';
import {DEFAULT_ADAPTIVE_TIMEOUT} from '../../shared/auction-timeout/settings.mjs';
import {configurationErrorMessage} from '../../worker/runtime/configuration-error.mjs';
import {pinRuntime} from '../../worker/runtime/version-pin.mjs';
import {runtimeReleaseHistory} from '../../worker/runtime/runtime-release-history.mjs';
import {runtimeNotices} from '../../shared/runtime-notices.mjs';
import {siteRuntimeSettings,siteRuntimeResponse} from '../../worker/site-runtime/service.mjs';
import {packageState,generatePackage} from '../../worker/site-runtime/releases.mjs';
import {scriptGuidance} from '../../worker/site-runtime/script-version-guidance.mjs';
import {configure} from './artifact-fixture.mjs';
import {bidCacheSite} from './bid-cache323-site.mjs';
import {runtime324Site} from './runtime324-site.mjs';
import {adminAuditStore} from '../support/admin-audit-store.mjs';

// The versions an operator is sent to when the selected script lacks bidder rules or bidder accounts. The expectation
// is computed here from the registry, independently of the admin code. Of the numeric releases with all the needed
// capabilities and without a runtime notice, at most two are named, oldest first: the smallest step (the fewest
// capabilities, the newest of those on a tie) and the newest. One when they are the same release; none when no
// release has every capability.
const TS='20261116_120000';
const RULES={schemaVersion:1,enabled:true,rules:[{id:'r',name:'RS only',enabled:true,bidder:'openx',positions:[],countries:{mode:'include',values:['RS'],unknown:'skip'},devices:['desktop','tablet','mobile']}]};
const CACHE={enabled:true,maxBidAgeSeconds:60};
const TIMEOUT={...DEFAULT_ADAPTIVE_TIMEOUT,enabled:true};
const numeric=version=>/^\d+\.\d+\.\d+$/.test(version);
const parts=version=>version.split('.').map(Number);
const byVersion=(a,b)=>{const x=parts(a.version),y=parts(b.version);return x[0]-y[0]||x[1]-y[1]||x[2]-y[2];};
const label=release=>release.version+(release.channel==='preview'?' (Preview)':'');
function expectedVersions(capabilities,history=runtimeReleaseHistory,notices=runtimeNotices){
  const has=(release,list)=>list.every(capability=>release.capabilities.includes(capability));
  const offered=history.filter(r=>numeric(r.version)&&has(r,capabilities)&&!notices.some(n=>n.version===r.version&&n.runtimeSha256===r.codeSha256)).sort(byVersion);
  if(!offered.length)return [];
  const fewest=Math.min(...offered.map(r=>r.capabilities.length));
  return [...new Set([offered.filter(r=>r.capabilities.length===fewest).at(-1),offered.at(-1)])].map(label);
}
const choice=labels=>labels.length<2?labels[0]??'':`${labels.slice(0,-1).join(', ')} or ${labels.at(-1)}`;
// When no version is named, a release with a runtime notice may still apply every capability. It stays selectable in
// Script setup, so the text says that no corrected version is offered, not that none applies them. MAIN always names a
// version today (3.26.0 applies every option), so these texts are checked with earlier registries and added notices.
const NAMES={'bidder-accounts':'bidder accounts','bidder-rules':'bidder rules','bid-cache':'bid caching','adaptive-auction-timeout':'adaptive timeout'};
const noticedApplies=(capabilities,history=runtimeReleaseHistory,notices=runtimeNotices)=>history.some(r=>numeric(r.version)
  &&capabilities.every(capability=>r.capabilities.includes(capability))&&notices.some(n=>n.version===r.version&&n.runtimeSha256===r.codeSha256));
function noVersionText(capabilities,history,notices){
  const names=capabilities.map(capability=>NAMES[capability]),many=names.length>1;
  const list=many?`${names.slice(0,-1).join(', ')} and ${names.at(-1)} together`:names[0];
  return noticedApplies(capabilities,history,notices)
    ?`No corrected script version is offered that applies ${list}. Versions with a runtime notice in Script setup still apply ${many?'them':'it'}.`
    :`No available script version applies ${list}.`;
}
// The registry as it stood with 3.26.0 (MAIN) and with 3.24.0 (TEST). Records are never changed, so these stay fixed.
const upTo=version=>runtimeReleaseHistory.filter(r=>numeric(r.version)&&byVersion(r,{version})<=0);
const MAIN_3260=upTo('3.26.0'),TEST_3240=upTo('3.24.0');
const CASES={
  'rules':{make:()=>configure(bidCacheSite({}),c=>{c.runtimeControls.bidderRules=RULES;}),needs:['bidder-rules']},
  'rules+cache':{make:()=>configure(bidCacheSite({cache:CACHE}),c=>{c.runtimeControls.bidderRules=RULES;}),needs:['bidder-rules','bid-cache']},
  'accounts':{make:()=>configure(runtime324Site({cache:false}),c=>{c.runtimeControls.bidderRules={schemaVersion:1,enabled:false,rules:[]};}),needs:['bidder-accounts']},
  'accounts+cache':{make:()=>configure(runtime324Site({}),c=>{c.runtimeControls.bidderRules={schemaVersion:1,enabled:false,rules:[]};}),needs:['bidder-accounts','bid-cache']},
  'accounts+rules':{make:()=>runtime324Site({cache:false}),needs:['bidder-accounts','bidder-rules']},
  'accounts+rules+cache':{make:()=>runtime324Site({}),needs:['bidder-accounts','bidder-rules','bid-cache']},
  // An enabled adaptive auction timeout is refused by its own check, so the named versions must also have it.
  'rules+timeout':{make:()=>configure(bidCacheSite({}),c=>{c.runtimeControls.bidderRules=RULES;c.adaptiveAuctionTimeout=TIMEOUT;}),needs:['bidder-rules','adaptive-auction-timeout']},
  'accounts+timeout':{make:()=>configure(runtime324Site({cache:false}),c=>{c.runtimeControls.bidderRules={schemaVersion:1,enabled:false,rules:[]};c.adaptiveAuctionTimeout=TIMEOUT;}),needs:['bidder-accounts','adaptive-auction-timeout']},
  'accounts+rules+cache+timeout':{make:()=>configure(runtime324Site({}),c=>{c.adaptiveAuctionTimeout=TIMEOUT;}),needs:['bidder-accounts','bidder-rules','bid-cache','adaptive-auction-timeout']},
};
const selectable=runtimeCatalog.filter(r=>numeric(r.version));
// What Script setup and Generate check for one saved site and one selected script (null when accepted).
function refusal(snapshot,descriptor){
  try{requireSupportedCacheGenerator(JSON.parse(snapshot.config.config_json),descriptor,snapshot.bidders);assertSnapshotCompilerCompatibility(snapshot,descriptor);previewInput(snapshot,descriptor,TS);return null;}
  catch(error){return error.message;}
}
const namedVersions=(message,selected)=>[...new Set(message.match(/\b\d+\.\d+\.\d+\b/g)??[])].filter(version=>version!==selected);

test('the guidance names the smallest step and the newest release, never more than two',()=>{
  const newest=needs=>label(runtimeReleaseHistory.filter(r=>numeric(r.version)&&needs.every(c=>r.capabilities.includes(c))&&!runtimeNotices.some(n=>n.version===r.version&&n.runtimeSha256===r.codeSha256)).sort(byVersion).at(-1));
  for(const needs of [['bidder-rules'],['bidder-accounts'],['bidder-accounts','bidder-rules']])assert.deepEqual(expectedVersions(needs),['3.22.2 (Preview)',newest(needs)]);
  for(const needs of [['bid-cache'],['bidder-rules','bid-cache'],['bidder-accounts','bid-cache'],['bidder-accounts','bidder-rules','bid-cache']])assert.deepEqual(expectedVersions(needs),['3.25.1 (Preview)',newest(needs)]);
  // With the releases up to 3.26.0 (MAIN) and up to 3.24.0 (TEST).
  assert.deepEqual(expectedVersions(['bidder-rules'],MAIN_3260),['3.22.2 (Preview)','3.26.0 (Preview)']);
  assert.deepEqual(expectedVersions(['bidder-rules','bid-cache'],MAIN_3260),['3.25.1 (Preview)','3.26.0 (Preview)']);
  assert.deepEqual(expectedVersions(['bidder-rules'],TEST_3240),['3.22.2 (Preview)']);
  assert.deepEqual(expectedVersions(['bidder-rules','bid-cache'],TEST_3240),[]);
});

test('a script without bidder rules or accounts names only versions that apply every saved option, and each of them is accepted',async()=>{
  let checked=0,other=0,cached=0;
  for(const [name,{make,needs}] of Object.entries(CASES))for(const descriptor of selectable){
    const snapshot=make(),message=refusal(snapshot,descriptor);
    if(needs.every(capability=>descriptor.capabilities.includes(capability))){assert.equal(message,null,`${name} on ${descriptor.version}`);continue;}
    assert.ok(message,`${name} on ${descriptor.version} is refused`);
    if(message===bidCacheGeneratorMessage(JSON.parse(snapshot.config.config_json),snapshot.bidders)){
      // Generate's bid caching refusal names the same versions as this guidance would.
      assert.ok(!descriptor.capabilities.includes('bid-cache'));assert.ok(message.includes(`Select ${choice(expectedVersions(needs))} in Script setup and save;`),message);cached++;continue;}
    // Older engines may first refuse another saved setting (size maps, contextual signals); that reason is not this guidance.
    if(!/bidder rules|bidder accounts/i.test(message)){other++;continue;}
    const label=`${name} on ${descriptor.version}: ${message}`;
    assert.doesNotMatch(message,/or later/,label);
    const expected=expectedVersions(needs);
    assert.ok(expected.length>=1&&expected.length<=2,label);
    assert.ok(message.includes(`elect ${choice(expected)} in Script setup and save`),label);
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
  assert.ok(checked>=30&&other<checked&&cached>0,`checked ${checked} refusals, ${other} for other settings, ${cached} for bid caching`);
});

test('the bidder rules off-switch is offered only when turning rules off lets that script apply the saved options',()=>{
  let offered=0,withheld=0;
  for(const [name,{make}] of Object.entries(CASES))for(const descriptor of selectable){
    // Script setup and Save show what previewInput refuses; Generate adds the bid caching check.
    let message=null;
    try{const snapshot=make();assertSnapshotCompilerCompatibility(snapshot,descriptor);previewInput(snapshot,descriptor,TS);}catch(error){message=error.message;}
    if(!/^(Script \d+\.\d+\.\d+|This script) cannot apply .*enabled bidder rules\./.test(message??''))continue;
    const after=refusal(configure(make(),c=>{c.runtimeControls.bidderRules.enabled=false;}),descriptor);
    const label=`${name} on ${descriptor.version}: ${message} -> rules off: ${after}`;
    if(/, or turn off bidder rules\./.test(message)){
      // Other refusals on older engines (size maps, contextual signals) are not about these options.
      assert.ok(after===null||!/bidder rules|bidder accounts|bid cach/i.test(after),label);offered++;
    }else{
      assert.doesNotMatch(message,/turn off/,label);
      assert.ok(/^Bid caching needs a compatible script version\. /.test(after)||/cannot apply bidder accounts/.test(after),label);withheld++;
    }
  }
  assert.ok(offered>0&&withheld>0,`offered ${offered}, withheld ${withheld}`);
});

test('3.23.0 with bid caching names the bid caching versions, in the real Generate order',async()=>{
  const r323=runtimeCatalog.find(r=>r.version==='3.23.0');
  for(const name of ['rules+cache','accounts+cache','accounts+rules+cache']){
    const expected=expectedVersions(CASES[name].needs);
    const generate=snapshot=>buildArtifactCandidate({snapshot,pin:pinRuntime(r323,{allowPreview:true}),buildTimestamp:TS,prebid:null});
    await assert.rejects(generate(CASES[name].make()),error=>{
      assert.match(error.message,/^Script 3\.23\.0 cannot apply /,name);
      assert.ok(error.message.includes(`select ${choice(expected)} in Script setup and save`),`${name}: ${error.message}`);
      assert.doesNotMatch(error.message,/3\.22|or later/,name);
      return true;
    });
    for(const version of expected)assert.equal(refusal(CASES[name].make(),runtimeCatalog.find(r=>label(r)===version)),null,`${name} -> ${version}`);
  }
});

test('patterns for the guidance are anchored and refuse altered text',()=>{
  const message=refusal(CASES['rules+cache'].make(),runtimeCatalog.find(r=>r.version==='3.23.0'));
  const generic=configurationErrorMessage(Error('x'));
  assert.equal(configurationErrorMessage(Error(message)),message);
  assert.notEqual(message.replace(/select (\S+ \(Preview\)) or /,'select $1, 3.25.0 (Preview) or '),message,'a third name is inserted');
  for(const altered of [message+' ',' '+message,message.replace('3.25.1 (Preview)','3.25.1 (Preview) or later'),message.replace('Script 3.23.0','Script <b>'),message+'\nmore',message.replace('select 3.25.1','select https://example.invalid'),
    message.replace(/select (\S+ \(Preview\)) or /,'select $1, 3.25.0 (Preview) or ')])
    assert.equal(configurationErrorMessage(Error(altered)),generic,altered);
  // With no version named (the releases up to 3.25.0, where 3.24.0 and 3.25.0 have notices), the notice sentence is
  // allowed only as the guidance writes it.
  const noticed=scriptGuidance({accounts:['pm_ag'],rules:false,cache:true},runtimeCatalog.find(r=>r.version==='3.23.0'),upTo('3.25.0'));
  assert.equal(noticed,'Script 3.23.0 cannot apply bidder accounts (pm_ag). No corrected script version is offered that applies bidder accounts and bid caching together. Versions with a runtime notice in Script setup still apply them. Your saved settings and previous packages are unchanged.');
  assert.equal(configurationErrorMessage(Error(noticed)),noticed);
  for(const altered of [noticed.replace('No corrected script version','No corrected script version or later'),noticed.replace('No corrected script version','Select https://example.invalid'),
    // The wrong pronoun, a dangling 'and', a missing 'together' or notice sentence, or the notice sentence after the
    // claim that no version applies them.
    noticed.replace('still apply them','still apply it'),noticed.replace('bidder accounts and bid caching','bidder accounts and'),noticed.replace(' together.','.'),
    noticed.replace(' Versions with a runtime notice in Script setup still apply them.',''),noticed.replace('No corrected script version is offered that applies','No available script version applies'),
    noticed.replace('bid caching together','bid caching or 3.24.0 together')])
    assert.equal(configurationErrorMessage(Error(altered)),generic,altered);
});

// Script setup and Releases read the saved site through the Worker services.
const fixtures=[];
test.afterEach(()=>{while(fixtures.length)fixtures.pop().close();});
function savedSite({cache=false,rules=false,alias=false,timeout=false,version}){
  const f=adminAuditStore({config:{...(cache?{prebidBidCache:CACHE}:{}),...(timeout?{adaptiveAuctionTimeout:TIMEOUT}:{}),runtimeControls:{sticky:{bottomAdUnitId:''},...(rules?{bidderRules:{...RULES,rules:[{...RULES.rules[0],bidder:'pubmatic'}]}}:{})}}});
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
  for(const [options,lacking] of [[{cache:true,rules:true},'enabled bidder rules'],[{cache:true,alias:true},'bidder accounts \\(pm_ag\\)']]){
    const f=savedSite({...options,version:'3.23.0'}),label=JSON.stringify(options);
    const state=await siteRuntimeSettings(f.env,'audit-site');
    assert.match(state.validationIssue,new RegExp(`^Script 3\\.23\\.0 cannot apply ${lacking}\\. To keep them with your saved bid caching, select `),label);
    assert.ok(state.validationIssue.includes(`select ${choice(expectedVersions(['bid-cache',options.rules?'bidder-rules':'bidder-accounts']))} in Script setup and save`),label);
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
  assert.equal(state.validationIssue,`Script 3.21.2 cannot apply enabled bidder rules. Select ${choice(expectedVersions(['bidder-rules']))} in Script setup and save, or turn off bidder rules. Your saved settings and previous packages are unchanged.`);
  assert.equal((await packageState(f.env,'audit-site')).error,state.validationIssue);
});

test('Script setup on 3.21.2 with bid caching does not offer turning bidder rules off alone',async()=>{
  const f=savedSite({rules:true,cache:true,version:'3.21.2'});
  const state=await siteRuntimeSettings(f.env,'audit-site');
  assert.equal(state.validationIssue,`Script 3.21.2 cannot apply enabled bidder rules. To keep them with your saved bid caching, select ${choice(expectedVersions(['bidder-rules','bid-cache']))} in Script setup and save. Your saved settings and previous packages are unchanged.`);
  // Releases show the same guidance, as Generate checks it first, and do not send the site to Demand for bid caching.
  const packages=await packageState(f.env,'audit-site');
  assert.equal(packages.error,state.validationIssue);assert.notEqual(packages.nextStep,'demand');
  await assert.rejects(generatePackage(f.env,'audit-site','admin@example.invalid',{notes:'',revision:packages.revision}),error=>error.message===state.validationIssue);
  // Turning rules off on 3.21.2 would only lead to the bid caching refusal.
  const config=f.readConfig();config.runtimeControls.bidderRules.enabled=false;f.writeConfig(config);
  assert.equal((await siteRuntimeSettings(f.env,'audit-site')).validationIssue,null);
  assert.equal((await packageState(f.env,'audit-site')).error,bidCacheGeneratorMessage(f.readConfig(),[]));
  assert.ok(bidCacheGeneratorMessage(f.readConfig(),[]).includes(`Select ${choice(expectedVersions(['bid-cache']))} in Script setup and save;`));
});

test('versions come from release capabilities: the smallest step and the newest, notices, ties, one release and none',async()=>{
  const {scriptVersionsWith,scriptVersionLabels,scriptVersionText,scriptGuidance}=await import('../../worker/site-runtime/script-version-guidance.mjs');
  // Every named release is bundled in the catalog with the same source, so it can be selected.
  for(const needs of [['bidder-rules'],['bidder-accounts'],['bid-cache'],['bidder-rules','bid-cache']]){
    assert.deepEqual(scriptVersionLabels(needs),expectedVersions(needs),needs.join('+'));
    for(const release of scriptVersionsWith(needs))assert.ok(runtimeCatalog.some(r=>r.id===release.id&&r.version===release.version&&r.codeSha256===release.codeSha256),release.version);
  }
  // The registry up to 3.26.0 (MAIN): 3.22.1 and 3.22.2 tie, so the newer patch is the smallest step for bidder rules
  // and accounts; 3.24.0 is the smallest step with bid caching (3.23.0 has a notice); 3.26.0 is the newest.
  assert.equal(scriptVersionText(['bidder-rules'],MAIN_3260),'3.22.2 (Preview) or 3.26.0 (Preview)');
  assert.equal(scriptVersionText(['bidder-accounts'],MAIN_3260),'3.22.2 (Preview) or 3.26.0 (Preview)');
  for(const needs of [['bid-cache'],['bidder-rules','bid-cache'],['bidder-accounts','bidder-rules','bid-cache']])assert.equal(scriptVersionText(needs,MAIN_3260),'3.25.1 (Preview) or 3.26.0 (Preview)');
  // The registry up to 3.24.0 (TEST) keeps the names it has today.
  assert.equal(scriptVersionText(['bidder-rules'],TEST_3240),'3.22.2 (Preview)');
  assert.deepEqual(scriptVersionLabels(['bidder-accounts','bid-cache'],TEST_3240),[]);
  // A later notice moves the smallest step: with one on 3.24.0, 3.25.0 and 3.25.1 tie and the newer patch is named.
  const r324=runtimeReleaseHistory.find(r=>r.version==='3.24.0');
  const notices=[...runtimeNotices,{version:'3.24.0',runtimeSha256:r324.codeSha256}];
  assert.equal(scriptVersionText(['bid-cache'],MAIN_3260,notices),'3.25.1 (Preview) or 3.26.0 (Preview)');
  assert.deepEqual(scriptVersionLabels(['bid-cache'],MAIN_3260,notices),expectedVersions(['bid-cache'],MAIN_3260,notices));
  // A notice matches the exact source only: another build of 3.24.0 would stay offered.
  assert.equal(scriptVersionText(['bid-cache'],MAIN_3260,[...runtimeNotices.filter(n=>n.version!=='3.24.0'),{version:'3.24.0',runtimeSha256:'0'.repeat(64)}]),'3.24.0 (Preview) or 3.26.0 (Preview)');
  // One release: the smallest step is the newest. Up to 3.22.2, 3.22.1 and 3.22.2 tie (3.22.0 has a notice).
  assert.deepEqual(scriptVersionLabels(['bidder-rules'],upTo('3.22.2')),['3.22.2 (Preview)']);
  assert.deepEqual(scriptVersionLabels(['bidder-rules'],upTo('3.22.1')),['3.22.1 (Preview)']);
  // None: up to 3.23.0 no release without a notice has bidder rules and bid caching.
  assert.deepEqual(scriptVersionsWith(['bidder-rules','bid-cache'],upTo('3.23.0')),[]);
  assert.equal(scriptVersionText(['bidder-rules','bid-cache'],upTo('3.23.0')),'');
  const none=scriptGuidance({accounts:[],rules:true,cache:true},runtimeCatalog.find(x=>x.version==='3.21.2'),upTo('3.23.0'));
  assert.equal(none,'Script 3.21.2 cannot apply enabled bidder rules. No available script version applies bidder rules and bid caching together. Your saved settings and previous packages are unchanged.');
  // Synthetic releases: a suffixed build is never offered, an older release may be the smallest step, and the names
  // stay two however many releases qualify.
  const r=(version,channel,capabilities,codeSha256=version)=>({id:'tessera-'+version,version,channel,capabilities,codeSha256});
  const history=[r('4.3.0','stable',['a','b','c']),r('4.2.0-tessera.preview.1','preview',['a']),r('4.2.0','preview',['a','b']),r('4.1.1','stable',['a','b']),r('4.1.0','stable',['a','b']),r('4.0.0','stable',['a','x']),r('3.22.0','stable',['a'],runtimeNotices[0].runtimeSha256)];
  assert.equal(scriptVersionText(['a'],history),'4.2.0 (Preview) or 4.3.0');
  assert.equal(scriptVersionText(['x'],history),'4.0.0');
  assert.equal(scriptVersionText(['a','b','c','d'],history),'');
  assert.equal(scriptGuidance({accounts:['a1','a2','a3','a4','a5'],rules:true,cache:true},{version:'4.0.2',capabilities:['a']},history),
    'Script 4.0.2 cannot apply bidder accounts (a1, a2, a3 and 2 more) or enabled bidder rules. No available script version applies bidder accounts, bidder rules and bid caching together. Your saved settings and previous packages are unchanged.');
  for(const message of [none,scriptGuidance({accounts:['a1','a2','a3','a4','a5'],rules:true,cache:true},{version:'4.0.2',capabilities:['a']},history),scriptGuidance({accounts:[],rules:true,cache:false},null)])
    assert.equal(configurationErrorMessage(Error(message)),message);
  assert.equal(scriptGuidance({accounts:[],rules:true,cache:false},null),`This script cannot apply enabled bidder rules. Select ${choice(expectedVersions(['bidder-rules']))} in Script setup and save, or turn off bidder rules. Your saved settings and previous packages are unchanged.`);
  // Accounts with a script that has bidder rules: the rules are named as kept, and no rules off-switch is offered.
  const r322=runtimeCatalog.find(x=>x.version==='3.22.0');
  assert.equal(scriptGuidance({accounts:['pm_ag'],rules:true,cache:false},r322),`Script 3.22.0 cannot apply bidder accounts (pm_ag). To keep them with your saved bidder rules, select ${choice(expectedVersions(['bidder-accounts','bidder-rules']))} in Script setup and save. Your saved settings and previous packages are unchanged.`);
  assert.equal(scriptGuidance({accounts:['pm_ag'],rules:true,cache:true},runtimeCatalog.find(x=>x.version==='3.24.0')),null);
  // An enabled adaptive timeout is kept like bid caching: only versions with it are named, and turning bidder rules
  // off alone is not offered, because the script would still refuse the timeout.
  for(const needs of [['bidder-rules','adaptive-auction-timeout'],['bidder-accounts','adaptive-auction-timeout'],['bidder-accounts','bidder-rules','bid-cache','adaptive-auction-timeout']])
    assert.equal(scriptVersionText(needs,MAIN_3260),'3.26.0 (Preview)',needs.join('+'));
  const r3212=runtimeCatalog.find(x=>x.version==='3.21.2');
  const timeoutRules=scriptGuidance({accounts:[],rules:true,cache:false,timeout:true},r3212);
  assert.equal(timeoutRules,`Script 3.21.2 cannot apply enabled bidder rules. To keep them with your saved adaptive timeout, select ${choice(expectedVersions(['bidder-rules','adaptive-auction-timeout']))} in Script setup and save. Your saved settings and previous packages are unchanged.`);
  const timeoutAll=scriptGuidance({accounts:['pm_ag'],rules:true,cache:true,timeout:true},r322);
  assert.equal(timeoutAll,`Script 3.22.0 cannot apply bidder accounts (pm_ag). To keep them with your saved bidder rules, bid caching and adaptive timeout, select ${choice(expectedVersions(['bidder-accounts','bidder-rules','bid-cache','adaptive-auction-timeout']))} in Script setup and save. Your saved settings and previous packages are unchanged.`);
  assert.equal(scriptGuidance({accounts:[],rules:true,cache:false,timeout:true},runtimeCatalog.find(x=>x.version==='3.26.0')),null);
  const timeoutNone=scriptGuidance({accounts:['a1'],rules:true,cache:true,timeout:true},{version:'4.0.2',capabilities:['a']},history);
  assert.equal(timeoutNone,'Script 4.0.2 cannot apply bidder accounts (a1) or enabled bidder rules. No available script version applies bidder accounts, bidder rules, bid caching and adaptive timeout together. Your saved settings and previous packages are unchanged.');
  for(const message of [timeoutRules,timeoutAll,timeoutNone])assert.equal(configurationErrorMessage(Error(message)),message);
  // The bid caching panels name the same versions.
  assert.deepEqual(bidCacheScriptVersions({enablePrebid:true,prebidBidCache:CACHE,adaptiveAuctionTimeout:TIMEOUT},[]),expectedVersions(['bid-cache','adaptive-auction-timeout']));
  assert.deepEqual(bidCacheScriptVersions({enablePrebid:true,prebidBidCache:CACHE,adaptiveAuctionTimeout:{...TIMEOUT,enabled:false}},[]),expectedVersions(['bid-cache']));
});

test('with no named version the guidance says whether a version with a runtime notice still applies the options',async()=>{
  const {bidCacheNoticedScriptApplies}=await import('../../worker/site-runtime/prebid-cache-settings.mjs');
  const r3212=runtimeCatalog.find(x=>x.version==='3.21.2');
  // Up to 3.25.0, 3.24.0 and 3.25.0 apply bidder rules and bid caching but have runtime notices, so none is named.
  const noticed=scriptGuidance({accounts:[],rules:true,cache:true},r3212,upTo('3.25.0'));
  assert.equal(noticed,'Script 3.21.2 cannot apply enabled bidder rules. No corrected script version is offered that applies bidder rules and bid caching together. Versions with a runtime notice in Script setup still apply them. Your saved settings and previous packages are unchanged.');
  assert.equal(noticed,`Script 3.21.2 cannot apply enabled bidder rules. ${noVersionText(['bidder-rules','bid-cache'],upTo('3.25.0'))} Your saved settings and previous packages are unchanged.`);
  // Up to 3.23.0 no release applies both, with or without a notice.
  const none=scriptGuidance({accounts:[],rules:true,cache:true},r3212,upTo('3.23.0'));
  assert.equal(none,'Script 3.21.2 cannot apply enabled bidder rules. No available script version applies bidder rules and bid caching together. Your saved settings and previous packages are unchanged.');
  // One option: no 'together', and the pronoun follows the number.
  const accounts322=[{id:'tessera-3.22.0',version:'3.22.0',channel:'stable',capabilities:['bidder-accounts'],codeSha256:runtimeNotices[0].runtimeSha256}];
  const one=scriptGuidance({accounts:['a1'],rules:false,cache:false},{version:'4.0.2',capabilities:[]},accounts322);
  assert.equal(one,'Script 4.0.2 cannot apply bidder accounts (a1). No corrected script version is offered that applies bidder accounts. Versions with a runtime notice in Script setup still apply it. Your saved settings and previous packages are unchanged.');
  const oneNone=scriptGuidance({accounts:['a1'],rules:false,cache:false},{version:'4.0.2',capabilities:[]},[]);
  assert.equal(oneNone,'Script 4.0.2 cannot apply bidder accounts (a1). No available script version applies bidder accounts. Your saved settings and previous packages are unchanged.');
  // An adaptive timeout that no release up to 3.25.1 applies: no version applies it, with or without a notice.
  const timeout=scriptGuidance({accounts:[],rules:true,cache:false,timeout:true},r3212,upTo('3.25.1'));
  assert.equal(timeout,'Script 3.21.2 cannot apply enabled bidder rules. No available script version applies bidder rules and adaptive timeout together. Your saved settings and previous packages are unchanged.');
  for(const message of [noticed,none,one,oneNone,timeout])assert.equal(configurationErrorMessage(Error(message)),message,message);
  const generic=configurationErrorMessage(Error('x'));
  for(const altered of [one.replace('still apply it','still apply them'),one.replace('bidder accounts.','bidder accounts together.'),oneNone.replace('bidder accounts.','bidder accounts and.'),none.replace(' together.','.'),
    none.replace('bidder rules and bid caching','bidder rules and bid caching and bidder accounts'),none.replace('bidder rules and bid caching','bidder rules, bid caching')])
    assert.equal(configurationErrorMessage(Error(altered)),generic,altered);
  // Generate's bid caching refusal and the cache panels' flag follow the same three cases.
  const config={enablePrebid:true,runtimeControls:{bidderRules:{schemaVersion:1,enabled:true,rules:[]}}};
  assert.ok(bidCacheGeneratorMessage(config,[],upTo('3.25.0')).startsWith(`Bid caching needs a compatible script version. ${noVersionText(['bidder-rules','bid-cache'],upTo('3.25.0'))} Your bid cache settings are kept. To use this script version, `));
  assert.ok(bidCacheGeneratorMessage({},[],upTo('3.22.2')).startsWith('Bid caching needs a compatible script version. No available script version applies bid caching. Your bid cache settings are kept. To use this script version, '));
  assert.deepEqual([bidCacheScriptVersions(config,[],upTo('3.25.0')),bidCacheNoticedScriptApplies(config,[],upTo('3.25.0'))],[[],true]);
  assert.deepEqual([bidCacheScriptVersions(config,[],upTo('3.23.0')),bidCacheNoticedScriptApplies(config,[],upTo('3.23.0'))],[[],false]);
  // With MAIN's registry a version is named, and versions with a notice are only reported, never named.
  assert.deepEqual(bidCacheScriptVersions(config,[]),expectedVersions(['bidder-rules','bid-cache']));
  assert.equal(bidCacheNoticedScriptApplies(config,[]),noticedApplies(['bidder-rules','bid-cache']));
});

// Panel copy reads the versions from the server payloads, so it follows the saved options and the registry.
const source=path=>readFile(new URL('../../'+path,import.meta.url),'utf8');
test('with no version named, the Bidder rules panel says whether a version with a runtime notice still applies the rules',async()=>{
  const panel=await source('src/components/BidderRulesPanel.tsx');
  assert.match(panel,/payload\.noticedScriptApplies===true\s*\?'No corrected script version is offered that applies bidder rules with your other saved options\. Versions with a runtime notice in Script setup still apply them\.'\s*:'No available script version applies bidder rules with your other saved options\.'/);
  // The note and the save message use the same sentence and never name a noticed version.
  assert.match(panel,/\?`You can save rules now\. \$\{noScriptText\(data\)\}`:/);
  assert.match(panel,/\?`Saved\. \$\{noScriptText\(value\)\} Your rules are kept; existing scripts are unchanged\.`:/);
});

test('the Bidder rules and Bidders payloads name the versions for their option plus the saved ones',async()=>{
  const {getBidderRuleSettings}=await import('../../worker/site-runtime/bidder-rule-settings.mjs');
  const {listBidders}=await import('../../worker/bidders.ts');
  for(const [options,needs] of [[{},[]],[{cache:true},['bid-cache']],[{rules:true,alias:true},['bidder-accounts','bidder-rules']],[{cache:true,rules:true,alias:true,version:'3.23.0'},['bidder-accounts','bidder-rules','bid-cache']],[{timeout:true},['adaptive-auction-timeout']],[{cache:true,alias:true,timeout:true},['bidder-accounts','bid-cache','adaptive-auction-timeout']]]){
    const f=savedSite(options),label=JSON.stringify(options);
    const rules=await getBidderRuleSettings(f.env,'audit-site');
    assert.deepEqual(rules.scriptVersions,expectedVersions(['bidder-rules',...needs]),label);assert.equal(rules.runtimeEligible,false,label);
    const bidders=await (await listBidders(f.env,'audit-site')).json();
    assert.deepEqual(bidders.accountScriptVersions,expectedVersions(['bidder-accounts',...needs]),label);assert.ok(Array.isArray(bidders.bidders),label);
    for(const versions of [rules.scriptVersions,bidders.accountScriptVersions])assert.ok(versions.length>=1&&versions.length<=2,label);
    // Whether a version with a runtime notice applies the same options, so an empty list is not read as none existing.
    assert.equal(rules.noticedScriptApplies,noticedApplies([...new Set(['bidder-rules',...needs])]),label);
    assert.equal(bidders.accountNoticedScriptApplies,noticedApplies([...new Set(['bidder-accounts',...needs])]),label);
  }
});

test('the Bidders payload says whether the selected script applies bidder accounts with the saved options',async()=>{
  const {listBidders}=await import('../../worker/bidders.ts');
  const {pinnedReleaseApplies}=await import('../../worker/site-runtime/script-versions.mjs');
  // Computed here from the registry: the release the saved pin names has bidder accounts and every other saved option.
  const applies=(version,needs)=>!!version&&needs.every(capability=>runtimeReleaseHistory.find(r=>r.version===version).capabilities.includes(capability));
  for(const [options,needs] of [
    [{cache:true,alias:true,version:'3.24.0'},['bidder-accounts','bid-cache']],
    [{cache:true,rules:true,alias:true,version:'3.26.0'},['bidder-accounts','bidder-rules','bid-cache']],
    [{cache:true,rules:true,alias:true,timeout:true,version:'3.25.1'},['bidder-accounts','bidder-rules','bid-cache','adaptive-auction-timeout']],
    [{cache:true,alias:true,version:'3.23.0'},['bidder-accounts','bid-cache']],
    [{alias:true,version:'3.22.1'},['bidder-accounts']],
    [{rules:true,alias:true,version:'3.22.1'},['bidder-accounts','bidder-rules']],
    [{cache:true,alias:true,version:'3.22.1'},['bidder-accounts','bid-cache']],
    [{alias:true,version:'3.21.2'},['bidder-accounts']],
    [{cache:true,alias:true},['bidder-accounts','bid-cache']],
  ]){
    const f=savedSite(options),label=JSON.stringify(options);
    const bidders=await (await listBidders(f.env,'audit-site')).json();
    assert.equal(bidders.selectedScriptAppliesAccounts,applies(options.version,needs),label);
    // A selected script with a runtime notice (3.24.0) applies them but is never named.
    if(options.version==='3.24.0')assert.ok(bidders.selectedScriptAppliesAccounts&&!bidders.accountScriptVersions.some(version=>version.startsWith('3.24.0')),label);
  }
  // The pin must match the registry release by id, version and source checksum.
  const r326=runtimeReleaseHistory.find(r=>r.version==='3.26.0'),pin=pinRuntime(runtimeCatalog.find(r=>r.version==='3.26.0'),{allowPreview:true});
  assert.equal(pinnedReleaseApplies(pin,['bidder-accounts','bid-cache']),true);
  for(const changed of [{...pin,runtimeSha256:'0'.repeat(64)},{...pin,runtimeId:'tessera-3.25.1'},{...pin,runtimeVersion:'3.25.1'},null,undefined])
    assert.equal(pinnedReleaseApplies(changed,['bidder-accounts']),false,JSON.stringify(changed));
  assert.equal(pinnedReleaseApplies(pin,[...r326.capabilities,'future']),false);
});

test('the account notes in Bidders tell unknown versions from none, and say when the selected script applies accounts',async()=>{
  const panel=await source('src/components/BiddersPanel.tsx'),client=await source('src/api.ts');
  // Unknown while loading, after a load failure or without a list: the neutral sentences, never "No available".
  assert.match(panel,/useState<AccountScripts \| null>\(null\)/);
  assert.match(panel,/setAccountScripts\(null\)/);
  assert.doesNotMatch(client,/accountScriptVersions \?\? \[\]/);
  assert.match(client,/Array\.isArray\(payload\.accountScriptVersions\)/);
  assert.match(panel,/if \(!scripts\) return 'Aliases and account-specific SChain require a script version that applies bidder accounts with your other saved options\.';/);
  assert.match(panel,/if \(!scripts\) return 'The new account alias is registered by a script version that applies bidder accounts\.';/);
  // A named list is unchanged and comes first. With no name, a selected script that applies accounts with the other
  // saved options is said to apply them, before any denial.
  const form=panel.indexOf('function accountFormNote'),alias=panel.indexOf('function aliasNote');
  assert.ok(form>0&&alias>0);
  for(const [start,named,selected] of [[form,'Aliases and account-specific SChain require script','The selected script applies aliases and account-specific SChain with your other saved options. Save the account, then generate a new package.'],[alias,'The new account alias is registered by script','The new account alias is registered by the selected script.']]){
    const body=panel.slice(start,panel.indexOf('\n}\n',start));
    assert.ok(body.indexOf(named)>0&&body.indexOf(named)<body.indexOf('scripts.selectedApplies')&&body.indexOf('scripts.selectedApplies')<body.indexOf('scripts.noticedApplies'),body);
    assert.ok(body.includes(`return '${selected}';`),selected);
  }
  // Known empty: whether a version with a runtime notice still applies them, never naming it.
  assert.match(panel,/'No corrected script version is offered that applies aliases and account-specific SChain with your other saved options\. Versions with a runtime notice in Script setup still apply them\. You can save the account for a future package\.'/);
  assert.match(panel,/'No available script version applies aliases and account-specific SChain with your other saved options\. You can save the account for a future package\.'/);
  assert.match(panel,/'No corrected script version is offered that applies the new alias with your other saved options\. Versions with a runtime notice in Script setup still apply it\.'/);
  assert.match(panel,/'No available script version applies the new alias with your other saved options\.'/);
});
