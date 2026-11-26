// TEST wording around bid caching: it works for every site, so no TEST page ties it to the Tanjug copy, the home
// page links the TEST site's own Bid caching view, and bidder rules name the versions the server derives, never a
// fixed version or "or later" (3.23.0 is later but has no bidder rules).
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {workspacePage} from '../../worker/test-workspace/page.mjs';
import {TEST_BID_CACHE_GENERATOR_MESSAGE,TEST_BID_CACHE_BIDDER_RULES_MESSAGE,BIDDER_RULES_WITHOUT_BID_CACHE_MESSAGE} from '../../worker/test-workspace/bid-cache-messages.mjs';
import {testBidderRulesMessages,testBidCacheMessage} from '../../worker/test-workspace/bid-cache-messages.mjs';
import {bidCacheGeneratorMessage,bidCacheScriptVersions} from '../../worker/site-runtime/prebid-cache-settings.mjs';
import {runtimeCatalog} from '../../worker/test-workspace/runtime-catalog.mjs';
import {runtimeReleaseHistory} from '../../worker/runtime/runtime-release-history.mjs';
import {runtimeNotices} from '../../shared/runtime-notices.mjs';
const source=path=>readFile(new URL('../../'+path,import.meta.url),'utf8');
const choiceOf=labels=>labels.length<2?labels[0]??'':`${labels.slice(0,-1).join(', ')} or ${labels.at(-1)}`;
const numbers=labels=>labels.map(label=>label.replace(' (Preview)',''));
// Offered-version wording uses the TEST Preview terminology; no candidate gets explicit fallback copy.
const testChoice=labels=>`select ${choiceOf(labels.map(label=>label.replace(' (Preview)',' Preview')))} in Script setup, ${labels.some(label=>label.endsWith(' (Preview)'))?'allow Preview scripts, ':''}and save.`;
const TEST_3240=runtimeReleaseHistory.filter(r=>/^\d+\.\d+\.\d+$/.test(r.version)&&r.version.split('.').map(Number).reduce((a,n)=>a*1000+n,0)<=3024000);

test('the TEST home page links the TEST site Bid caching view next to Prebid and bidders',()=>{
 const page=workspacePage('tester@example.invalid');
 assert.match(page,/<a class="button" href="\/prebid-settings">Prebid and bidders<\/a><a class="button" href="\/site-workspace#bid-cache">Bid caching<\/a>/);
});

test('the named-script page does not describe the Tanjug copy as the place for bid cache settings',async()=>{
 const entry=await source('src/site-workspace/named-script-test-entry.tsx');
 assert.doesNotMatch(entry,/Tanjug test copy for named scripts and bid-cache settings/);
 assert.match(entry,/<p>A separate Tanjug test copy for named scripts\. Bid caching for your TEST site is in Site workspace → Bid caching\. Your existing TEST site stays unchanged\. No ads run here\.<\/p>/);
});

test('bidder rules copy names the versions from the server payload, not a fixed version or "or later"',async()=>{
 const panel=await source('src/components/BidderRulesPanel.tsx');
 assert.doesNotMatch(panel,/or later/);
 assert.doesNotMatch(panel,/script version 3\.2|version 3\.22\.0/);
 assert.match(panel,/versionChoice\(payload\.scriptVersions\?\?\[\]\)/);
 assert.match(panel,/You can save rules now\. Select and save \{scriptChoice\(data\)\} before generating a package that uses them\./);
 assert.match(panel,/`Saved\. Select and save \$\{scriptChoice\(value\)\}, then generate a new script to apply these rules\. Existing scripts are unchanged\.`/);
 // With no version named, the panel says whether a version with a runtime notice still applies them (3.24.0 on TEST
 // with saved bid caching), and never names that version.
 assert.match(panel,/payload\.noticedScriptApplies===true\s*\?'No corrected script version is offered that applies bidder rules with your other saved options\. Versions with a runtime notice in Script setup still apply them\.'\s*:'No available script version applies bidder rules with your other saved options\.'/);
});

