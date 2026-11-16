// TEST-only wording for bid caching. The shared generator refusal (worker/site-runtime/prebid-cache-settings.mjs)
// names the production Config menus; this workspace has a Bid caching view instead. Bidder rules (3.22.0, on the
// 3.21.0 lineage) and bid caching (3.23.0, on the 3.21.2 lineage) are in different TEST scripts, so no script version
// has both yet, and each refusal says so instead of pointing at the other script.
import {BID_CACHE_GENERATOR_MESSAGE} from '../site-runtime/prebid-cache-settings.mjs';
import {BID_CACHE_RUNTIME_VERSION} from '../../shared/bid-cache/eligibility.mjs';

const KEEP_SCRIPT='open Bid caching, turn off Reuse valid, unused bids, remove unused overrides there, and set positions that are On to Use site setting under Bid cache by position.';
export const TEST_BID_CACHE_GENERATOR_MESSAGE=BID_CACHE_GENERATOR_MESSAGE.slice(0,BID_CACHE_GENERATOR_MESSAGE.indexOf('To keep'))
 +'To keep this script version instead, '+KEEP_SCRIPT;
export const TEST_BID_CACHE_BIDDER_RULES_MESSAGE=`Bid caching needs script version ${BID_CACHE_RUNTIME_VERSION}, which has no bidder rules, and bidder rules are on for this site. No script version has both yet. `
 +`To use bid caching, turn off bidder rules in Bidder rules, then select ${BID_CACHE_RUNTIME_VERSION} in Script setup and save. `
 +'To keep bidder rules, select 3.22.0 in Script setup and turn bid caching off: '+KEEP_SCRIPT+' Your saved settings are kept.';
export const BIDDER_RULES_WITHOUT_BID_CACHE_MESSAGE=`Script ${BID_CACHE_RUNTIME_VERSION} has bid caching but no bidder rules, and bidder rules need script 3.22.0, which has no bid caching. No script version has both yet. `
 +`To use ${BID_CACHE_RUNTIME_VERSION}, turn off bidder rules in Bidder rules. To keep bidder rules, select 3.22.0 in Script setup and keep bid caching off. Your saved settings are kept.`;
const bidderRulesOn=config=>config?.enablePrebid===true&&config?.runtimeControls?.bidderRules?.enabled===true;
/** The TEST wording for the shared bid cache refusal, given the saved site configuration; other messages pass unchanged. */
export const testBidCacheMessage=(message,config)=>message!==BID_CACHE_GENERATOR_MESSAGE?message:bidderRulesOn(config)?TEST_BID_CACHE_BIDDER_RULES_MESSAGE:TEST_BID_CACHE_GENERATOR_MESSAGE;
/** A script with bid caching but without bidder rules (3.23.0) cannot apply enabled bidder rules. Checked before the
 * shared bidder rules guard, whose 'or later' wording would point at 3.23.0. Same status as that guard. */
export function requireBidderRulesBesideBidCache(config,descriptor){
 if(bidderRulesOn(config)&&descriptor?.capabilities?.includes('bid-cache')&&!descriptor.capabilities.includes('bidder-rules'))throw Object.assign(Error(BIDDER_RULES_WITHOUT_BID_CACHE_MESSAGE),{status:422});
}
