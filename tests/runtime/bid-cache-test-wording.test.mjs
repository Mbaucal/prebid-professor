// TEST wording around bid caching: it works for every site, so no TEST page ties it to the Tanjug copy, the home
// page links the TEST site's own Bid caching view, and bidder rules name 3.22.0 only (3.23.0 is later but has none).
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

test('bidder rules copy names script 3.22.0, not 3.22.0 or later',async()=>{
 const panel=await source('src/components/BidderRulesPanel.tsx');
 assert.doesNotMatch(panel,/3\.22\.0 or later/);
 assert.match(panel,/Generate a new script with version 3\.22\.0 to apply these rules\./);
 assert.match(panel,/Select and save script version 3\.22\.0 before generating a package that uses them\./);
});