test('the TEST Prebid editor names the account script versions from the server, not 3.22.1 or a later version',async()=>{
 const {prebidPage,prebidScript}=await import('../../worker/test-workspace/prebid-page.mjs');
 assert.doesNotMatch(prebidPage(),/3\.22\.1|or a later version/);
 assert.match(prebidPage(),/<p class="muted" id="account-scripts">Account aliases and custom or no-upstream SChain require a script version that applies bidder accounts with your other saved options\. Saving preparation does not switch the script version\.<\/p>/);
 assert.match(prebidScript,/state\.accountScriptVersions/);
});

test('the TEST Prebid editor account note follows the payload: named, selected, noticed, none or unknown',async()=>{
 const {prebidScript}=await import('../../worker/test-workspace/prebid-page.mjs');
 const start=prebidScript.indexOf('function accountNote('),end=prebidScript.indexOf('\n',start);
 assert.ok(start>=0,'accountNote is defined');
 const accountNote=new Function(`${prebidScript.slice(start,end)};return accountNote;`)();
 const tail=' Saving preparation does not switch the script version.';
 const cases=[
  [{accountScriptVersions:['3.22.2 (Preview)'],accountNoticedScriptApplies:false,selectedScriptAppliesAccounts:true},'Account aliases and custom or no-upstream SChain require script 3.22.2 (Preview).'],
  [{accountScriptVersions:[],accountNoticedScriptApplies:true,selectedScriptAppliesAccounts:true},'The selected script applies account aliases and custom or no-upstream SChain with your other saved options.'],
  [{accountScriptVersions:[],accountNoticedScriptApplies:true,selectedScriptAppliesAccounts:false},'No corrected script version is offered that applies account aliases and custom or no-upstream SChain with your other saved options. Versions with a runtime notice in Script setup still apply them.'],
  [{accountScriptVersions:[],accountNoticedScriptApplies:false,selectedScriptAppliesAccounts:false},'No available script version applies account aliases and custom or no-upstream SChain with your other saved options.'],
  // Unknown: no list in the payload. The note names no version and denies none.
  [{},'Account aliases and custom or no-upstream SChain require a script version that applies bidder accounts with your other saved options.'],
 ];
 for(const [state,expected] of cases)assert.equal(accountNote(state),expected+tail,JSON.stringify(state));
 assert.match(prebidScript,/el\('account-scripts'\)\.textContent=accountNote\(state\)/);
});

test('the TEST bid caching messages name the scripts the panels name, from the registry',()=>{
 // The panels and the shared Generate refusal name the versions for the site's saved options, at most two, read from
 // the registry; the TEST messages for bid caching with bidder rules name the versions the panels name for that site.
 const rules={enablePrebid:true,runtimeControls:{bidderRules:{schemaVersion:1,enabled:true,rules:[]}}};
 const plain=bidCacheScriptVersions({},[]),withRules=bidCacheScriptVersions(rules,[]);
 assert.deepEqual(plain,[]);assert.deepEqual(withRules,[]);
 assert.ok(TEST_BID_CACHE_GENERATOR_MESSAGE.includes(' No corrected script version is offered that applies bid caching. Versions with a runtime notice in Script setup still apply it. '),TEST_BID_CACHE_GENERATOR_MESSAGE);
 assert.doesNotMatch(TEST_BID_CACHE_GENERATOR_MESSAGE,/Select |select /);
 assert.equal(testBidCacheMessage(bidCacheGeneratorMessage({},[]),{}),TEST_BID_CACHE_GENERATOR_MESSAGE);
 assert.equal(testBidCacheMessage(bidCacheGeneratorMessage(rules,[]),rules),TEST_BID_CACHE_BIDDER_RULES_MESSAGE);
 // TEST offers no corrected combined cache version and never recommends a noticed or unavailable release.
 for(const message of [TEST_BID_CACHE_BIDDER_RULES_MESSAGE,BIDDER_RULES_WITHOUT_BID_CACHE_MESSAGE]){
  assert.ok(message.includes(' No corrected script version is offered that applies bid caching and bidder rules together. Versions with a runtime notice in Script setup still apply them. '),message);
  assert.doesNotMatch(message,/To use both, select|3\.24\.0|3\.25/);
 }
 // "Script 3.23.0 has bid caching but cannot apply enabled bidder rules" fits every script that gets that message.
 assert.deepEqual(runtimeCatalog.filter(r=>r.capabilities.includes('bid-cache')&&!r.capabilities.includes('bidder-rules')).map(r=>r.version),['3.23.0']);
 assert.deepEqual((TEST_BID_CACHE_GENERATOR_MESSAGE.match(/\b\d+\.\d+\.\d+\b/g)??[]),numbers(plain),TEST_BID_CACHE_GENERATOR_MESSAGE);
 assert.deepEqual((TEST_BID_CACHE_BIDDER_RULES_MESSAGE.match(/\b\d+\.\d+\.\d+\b/g)??[]),numbers(withRules),TEST_BID_CACHE_BIDDER_RULES_MESSAGE);
 assert.deepEqual([...new Set(BIDDER_RULES_WITHOUT_BID_CACHE_MESSAGE.match(/\b\d+\.\d+\.\d+\b/g))],['3.23.0',...numbers(withRules)]);
});

