// Operator notices for exact registered releases, shared by the admin Script
// setup (src/site-workspace/runtime-notices.ts) and the TEST workspace Script
// version page (worker/test-workspace/runtime-selection-page.mjs). Display
// only: a noticed version stays selectable and savable, and release records,
// saved pins and generated packages are unchanged. Match by version and
// source checksum so a notice never moves to another build.
export const runtimeNotices = Object.freeze([Object.freeze({
  version: '3.22.0',
  runtimeSha256: '1aa3c8ad0dcc1c94fddf6d50b0a7b3073a524dee4750563277fd5c6d22525268',
  // Keep it short: the narrowest select is Script setup inside Releases at
  // 390 px, with 244 px of text room. "3.22.0 · No 3.21.1+ fixes" measures
  // 223 px at 600 16px in DejaVu Sans, which the admin font stack falls back
  // to on Linux without Inter (stock Ubuntu and the CI runner), and 184 px in
  // Inter.
  optionSuffix: ' · No 3.21.1+ fixes',
  warning: '3.22.0 adds bidder rules but is built on 3.21.0. It does not have the 3.21.1 and 3.21.2 fixes for page and category size maps when no key-value mapping sets a size map, contextual signals with existing Prebid RTD providers, and the TakeOver frequency cap and debug storage before CMP consent.',
  alternative: Object.freeze({ version: '3.22.1', offers: 'bidder rules with these fixes' }),
})]);
