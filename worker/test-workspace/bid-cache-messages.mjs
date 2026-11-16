// TEST-only wording names this workspace's existing views and the combined Preview script.
import {BID_CACHE_GENERATOR_MESSAGE} from '../site-runtime/prebid-cache-settings.mjs';

const KEEP_SCRIPT='open Bid caching, turn off Reuse valid, unused bids, remove unused overrides there, and set positions that are On to Use site setting under Bid cache by position.';
export const TEST_BID_CACHE_GENERATOR_MESSAGE=BID_CACHE_GENERATOR_MESSAGE.slice(0,BID_CACHE_GENERATOR_MESSAGE.indexOf('To keep'))
 +'To keep this script version instead, '+KEEP_SCRIPT;
export const TEST_BID_CACHE_BIDDER_RULES_MESSAGE='This script cannot combine bid caching and bidder rules. To use both, select 3.24.0 Preview in Script setup, allow Preview scripts, and save. '
 +'To keep this script version instead, turn bid caching off: '+KEEP_SCRIPT+' Your saved bidder rules are kept.';
export const BIDDER_RULES_WITHOUT_BID_CACHE_MESSAGE='Script 3.23.0 has bid caching but cannot apply enabled bidder rules. To use both, select 3.24.0 Preview in Script setup, allow Preview scripts, and save. '
 +'To keep 3.23.0 instead, turn off bidder rules in Bidder rules. Your saved settings are kept.';
const bidderRulesOn=config=>config?.enablePrebid===true&&config?.runtimeControls?.bidderRules?.enabled===true;
/** The TEST wording for the shared bid cache refusal, given the saved site configuration; other messages pass unchanged. */
export const testBidCacheMessage=(message,config)=>message!==BID_CACHE_GENERATOR_MESSAGE?message:bidderRulesOn(config)?TEST_BID_CACHE_BIDDER_RULES_MESSAGE:TEST_BID_CACHE_GENERATOR_MESSAGE;
/** A script with bid caching but without bidder rules (3.23.0) cannot apply enabled bidder rules. Checked before the
 * shared bidder rules guard, whose 'or later' wording would point at 3.23.0. Same status as that guard. */
export function requireBidderRulesBesideBidCache(config,descriptor){
 if(bidderRulesOn(config)&&descriptor?.capabilities?.includes('bid-cache')&&!descriptor.capabilities.includes('bidder-rules'))throw Object.assign(Error(BIDDER_RULES_WITHOUT_BID_CACHE_MESSAGE),{status:422});
}
