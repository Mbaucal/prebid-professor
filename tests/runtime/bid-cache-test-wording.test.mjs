// TEST wording around bid caching: it works for every site, so no TEST page ties it to the Tanjug copy, the home
// page links the TEST site's own Bid caching view, and bidder rules name the versions the server derives, never a
// fixed version or "or later" (3.23.0 is later but has no bidder rules).
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {workspacePage} from '../../worker/test-workspace/page.mjs';
import {TEST_BID_CACHE_GENERATOR_MESSAGE,TEST_BID_CACHE_BIDDER_RULES_MESSAGE,BIDDER_RULES_WITHOUT_BID_CACHE_MESSAGE} from '../../worker/test-workspace/bid-cache-messages.mjs';
import {scriptVersionLabels} from '../../worker/site-runtime/script-version-guidance.mjs';
import {runtimeCatalog} from '../../worker/test-workspace/runtime-catalog.mjs';
const source=path=>readFile(new URL('../../'+path,import.meta.url),'utf8');

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

test('the TEST bid caching messages name the script the panels name, from the registry',()=>{
 // The panels name the newest script with bid caching (and the site's other saved options); these messages are fixed
 // text that says that script also applies bidder accounts and bidder rules. A new release fails here until they follow.
 const named=scriptVersionLabels(['bid-cache']).at(-1),version=named.replace(' (Preview)','');
 assert.equal(scriptVersionLabels(['bid-cache','bidder-accounts','bidder-rules']).at(-1),named);
 assert.ok(TEST_BID_CACHE_GENERATOR_MESSAGE.includes(`Select ${named} in Script setup and save;`),TEST_BID_CACHE_GENERATOR_MESSAGE);
 // The TEST wording writes "3.24.0 Preview" and asks to allow Preview scripts only for a Preview version.
 const preview=named.endsWith(' (Preview)'),choice=`select ${version}${preview?' Preview':''} in Script setup, ${preview?'allow Preview scripts, ':''}and save.`;
 for(const message of [TEST_BID_CACHE_BIDDER_RULES_MESSAGE,BIDDER_RULES_WITHOUT_BID_CACHE_MESSAGE])assert.ok(message.includes(`To use both, ${choice}`),message);
 // "Script 3.23.0 has bid caching but cannot apply enabled bidder rules" fits every script that gets that message.
 assert.deepEqual(runtimeCatalog.filter(r=>r.capabilities.includes('bid-cache')&&!r.capabilities.includes('bidder-rules')).map(r=>r.version),['3.23.0']);
 for(const message of [TEST_BID_CACHE_GENERATOR_MESSAGE,TEST_BID_CACHE_BIDDER_RULES_MESSAGE])assert.deepEqual(message.match(/\b\d+\.\d+\.\d+\b/g),[version],message);
 assert.deepEqual([...new Set(BIDDER_RULES_WITHOUT_BID_CACHE_MESSAGE.match(/\b\d+\.\d+\.\d+\b/g))],['3.23.0',version]);
});