test('the TEST bid caching messages preserve their suffix with no corrected choice and follow a new release or notice',()=>{
 // Exactly the TEST texts with the releases up to 3.24.0.
 const keep='open Bid caching, turn off Reuse valid, unused bids, remove unused overrides there, and set positions that are On to Use site setting under Bid cache by position.';
 assert.equal(TEST_BID_CACHE_GENERATOR_MESSAGE,'Bid caching needs a compatible script version. No corrected script version is offered that applies bid caching. Versions with a runtime notice in Script setup still apply it. Your bid cache settings are kept. To use this script version, '+keep);
 assert.doesNotMatch(TEST_BID_CACHE_GENERATOR_MESSAGE,/scripopen|Config →|3\.24|3\.25/);
 assert.equal(TEST_BID_CACHE_BIDDER_RULES_MESSAGE,'This script cannot combine bid caching and bidder rules. No corrected script version is offered that applies bid caching and bidder rules together. Versions with a runtime notice in Script setup still apply them. '
  +'To keep this script version instead, turn bid caching off: '+keep+' Your saved bidder rules are kept.');
 assert.equal(BIDDER_RULES_WITHOUT_BID_CACHE_MESSAGE,'Script 3.23.0 has bid caching but cannot apply enabled bidder rules. No corrected script version is offered that applies bid caching and bidder rules together. Versions with a runtime notice in Script setup still apply them. '
  +'To keep 3.23.0 instead, turn off bidder rules in Bidder rules. Your saved settings are kept.');
 assert.deepEqual(testBidderRulesMessages(TEST_3240),{combined:TEST_BID_CACHE_BIDDER_RULES_MESSAGE,withoutBidCache:BIDDER_RULES_WITHOUT_BID_CACHE_MESSAGE});
 // MAIN's later releases (synthetic here): two versions; a notice on 3.24.0 moves the smallest step to 3.25.1.
 const r324=runtimeReleaseHistory.find(r=>r.version==='3.24.0');
 const later=(version,extra)=>({id:'synthetic-'+version,version,channel:'preview',codeSha256:'synthetic-'+version,capabilities:[...r324.capabilities,...extra]});
 const main=[...TEST_3240,later('3.25.0',['gam-bid-origin','gam-request-timing']),later('3.25.1',['gam-bid-origin','gam-request-timing']),later('3.26.0',['gam-bid-origin','gam-request-timing','adaptive-auction-timeout'])];
 const notice=[...runtimeNotices,{version:'3.24.0',runtimeSha256:r324.codeSha256}];
 for(const [history,notices,expected] of [[main,runtimeNotices.filter(n=>n.version!=='3.24.0'),'3.24.0 Preview or 3.26.0 Preview'],[main,notice,'3.25.1 Preview or 3.26.0 Preview']]){
  const messages=testBidderRulesMessages(history,notices);
  for(const message of Object.values(messages))assert.ok(message.includes(`To use both, select ${expected} in Script setup, allow Preview scripts, and save.`),message);
  // The same versions as the panels for a site with bidder rules on that history.
  assert.equal(testChoice(bidCacheScriptVersions({enablePrebid:true,runtimeControls:{bidderRules:{enabled:true}}},[],history,notices)),`select ${expected} in Script setup, allow Preview scripts, and save.`);
  // The shared refusal for such a site is recognized and worded with the TEST views.
  const shared=bidCacheGeneratorMessage({},[],history,notices);
  assert.equal(testBidCacheMessage(shared,{}),shared.replace('turn bid caching off in Config → Demand → Prebid, remove unused overrides there, and set positions that are On to Use site setting under Config → Ad units → Bid cache.',keep));
 }
 // No version without a notice applies both: the messages say so instead of naming one, and that 3.24.0, which has a
 // notice, still applies them. Up to 3.23.0 no version applies both at all.
 assert.ok(testBidderRulesMessages(TEST_3240,notice).combined.includes(' No corrected script version is offered that applies bid caching and bidder rules together. Versions with a runtime notice in Script setup still apply them. To keep '));
 const upTo323=TEST_3240.filter(r=>r.version!=='3.24.0');
 for(const message of Object.values(testBidderRulesMessages(upTo323)))assert.ok(message.includes(' No available script version applies bid caching and bidder rules together. To keep '),message);
 assert.ok(bidCacheGeneratorMessage({},[],upTo323).startsWith('Bid caching needs a compatible script version. No corrected script version is offered that applies bid caching. Versions with a runtime notice in Script setup still apply it. '));
 assert.ok(bidCacheGeneratorMessage({},[],upTo323.filter(r=>r.version!=='3.23.0')).startsWith('Bid caching needs a compatible script version. No available script version applies bid caching. Your bid cache settings are kept. '));
 // Other messages pass unchanged.
 for(const message of ['Something else.','Bid caching needs a compatible script version, but an unrecognized ending.'])assert.equal(testBidCacheMessage(message,{}),message);
});

