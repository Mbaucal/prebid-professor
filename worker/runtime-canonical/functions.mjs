/** Executable Worker functions whose source text is embedded in generated code.
 *
 * Compilers write these functions into ads.js (or another served script) with
 * Function#toString or a template, and the generated code calls them by their
 * source names. A Worker bundler may rename a declaration or its locals
 * (esbuild: tesseraOverlayDevice2, key4; Rolldown: tesseraOverlayAllowed$1), so
 * the bundled function's own text is not the reviewed source.
 *
 * scripts/prepare-browser-canonical.mjs slices every listed declaration from
 * its source file into .generated/browser-canonical-source.mjs and checks the
 * slice against unbundled Function#toString. The installers give each listed
 * function an own toString that returns that text. Keys are repository paths;
 * every name must be an exported function declaration of that module.
 * tests/runtime/canonical-browser-text.test.mjs fails when a serialized
 * function is missing here.
 */

/** Installed by ./install.mjs, which every Worker entry imports. */
export const runtimeFunctions = {
  'worker/runtime-next/browser-functions.mjs': ['tesseraOverlayDevice', 'tesseraOverlayAllowed', 'tesseraRecordOverlayView',
    'tesseraStopOverlayAuction', 'tesseraRequestOverlay', 'tesseraConfirmOverlayRender', 'tesseraLazyRule', 'tesseraWireConfiguredLazy'],
  'worker/runtime-3211/browser-storage.mjs': ['createConsentStorage', 'resolveTakeOverCap', 'init', 'initTakeOver',
    'tesseraOverlayAllowed', 'tesseraRecordOverlayView'],
  'shared/geo-country.mjs': ['normalizeCountry', 'createCountrySignal'],
};

/** Installed by ./install-app.mjs for the production Worker (wrangler.jsonc) only:
 * named-script experiments that worker/site-runtime/script-library.mjs saves.
 * They import node:assert, which the TEST workspace Worker does not provide. */
export const appFunctions = {
  'worker/experiments/static-aa-v1.mjs': ['bootStaticAA'],
  'worker/experiments/cmp-aa-v1.mjs': ['waitForCmpEntry'],
  'worker/experiments/configurable-cache-v1.mjs': ['configuredCacheLoader'],
  'worker/runtime-cache/full-lifecycle-v1.mjs': ['createFullCacheLifecycle'],
  'worker/runtime-cache/full-policy-v1.mjs': ['createFullBidCachePolicy'],
  'worker/runtime-cache/consent-epoch.mjs': ['createConsentEpoch'],
  'worker/runtime-cache/position-policy-v2.mjs': ['createPositionBidCachePolicy'],
};

/** Installed by ./install-test-workspace.mjs for the TEST workspace Worker only:
 * the Prebid settings page script. */
export const testWorkspaceFunctions = {
  'worker/test-workspace/prebid-versions.mjs': ['fetchPrebidVersions'],
};
