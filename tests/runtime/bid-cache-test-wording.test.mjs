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
// "select 3.24.0 Preview in Script setup, allow Preview scripts, and save." as the TEST messages write it.
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
});

test('the TEST Prebid editor names the account script versions from the server, not 3.22.1 or a later version',async()=>{
 const {prebidPage,prebidScript}=await import('../../worker/test-workspace/prebid-page.mjs');
 assert.doesNotMatch(prebidPage(),/3\.22\.1|or a later version/);
 assert.match(prebidPage(),/<p class="muted" id="account-scripts">Account aliases and custom or no-upstream SChain require a script version that applies bidder accounts with your other saved options\. Saving preparation does not switch the script version\.<\/p>/);
 assert.match(prebidScript,/state\.accountScriptVersions/);
});

test('the TEST bid caching messages name the scripts the panels name, from the registry',()=>{
 // The panels and the shared Generate refusal name the versions for the site's saved options, at most two, read from
 // the registry; the TEST messages for bid caching with bidder rules name the versions the panels name for that site.
 const rules={enablePrebid:true,runtimeControls:{bidderRules:{schemaVersion:1,enabled:true,rules:[]}}};
 const plain=bidCacheScriptVersions({},[]),withRules=bidCacheScriptVersions(rules,[]);
 assert.ok(TEST_BID_CACHE_GENERATOR_MESSAGE.includes(`Select ${choiceOf(plain)} in Script setup and save;`),TEST_BID_CACHE_GENERATOR_MESSAGE);
 assert.equal(testBidCacheMessage(bidCacheGeneratorMessage({},[]),{}),TEST_BID_CACHE_GENERATOR_MESSAGE);
 assert.equal(testBidCacheMessage(bidCacheGeneratorMessage(rules,[]),rules),TEST_BID_CACHE_BIDDER_RULES_MESSAGE);
 // The TEST wording writes "3.24.0 Preview" and asks to allow Preview scripts only for a Preview version.
 for(const message of [TEST_BID_CACHE_BIDDER_RULES_MESSAGE,BIDDER_RULES_WITHOUT_BID_CACHE_MESSAGE])assert.ok(message.includes(`To use both, ${testChoice(withRules)}`),message);
 // "Script 3.23.0 has bid caching but cannot apply enabled bidder rules" fits every script that gets that message.
 assert.deepEqual(runtimeCatalog.filter(r=>r.capabilities.includes('bid-cache')&&!r.capabilities.includes('bidder-rules')).map(r=>r.version),['3.23.0']);
 assert.deepEqual(TEST_BID_CACHE_GENERATOR_MESSAGE.match(/\b\d+\.\d+\.\d+\b/g),numbers(plain),TEST_BID_CACHE_GENERATOR_MESSAGE);
 assert.deepEqual(TEST_BID_CACHE_BIDDER_RULES_MESSAGE.match(/\b\d+\.\d+\.\d+\b/g),numbers(withRules),TEST_BID_CACHE_BIDDER_RULES_MESSAGE);
 assert.deepEqual([...new Set(BIDDER_RULES_WITHOUT_BID_CACHE_MESSAGE.match(/\b\d+\.\d+\.\d+\b/g))],['3.23.0',...numbers(withRules)]);
});

test('the TEST bid caching messages are unchanged on the TEST releases and follow a new release or notice',()=>{
 // Exactly the TEST texts with the releases up to 3.24.0.
 const keep='open Bid caching, turn off Reuse valid, unused bids, remove unused overrides there, and set positions that are On to Use site setting under Bid cache by position.';
 assert.equal(TEST_BID_CACHE_GENERATOR_MESSAGE,'Bid caching needs a compatible script version. Select 3.24.0 (Preview) in Script setup and save; your bid cache settings are kept. '
  +'This version combines bid caching with bidder accounts, bidder rules and the current native activity and floor checks. To keep this script version instead, '+keep);
 assert.equal(TEST_BID_CACHE_BIDDER_RULES_MESSAGE,'This script cannot combine bid caching and bidder rules. To use both, select 3.24.0 Preview in Script setup, allow Preview scripts, and save. '
  +'To keep this script version instead, turn bid caching off: '+keep+' Your saved bidder rules are kept.');
 assert.equal(BIDDER_RULES_WITHOUT_BID_CACHE_MESSAGE,'Script 3.23.0 has bid caching but cannot apply enabled bidder rules. To use both, select 3.24.0 Preview in Script setup, allow Preview scripts, and save. '
  +'To keep 3.23.0 instead, turn off bidder rules in Bidder rules. Your saved settings are kept.');
 assert.deepEqual(testBidderRulesMessages(TEST_3240),{combined:TEST_BID_CACHE_BIDDER_RULES_MESSAGE,withoutBidCache:BIDDER_RULES_WITHOUT_BID_CACHE_MESSAGE});
 // MAIN's later releases (synthetic here): two versions; a notice on 3.24.0 moves the smallest step to 3.25.1.
 const r324=runtimeReleaseHistory.find(r=>r.version==='3.24.0');
 const later=(version,extra)=>({id:'synthetic-'+version,version,channel:'preview',codeSha256:'synthetic-'+version,capabilities:[...r324.capabilities,...extra]});
 const main=[...TEST_3240,later('3.25.0',['gam-bid-origin','gam-request-timing']),later('3.25.1',['gam-bid-origin','gam-request-timing']),later('3.26.0',['gam-bid-origin','gam-request-timing','adaptive-auction-timeout'])];
 const notice=[...runtimeNotices,{version:'3.24.0',runtimeSha256:r324.codeSha256}];
 for(const [history,notices,expected] of [[main,runtimeNotices,'3.24.0 Preview or 3.26.0 Preview'],[main,notice,'3.25.1 Preview or 3.26.0 Preview']]){
  const messages=testBidderRulesMessages(history,notices);
  for(const message of Object.values(messages))assert.ok(message.includes(`To use both, select ${expected} in Script setup, allow Preview scripts, and save.`),message);
  // The same versions as the panels for a site with bidder rules on that history.
  assert.equal(testChoice(bidCacheScriptVersions({enablePrebid:true,runtimeControls:{bidderRules:{enabled:true}}},[],history,notices)),`select ${expected} in Script setup, allow Preview scripts, and save.`);
  // The shared refusal for such a site is recognized and worded with the TEST views.
  const shared=bidCacheGeneratorMessage({},[],history,notices);
  assert.equal(testBidCacheMessage(shared,{}),shared.replace('turn bid caching off in Config → Demand → Prebid, remove unused overrides there, and set positions that are On to Use site setting under Config → Ad units → Bid cache.',keep));
 }
 // No version applies both: the messages say so instead of naming one.
 assert.ok(testBidderRulesMessages(TEST_3240,notice).combined.includes(' No available script version applies bid caching and bidder rules together. '));
 // Other messages pass unchanged.
 assert.equal(testBidCacheMessage('Something else.',{}),'Something else.');
});
