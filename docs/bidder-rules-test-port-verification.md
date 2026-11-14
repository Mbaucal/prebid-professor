# MBA-400 TEST port verification

Verified locally on 2026-11-12, based on TEST commit `21e612e`.

The port keeps the TEST-only creative and demand engines, existing runtime order, flat navigation, authentication, database/bucket bindings and isolated toolchain profile. Runtime 3.22.0 is appended to the available catalog and added as the current recommendation; existing site selections and stored packages are unchanged. Its source provenance points to published commit `679c2d23ed40801c5bc6a1c2d8795119d0f05b64`, with code SHA-256 `f4bdcbb65c9cc7a19534eed85f5dc8322c08009fc5501b82b2edabbd870490e3`.

The following commands passed:

```sh
node scripts/bootstrap-toolchain.mjs --profile test
node scripts/isolated-toolchain.mjs typecheck --profile test
node scripts/isolated-toolchain.mjs prepare --profile test
node scripts/prepare-test-workspace.mjs
node scripts/check-runtime-release-history.mjs origin/feature/isolated-runtime-workspace-v1
node scripts/check-test-activation.mjs
node scripts/isolated-toolchain.mjs build --profile test
node scripts/isolated-toolchain.mjs test-dry-run --profile test
node --experimental-strip-types tests/bidder-rules-native/prepare.mjs
git diff --check
```

The targeted Node suite passed **151/151 tests**:

```sh
node --experimental-strip-types --experimental-loader ./tests/support/ts-extension-loader.mjs --test \
  tests/runtime/bidder-rules-*.test.mjs \
  tests/runtime/site-package-flow.test.mjs \
  tests/runtime/site-runtime-service.test.mjs \
  tests/runtime/test-runtime-selection.test.mjs \
  tests/runtime/test-site-editor-http.test.mjs \
  tests/runtime/revenue-integration.test.mjs \
  tests/runtime/contextual-signals-test-workspace.test.mjs \
  tests/runtime/outstream-runtime-eligibility.test.mjs
```

Release provenance verified all 21 records and preserved earlier entries. TEST default and active dry-run bundles were identical, SHA-256 `ff50205c616b67037e2f218baf4483aeb785381637c9d5df79409130bb57805e`. The offline activation check confirmed the existing TEST bindings with no routes/crons and no credential reads. No deployment or hosted data changes were performed.

Native browser interaction, desktop/narrow screenshots and native Prebid wire execution remain pending CI: local Chromium launch is blocked by sandbox socket permissions. Fixture preparation and Node runtime tests do not constitute browser or hosted verification. Existing CI runs the bidder editor suite and native Prebid matrix with synthetic responses.
