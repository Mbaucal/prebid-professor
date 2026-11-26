/** Which script versions the admin names for saved options that only some scripts apply: bidder accounts, bidder
 * rules and bid caching. Read from the registered release capabilities and runtime notices, so a new release or
 * notice changes the names without an edit here. Shared by the guidance (script-version-guidance.mjs) and the bid
 * caching wording (prebid-cache-settings.mjs); it imports neither, so neither import forms a cycle. Wording only:
 * which settings a script accepts stays with the existing guards. */
import {runtimeReleaseHistory} from '../runtime/runtime-release-history.mjs';
import {runtimeNotices} from '../../shared/runtime-notices.mjs';
import {savedBidderAccounts} from '../../shared/bidder-accounts/snapshot.mjs';

const RELEASE=/^(\d+)\.(\d+)\.(\d+)$/;
const parts=version=>RELEASE.exec(version)?.slice(1).map(Number);
const byVersion=(a,b)=>{const x=parts(a.version),y=parts(b.version);return x[0]-y[0]||x[1]-y[1]||x[2]-y[2];};
const covers=(release,capabilities)=>capabilities.every(capability=>release.capabilities.includes(capability));
const noticed=(release,notices)=>notices.some(notice=>notice.version===release.version&&notice.runtimeSha256===release.codeSha256);
/** "3.24.0 (Preview)" for a preview release, "3.21.2" for a stable one. */
export const releaseLabel=release=>release.version+(release.channel==='preview'?' (Preview)':'');
/** "a", "a or b", "a, b or c" (word "or"), or with "and". */
export const versionList=(items,word)=>items.length<2?items[0]??'':`${items.slice(0,-1).join(', ')} ${word} ${items.at(-1)}`;

/** The releases named for a set of capabilities, oldest first, at most two. Offered releases are the numeric
 * registry releases with every listed capability and no runtime notice (shared/runtime-notices.mjs). Of these, the
 * smallest step is the release with the fewest capabilities, the newest of those on a tie (3.22.2 rather than 3.22.1),
 * and the other is the newest offered release. When both are the same release it is named once; when no release is
 * offered the list is empty. A notice added later to the smallest step moves it to the next one. */
export function scriptVersionsWith(capabilities,history=runtimeReleaseHistory,notices=runtimeNotices){
  const offered=history.filter(release=>parts(release.version)&&covers(release,capabilities)&&!noticed(release,notices)).sort(byVersion);
  if(!offered.length)return [];
  const size=release=>new Set(release.capabilities).size,fewest=Math.min(...offered.map(size));
  const smallest=offered.filter(release=>size(release)===fewest).at(-1),newest=offered.at(-1);
  return smallest===newest?[newest]:[smallest,newest];
}
/** ['3.22.2 (Preview)', '3.26.0 (Preview)'] for the panels, which join them like scriptVersionText. */
export const scriptVersionLabels=(capabilities,history,notices)=>scriptVersionsWith(capabilities,history,notices).map(releaseLabel);
/** "3.22.2 (Preview) or 3.26.0 (Preview)", or one version; empty when no offered release has every capability. */
export const scriptVersionText=(capabilities,history,notices)=>versionList(scriptVersionLabels(capabilities,history,notices),'or');
/** Whether a numeric registry release with a runtime notice has every listed capability. scriptVersionsWith never
 * names such a release, but it stays selectable in Script setup, so a text for an empty list must not say that no
 * version applies these capabilities. */
export function noticedScriptVersionApplies(capabilities,history=runtimeReleaseHistory,notices=runtimeNotices){
  return history.some(release=>parts(release.version)&&covers(release,capabilities)&&noticed(release,notices));
}
/** The sentences for capabilities that no named version applies (scriptVersionsWith is empty), without naming any
 * version. When a release with a runtime notice applies them, no corrected version is offered; otherwise none applies
 * them. "together" only for two or more. */
export function noScriptVersionText(capabilities,history,notices){
  const names=capabilities.map(capability=>CAPABILITY_NAMES[capability]),many=names.length>1;
  const applies=`applies ${versionList(names,'and')}${many?' together':''}`;
  return noticedScriptVersionApplies(capabilities,history,notices)
    ?`No corrected script version is offered that ${applies}. Versions with a runtime notice in Script setup still apply ${many?'them':'it'}.`
    :`No available script version ${applies}.`;
}
/** Whether the registry release a saved pin names (its id, version and source checksum) has every listed capability.
 * False without a pin or without such a release. Wording only: the guards still decide what the script accepts. */
export function pinnedReleaseApplies(pin,capabilities,history=runtimeReleaseHistory){
  const release=history.find(release=>release.id===pin?.runtimeId&&release.version===pin?.runtimeVersion&&release.codeSha256===pin?.runtimeSha256);
  return !!release&&covers(release,capabilities);
}

/** Active bidder accounts with an alias or their own SChain (requireBidderAccounts), by account code; none while
 * Prebid is off. Reads the bidder rows of a saved snapshot. */
export const accountsNeeding=(config,snapshot)=>config.enablePrebid===true
  ?savedBidderAccounts(snapshot,{activeOnly:true}).filter(account=>account.bidder!==account.baseAdapter||account.schain.mode!=='inherit').map(account=>account.bidder):[];
/** Enabled bidder rules (requireBidderRulesRuntime); none while Prebid is off. */
export const rulesNeeded=config=>config?.enablePrebid===true&&config?.runtimeControls?.bidderRules?.enabled===true;
/** An enabled adaptive auction timeout (requireAdaptiveTimeoutRuntime), so the names never send a site to a script
 * that would then refuse it. Read from the saved setting directly: a line without that setting never has it on. */
export const timeoutNeeded=config=>config?.adaptiveAuctionTimeout?.enabled===true;
/** The capabilities a script needs for saved {accounts, rules, cache, timeout}. */
export const neededCapabilities=needs=>[...(needs.accounts.length?['bidder-accounts']:[]),...(needs.rules?['bidder-rules']:[]),...(needs.cache?['bid-cache']:[]),...(needs.timeout?['adaptive-auction-timeout']:[])];
export const CAPABILITY_NAMES=Object.freeze({'bidder-accounts':'bidder accounts','bidder-rules':'bidder rules','bid-cache':'bid caching','adaptive-auction-timeout':'adaptive timeout'});
