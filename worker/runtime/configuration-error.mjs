/** Only known configuration diagnostics may cross the HTTP boundary. Compiler,
 * database and storage failures retain the generic public message. Historical
 * input adapters throw plain Errors, so keep their allowlist here in admin code. */
const GENERIC = 'The saved settings are not supported by this built-in runtime. Resolve configuration validation first.';
const diagnostics = [
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
