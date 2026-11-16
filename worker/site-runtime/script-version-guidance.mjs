/** Admin wording for saved options that the selected script cannot apply: bidder accounts, bidder rules and bid
 * caching. It names the script versions that apply every saved option at once, read from the registered release
 * capabilities, so a new release changes the text without an edit here. Only the wording is decided here: which
 * settings a script accepts stays with the existing guards, and generated packages are unchanged. */
import {runtimeReleaseHistory} from '../runtime/runtime-release-history.mjs';
import {runtimeNotices} from '../../shared/runtime-notices.mjs';
import {savedBidderAccounts} from '../../shared/bidder-accounts/snapshot.mjs';
import {bidCacheActive} from './prebid-cache-settings.mjs';

const RELEASE=/^(\d+)\.(\d+)\.(\d+)$/;
const parts=version=>RELEASE.exec(version)?.slice(1).map(Number);
const byVersion=(a,b)=>{const x=parts(a.version),y=parts(b.version);return x[0]-y[0]||x[1]-y[1]||x[2]-y[2];};
const covers=(release,capabilities)=>capabilities.every(capability=>release.capabilities.includes(capability));
const noticed=release=>runtimeNotices.some(notice=>notice.version===release.version&&notice.runtimeSha256===release.codeSha256);
const label=release=>release.version+(release.channel==='preview'?' (Preview)':'');
const list=(items,word)=>items.length<2?items[0]??'':`${items.slice(0,-1).join(', ')} ${word} ${items.at(-1)}`;
const named=codes=>codes.length>3?`${codes.slice(0,3).join(', ')} and ${codes.length-3} more`:codes.join(', ');

/** Releases offered in Script setup that have every listed capability, oldest first. A release with a runtime
 * notice (shared/runtime-notices.mjs) is left out, and so is a release that a newer patch of the same minor line,
 * with all of its capabilities, supersedes (3.22.2 for 3.22.1). */
export function scriptVersionsWith(capabilities,history=runtimeReleaseHistory){
  const offered=history.filter(release=>parts(release.version)&&covers(release,capabilities)&&!noticed(release));
  return offered.filter(release=>{
    const [major,minor,patch]=parts(release.version);
    return !offered.some(other=>{const [m,n,p]=parts(other.version);return m===major&&n===minor&&p>patch&&covers(other,release.capabilities);});
  }).sort(byVersion);
}
/** "3.22.2 (Preview) or 3.24.0 (Preview)"; empty when no release has every capability. */
export const scriptVersionText=(capabilities,history)=>list(scriptVersionsWith(capabilities,history).map(label),'or');

/** The saved options that only some scripts apply, by the same tests as their guards: active bidder accounts with an
 * alias or their own SChain (requireBidderAccounts), enabled bidder rules (requireBidderRulesRuntime) and bid caching
 * that would reuse bids (requireSupportedCacheGenerator). */
export function savedScriptNeeds(snapshot){
  const config=JSON.parse(snapshot.config.config_json);
  const accounts=config.enablePrebid===true?savedBidderAccounts(snapshot,{activeOnly:true}).filter(account=>account.bidder!==account.baseAdapter||account.schain.mode!=='inherit').map(account=>account.bidder):[];
  return {accounts,...configNeeds(config)};
}
function configNeeds(config){
  // Invalid saved cache settings are refused at Generate with their own reason.
  let cache=false;try{cache=bidCacheActive(config);}catch{}
  return {rules:config?.enablePrebid===true&&config?.runtimeControls?.bidderRules?.enabled===true,cache};
}
export const neededCapabilities=needs=>[...(needs.accounts.length?['bidder-accounts']:[]),...(needs.rules?['bidder-rules']:[]),...(needs.cache?['bid-cache']:[])];
const NAMES={'bidder-accounts':'bidder accounts','bidder-rules':'bidder rules','bid-cache':'bid caching'};

/** The refusal for a script that lacks bidder accounts or bidder rules the site has saved, or null. Bid caching only
 * narrows the versions named here; a script without it is refused by the Generate cache check. */
export function scriptGuidance(needs,descriptor,history){
  const has=capability=>descriptor?.capabilities?.includes(capability)===true;
  const accountsLacking=needs.accounts.length>0&&!has('bidder-accounts'),rulesLacking=needs.rules&&!has('bidder-rules');
  const lacking=[...(accountsLacking?[`bidder accounts (${named(needs.accounts)})`]:[]),...(rulesLacking?['enabled bidder rules']:[])];
  if(!lacking.length)return null;
  // The other saved options the named versions must also apply: those this script has, and bid caching.
  const needed=neededCapabilities(needs),kept=needed.filter(capability=>capability==='bid-cache'||has(capability)).map(capability=>NAMES[capability]);
  const version=/^(\d+\.\d+\.\d+)(?:-(?:tessera|revenue)\.preview\.\d+)?$/.exec(descriptor?.version??'')?.[1];
  const versions=scriptVersionText(needed,history);
  const choice=!versions?`No available script version applies ${list(needed.map(capability=>NAMES[capability]),'and')} together`
    :`${kept.length?`To keep them with your saved ${list(kept,'and')}, select`:'Select'} ${versions} in Script setup and save${accountsLacking?'':', or turn off bidder rules'}`;
  return `${version?`Script ${version}`:'This script'} cannot apply ${list(lacking,'or')}. ${choice}. Your saved settings and previous packages are unchanged.`;
}
/** Checked before the shared guards, whose wording names one fixed version or says "or later". Same status as the
 * bidder rules guard. */
export function requireSavedOptionsRuntime(snapshot,descriptor){
  const message=scriptGuidance(savedScriptNeeds(snapshot),descriptor);
  if(message)throw Object.assign(Error(message),{status:422});
}
/** The older generation routes read the saved configuration only; they never apply bidder accounts. */
export function requireBidderRulesScript(config,descriptor){
  const message=scriptGuidance({accounts:[],...configNeeds(config)},descriptor);
  if(message)throw Object.assign(Error(message),{status:422});
}
