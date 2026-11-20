/** Admin wording for saved options that the selected script cannot apply: bidder accounts, bidder rules and bid
 * caching. It names at most two script versions that apply every saved option at once (scriptVersionsWith), read
 * from the registered release capabilities and runtime notices, so a new release or notice changes the text without
 * an edit here and the text never grows with the number of releases. Only the wording is decided here: which settings
 * a script accepts stays with the existing guards, and generated packages are unchanged. */
import {runtimeReleaseHistory} from '../runtime/runtime-release-history.mjs';
import {runtimeNotices} from '../../shared/runtime-notices.mjs';
import {savedBidderAccounts} from '../../shared/bidder-accounts/snapshot.mjs';
import {bidCacheActive} from './prebid-cache-settings.mjs';

const RELEASE=/^(\d+)\.(\d+)\.(\d+)$/;
const parts=version=>RELEASE.exec(version)?.slice(1).map(Number);
const byVersion=(a,b)=>{const x=parts(a.version),y=parts(b.version);return x[0]-y[0]||x[1]-y[1]||x[2]-y[2];};
const covers=(release,capabilities)=>capabilities.every(capability=>release.capabilities.includes(capability));
const noticed=(release,notices)=>notices.some(notice=>notice.version===release.version&&notice.runtimeSha256===release.codeSha256);
const label=release=>release.version+(release.channel==='preview'?' (Preview)':'');
const list=(items,word)=>items.length<2?items[0]??'':`${items.slice(0,-1).join(', ')} ${word} ${items.at(-1)}`;
const named=codes=>codes.length>3?`${codes.slice(0,3).join(', ')} and ${codes.length-3} more`:codes.join(', ');

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
export const scriptVersionLabels=(capabilities,history,notices)=>scriptVersionsWith(capabilities,history,notices).map(label);
/** "3.22.2 (Preview) or 3.26.0 (Preview)", or one version; empty when no offered release has every capability. */
export const scriptVersionText=(capabilities,history,notices)=>list(scriptVersionLabels(capabilities,history,notices),'or');

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
/** The versions a panel names for its own option (bidder rules, or a bidder account not saved yet), together with
 * the site's other saved options. Unreadable saved settings are left to the guards that refuse them. */
export function savedScriptVersionLabels(capability,snapshot){
  let needs;
  try{needs=savedScriptNeeds(snapshot);}
  catch{let config=null;try{config=JSON.parse(snapshot.config.config_json);}catch{}needs={accounts:[],...configNeeds(config)};}
  return scriptVersionLabels([...new Set([capability,...neededCapabilities(needs)])]);
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
  // Turning bidder rules off is offered only when that alone lets this script apply the other saved options.
  const offSwitch=!accountsLacking&&(!needs.cache||has('bid-cache'));
  const choice=!versions?`No available script version applies ${list(needed.map(capability=>NAMES[capability]),'and')} together`
    :`${kept.length?`To keep them with your saved ${list(kept,'and')}, select`:'Select'} ${versions} in Script setup and save${offSwitch?', or turn off bidder rules':''}`;
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