test('the cache panels check the selected script before the empty list, and the save message agrees with them',async()=>{
 const mode=await source('src/components/PrebidModePanel.tsx'),position=await source('src/components/PositionBidCachePanel.tsx');
 // A selected script that applies bid caching (3.23.0 or 3.24.0 on TEST) is said to apply it, never shown like 3.21.2.
 assert.match(mode,/<p>\{payload\.runtimeSupportsBidCache \? `Applies to new packages generated with the selected script\.\$\{noCacheScript \? ` \$\{NO_CORRECTED_CACHE_SCRIPT\}\.` : ''\}` : noCacheScript \?/);
 assert.match(position,/<p>\{data\.runtimeSupportsBidCache\?`Applies to the next package generated with the selected script\.\$\{data\.bidCacheScriptVersions\?\.length===0\?` \$\{NO_CORRECTED_CACHE_SCRIPT\}\.`:''\}`:data\.bidCacheScriptVersions\?\.length===0\?/);
 // With no version to select, neither Demand save message (with or without named scripts) asks to select one.
 assert.match(mode,/\? next\.bidCacheScriptVersions\?\.length === 0\s*\/\/[^\n]*\n\s*\? `Prebid settings saved\.\$\{next\.namedScriptLibrary \? ' New named scripts use them\.' : ''\} \$\{noCacheScriptText\(next\)\}; your bid cache settings are kept\.`/);
 // A version with a runtime notice is never named; the panels only say that such versions still apply bid caching.
 for(const panel of [mode,position])assert.match(panel,/Versions with a runtime notice in Script setup still apply bid caching with your other saved options\./);
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
 // saved options (3.24.0 with saved bid caching on TEST) is said to apply them, before any denial.
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

test('comments and types near the version names never show a label the naming rule cannot give',async()=>{
 // A release with a runtime notice that excludes it from recommendation is never named, so no example label for it
 // may appear where the names are produced or typed (3.24.0 (Preview) on TEST).
 const excluded=runtimeNotices.filter(notice=>notice.excludeFromRecommendation===true)
  .map(notice=>runtimeReleaseHistory.find(r=>r.version===notice.version&&r.codeSha256===notice.runtimeSha256))
  .filter(release=>release?.channel==='preview').map(release=>`${release.version} (Preview)`);
 assert.ok(excluded.includes('3.24.0 (Preview)'),excluded.join());
 for(const path of ['worker/site-runtime/script-versions.mjs','worker/site-runtime/prebid-cache-settings.mjs','worker/site-runtime/script-version-guidance.mjs','worker/prebid-mode.ts','worker/bidders.ts','src/components/PrebidModePanel.tsx','src/components/PositionBidCachePanel.tsx','src/components/BiddersPanel.tsx','src/components/BidderRulesPanel.tsx','src/shared/types.ts']){
  const text=await source(path);
  for(const label of excluded)assert.ok(!text.includes(label),`${path} shows ${label}`);
 }
});
