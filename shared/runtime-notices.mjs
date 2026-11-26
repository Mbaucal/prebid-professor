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
  // The newest patch of the 3.22 line: 3.22.2 keeps everything 3.22.1 has.
  alternative: Object.freeze({ version: '3.22.2', offers: 'bidder rules with these fixes' }),
}),Object.freeze({
  version: '3.23.0',
  runtimeSha256: 'c2b9e027f2bd263c17b3f0d81b701120b29bde23efeaa3efd81ad2163f47c224',
  optionSuffix: ' · Earlier bid cache',
  warning: '3.23.0 adds bid caching on the 3.21.2 base. It does not include bidder accounts or bidder rules, the lazy initial-auction correction, or the newer checks that prevent cached bids from bypassing a bidder activity restriction or a raised price floor. A corrected compatible bid-cache version is not available in this TEST workspace.',
  excludeFromRecommendation: true,
}),Object.freeze({
  version: '3.24.0',
  runtimeSha256: '6a897977487d60d69165fd574a468db5cf3a7269b87868ae3dd794b66ea0bc48',
  optionSuffix: ' · Cache limit',
  warning: '3.24.0 can stop reusing cached bids during a long page session. A corrected compatible bid-cache version is not available in this TEST workspace. This version remains selectable; saved settings and packages are unchanged.',
  excludeFromRecommendation: true,
})]);

/** Recommendation is operator metadata, separate from immutable release channels. */
export function recommendedRuntimeRelease(history) {
  return history.find(release => release.channel === 'stable' && !runtimeNotices.some(notice =>
    notice.excludeFromRecommendation === true && notice.version === release.version && notice.runtimeSha256 === release.codeSha256));
}
