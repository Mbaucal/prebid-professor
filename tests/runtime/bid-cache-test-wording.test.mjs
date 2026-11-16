// TEST wording around bid caching: it works for every site, so no TEST page ties it to the Tanjug copy, the home
// page links the TEST site's own Bid caching view, and bidder rules name the versions the server derives, never a
// fixed version or "or later" (3.23.0 is later but has no bidder rules).
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {workspacePage} from '../../worker/test-workspace/page.mjs';
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
