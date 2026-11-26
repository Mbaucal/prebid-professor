/** Only known configuration diagnostics may cross the HTTP boundary. Compiler,
 * database and storage failures retain the generic public message. Historical
 * input adapters throw plain Errors, so keep their allowlist here in admin code. */
const GENERIC = 'The saved settings are not supported by this built-in runtime. Resolve configuration validation first.';
// Script version guidance for bidder accounts, bidder rules and bid caching (site-runtime/script-version-guidance.mjs).
// It names one or two versions (the smallest step and the newest), never more.
const RELEASE = String.raw`\d{1,3}\.\d{1,3}\.\d{1,3}`, CHOICE = String.raw`${RELEASE}(?: \(Preview\))?`;
const ACCOUNT = '[a-z][a-z0-9_-]{0,63}', OPTION = '(?:bidder accounts|bidder rules|bid caching|adaptive timeout)';
// Two to four options, joined as the guidance joins them: "a and b", "a, b and c".
const OPTIONS = `${OPTION}(?:, ${OPTION}){0,2} and ${OPTION}`;
// No version named (noScriptVersionText in site-runtime/script-versions.mjs): either no corrected version is offered
// while a version with a runtime notice still applies the options, or no version applies them.
const NOTICED = 'Versions with a runtime notice in Script setup still apply';
const NO_VERSION = `No corrected script version is offered that applies (?:${OPTION}\\. ${NOTICED} it|${OPTIONS} together\\. ${NOTICED} them)`
  + `|No available script version applies (?:${OPTION}|${OPTIONS} together)`;
const SCRIPT_GUIDANCE = new RegExp(`^(?:Script ${RELEASE}|This script) cannot apply (?:bidder accounts \\(${ACCOUNT}(?:, ${ACCOUNT}){0,2}(?: and [1-9]\\d{0,3} more)?\\)(?: or enabled bidder rules)?|enabled bidder rules)\\. `
  + `(?:(?:To keep them with your saved ${OPTION}(?:(?:, ${OPTION}){0,2} and ${OPTION})?, select|Select) ${CHOICE}(?: or ${CHOICE})? in Script setup and save(?:, or turn off bidder rules)?`
  + `|${NO_VERSION})\\. Your saved settings and previous packages are unchanged\\.$`, 'u');
const diagnostics = [
  SCRIPT_GUIDANCE,
  /^Adaptive auction timeout (?:requires script 3\.26\.0\. Select it in Script setup and save, or turn off adaptive timeout\. Your saved rules are kept\.|must be an object\.|contains an unsupported field\.|enabled must be a boolean\.|minimum must not exceed maximum\.|\w+ must be an integer between \d+ and \d+\.)$/u,
  /^.{1,128}, mapping [1-9]\d*: (?:Enabled must be on or off|priority must be 0–10000|choose ALL or ANY conditions|invalid slot action|selected size map does not exist|choose a size map or a slot action|use 1–12 conditions|invalid key or operator|enter a condition value)\.$/u,
  /^.{1,128}: (?:use up to 100 key-value mappings|country conditions use equals, does not equal, exists or does not exist|enter a two-letter country code such as RS or DE)\.$/u,
  /^.{1,128} (?:needs a saved size map|has no enabled sizes)\.$/u,
  /^Invalid unit rule .{1,128}\.$/u,
  /^.{1,128}: key-value (?:rules currently support in-page Banner and Sticky positions\. Keep TakeOver on its saved responsive map|map rules currently support Banner\. Keep Outstream on its reviewed video size maps)\.$/u,
  /^.{1,128}: conditional rules on this (?:TakeOver|Outstream) position are not supported\. Keep its saved responsive map; use Banner or Sticky rules, or the separate Interstitial fallback rule\.$/u,
  /^Interstitial fallback (?:supports conditional slot actions only|uses Google responsive sizes\. Choose a slot action without a size map)\.$/u,
  /^Country and Interstitial fallback rules require script 3\.19\.0\. Select 3\.19\.0 in Script setup and save\. Your saved rules are kept\.$/u,
  /^Contextual signals require script 3\.21\.0\. Select it in Script setup and save, or turn off contextual signals\. Your mappings are kept\.$/u,
  /^Conditional mapping in .{1,128} requires the release overlay; this preview will not silently discard it\.$/u,
  /^Unit rule .{1,128}\.timeout must be an integer between 100 and 30000\. Review the saved rule before generating\.$/u,
  /^ID5 params\.partner must be a positive integer\. Open User ID modules and save the corrected Partner Number before generating\.$/u,
  /^SChain node [1-9]\d*\.(?:sid|rid|name) contains a replacement token unsupported by this script version\. Use a literal-safe script version or correct the value before generating\.$/u,
  /^.{1,200} contains a Unicode line separator(?: \(U\+2028\/U\+2029\)| in a field name)\. Replace it with a normal space before generating\.$/u,
  /^Script [\w.-]+ cannot use these viewport-height conditions: .+\. Browser viewport height is not reserved ad height\. Reserved CSS height is derived from Sizes\. For Banner or Sticky, select script 3\.20\.0 or later with viewport-height support\. If a height condition was unintended, explicitly set it to 0 in Size maps\. Responsive Outstream still requires width-only maps\. Your saved values are kept\.$/u,
];
export function configurationErrorMessage(error) {
  const message = error instanceof Error ? error.message : '';
  if (message.length > 4000 || /[\r\n\u0000-\u001f\u007f]/u.test(message)) return GENERIC;
  return diagnostics.some(pattern => pattern.test(message)) ? message : GENERIC;
}
/** Whether the error is one of the known configuration diagnostics, shown as is, rather than the generic message. */
export function knownConfigurationError(error) {
  return configurationErrorMessage(error) !== GENERIC;
}
