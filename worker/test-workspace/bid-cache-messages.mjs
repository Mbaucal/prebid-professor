// TEST-only wording names this workspace's existing views and the Preview scripts to allow. The versions come from the
// release registry by the shared naming rule (site-runtime/script-versions.mjs), as the panels and the shared Generate
// refusal name them, so a new release or runtime notice changes them together. With the TEST releases (up to 3.24.0)
// no corrected bid-cache version is currently offered: both registered cache releases carry a notice.
import {BID_CACHE_GENERATOR_MESSAGE,bidCacheActive} from '../site-runtime/prebid-cache-settings.mjs';
import {scriptVersionsWith,versionList} from '../site-runtime/script-versions.mjs';

const KEEP_SCRIPT='open Bid caching, turn off Reuse valid, unused bids, remove unused overrides there, and set positions that are On to Use site setting under Bid cache by position.';
// How the shared refusal ends: the way back to this script names Config pages, which TEST words with its own views.
const KEEP_PREFIXES=['To keep this script version instead, ','To use this script version, '];
const keepPrefix=KEEP_PREFIXES.find(prefix=>BID_CACHE_GENERATOR_MESSAGE.includes(prefix));
const SHARED_KEEP=keepPrefix?BID_CACHE_GENERATOR_MESSAGE.slice(BID_CACHE_GENERATOR_MESSAGE.lastIndexOf(keepPrefix)+keepPrefix.length):null;
/** The shared bid caching refusal (bidCacheGeneratorMessage in site-runtime/prebid-cache-settings.mjs), whichever
 * versions it names for the site's saved options. */
export const isBidCacheRefusal=message=>typeof message==='string'&&message.startsWith('Bid caching needs a compatible script version')&&typeof SHARED_KEEP==='string'&&SHARED_KEEP.length>0&&message.endsWith(SHARED_KEEP);
const testGeneratorMessage=message=>isBidCacheRefusal(message)?message.slice(0,message.length-SHARED_KEEP.length)+KEEP_SCRIPT:message;
export const TEST_BID_CACHE_GENERATOR_MESSAGE=testGeneratorMessage(BID_CACHE_GENERATOR_MESSAGE);
/** The TEST messages for enabled bidder rules beside bid caching, naming the versions that apply both (at most two, by
 * the shared rule). The history and notices are arguments only so tests can show the text follows the registry. */
export function testBidderRulesMessages(history,notices){
 const releases=scriptVersionsWith(['bid-cache','bidder-rules'],history,notices),preview=releases.some(release=>release.channel==='preview');
 const both=releases.length
  ?`To use both, select ${versionList(releases.map(release=>release.version+(release.channel==='preview'?' Preview':'')),'or')} in Script setup, ${preview?'allow Preview scripts, ':''}and save.`
  :'No available script version applies bid caching and bidder rules together.';
 return {combined:`This script cannot combine bid caching and bidder rules. ${both} To keep this script version instead, turn bid caching off: ${KEEP_SCRIPT} Your saved bidder rules are kept.`,
  withoutBidCache:`Script 3.23.0 has bid caching but cannot apply enabled bidder rules. ${both} To keep 3.23.0 instead, turn off bidder rules in Bidder rules. Your saved settings are kept.`};
}
const RULES=testBidderRulesMessages();
export const TEST_BID_CACHE_BIDDER_RULES_MESSAGE=RULES.combined;
export const BIDDER_RULES_WITHOUT_BID_CACHE_MESSAGE=RULES.withoutBidCache;
const bidderRulesOn=config=>config?.enablePrebid===true&&config?.runtimeControls?.bidderRules?.enabled===true;
/** The TEST wording for the shared bid cache refusal, given the saved site configuration; other messages pass unchanged. */
export const testBidCacheMessage=(message,config)=>!isBidCacheRefusal(message)?message:bidderRulesOn(config)?TEST_BID_CACHE_BIDDER_RULES_MESSAGE:testGeneratorMessage(message);
/** A script with bid caching but without bidder rules (3.23.0) cannot apply enabled bidder rules beside saved bid
 * caching. Checked before the shared bidder rules guard, whose 'or later' wording would point at 3.23.0. Without saved
 * bid caching the shared guidance (requireSavedOptionsRuntime) names the versions that apply bidder rules, as the
 * Bidder rules panel does. Same status as that guard. Unreadable cache settings are refused at Generate. */
export function requireBidderRulesBesideBidCache(config,descriptor){
 let cache=false;try{cache=bidCacheActive(config);}catch{}
 if(bidderRulesOn(config)&&cache&&descriptor?.capabilities?.includes('bid-cache')&&!descriptor.capabilities.includes('bidder-rules'))throw Object.assign(Error(BIDDER_RULES_WITHOUT_BID_CACHE_MESSAGE),{status:422});
}
