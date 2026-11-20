/** Admin wording for saved options that the selected script cannot apply: bidder accounts, bidder rules and bid
 * caching. It names at most two script versions that apply every saved option at once (scriptVersionsWith), read
 * from the registered release capabilities and runtime notices, so a new release or notice changes the text without
 * an edit here and the text never grows with the number of releases. Only the wording is decided here: which settings
 * a script accepts stays with the existing guards, and generated packages are unchanged. */
import {scriptVersionsWith,scriptVersionLabels,scriptVersionText,versionList as list,accountsNeeding,rulesNeeded,timeoutNeeded,neededCapabilities,CAPABILITY_NAMES as NAMES} from './script-versions.mjs';
import {bidCacheActive} from './prebid-cache-settings.mjs';

// The naming rule lives in script-versions.mjs, which the bid caching wording shares; these names stay exported here.
export {scriptVersionsWith,scriptVersionLabels,scriptVersionText,neededCapabilities};
const named=codes=>codes.length>3?`${codes.slice(0,3).join(', ')} and ${codes.length-3} more`:codes.join(', ');

/** The saved options that only some scripts apply, by the same tests as their guards: active bidder accounts with an
 * alias or their own SChain (requireBidderAccounts), enabled bidder rules (requireBidderRulesRuntime), bid caching
 * that would reuse bids (requireSupportedCacheGenerator) and an enabled adaptive auction timeout
 * (requireAdaptiveTimeoutRuntime). */
export function savedScriptNeeds(snapshot){
  const config=JSON.parse(snapshot.config.config_json);
  return {accounts:accountsNeeding(config,snapshot),...configNeeds(config)};
}
function configNeeds(config){
  // Invalid saved cache settings are refused at Generate with their own reason.
  let cache=false;try{cache=bidCacheActive(config);}catch{}
  return {rules:rulesNeeded(config),cache,timeout:timeoutNeeded(config)};
}
/** The versions a panel names for its own option (bidder rules, or a bidder account not saved yet), together with
 * the site's other saved options. Unreadable saved settings are left to the guards that refuse them. The bid caching
 * panels and Generate use bidCacheScriptVersions (prebid-cache-settings.mjs), which counts the same options. */
export function savedScriptVersionLabels(capability,snapshot){
  let needs;
  try{needs=savedScriptNeeds(snapshot);}
  catch{let config=null;try{config=JSON.parse(snapshot.config.config_json);}catch{}needs={accounts:[],...configNeeds(config)};}
  return scriptVersionLabels([...new Set([capability,...neededCapabilities(needs)])]);
}

/** The refusal for a script that lacks bidder accounts or bidder rules the site has saved, or null. Bid caching only
 * narrows the versions named here; a script without it is refused by the Generate cache check. */
export function scriptGuidance(needs,descriptor,history){
  const has=capability=>descriptor?.capabilities?.includes(capability)===true;
  const accountsLacking=needs.accounts.length>0&&!has('bidder-accounts'),rulesLacking=needs.rules&&!has('bidder-rules');
  const lacking=[...(accountsLacking?[`bidder accounts (${named(needs.accounts)})`]:[]),...(rulesLacking?['enabled bidder rules']:[])];
  if(!lacking.length)return null;
  // The other saved options the named versions must also apply: those this script has, and bid caching and adaptive
  // timeout, which their own checks refuse separately.
  const separate=['bid-cache','adaptive-auction-timeout'];
  const needed=neededCapabilities(needs),kept=needed.filter(capability=>separate.includes(capability)||has(capability)).map(capability=>NAMES[capability]);
  const version=/^(\d+\.\d+\.\d+)(?:-(?:tessera|revenue)\.preview\.\d+)?$/.exec(descriptor?.version??'')?.[1];
  const versions=scriptVersionText(needed,history);
  // Turning bidder rules off is offered only when that alone lets this script apply the other saved options.
  const offSwitch=!accountsLacking&&(!needs.cache||has('bid-cache'))&&(!needs.timeout||has('adaptive-auction-timeout'));
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
