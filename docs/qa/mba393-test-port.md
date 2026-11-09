# MBA-393 / MBA-331 targeted TEST port

Local source review and verification on 2026-11-09. Base: `e70f6dcb70308e9bd5f3ea1a1a771c78bece1f0e`; parent implementation through `383949f`, plus final acceptance document from `98cef19`.

## Preserved TEST contracts

- Added the explicit 3.20 engine without replacing existing selections, TEST-only creative/demand engines, historical source inputs, or the 16 existing history records. All previous history text remains byte-for-byte unchanged.
- The eight runtime-320 source/manifest files match the reviewed parent source exactly. The independently reachable TEST source commit is `1e078a79a746e991364911934fff29fd9cfbb770` (same source bytes as MAIN `0da8624fa8e1fe360a3f5edb69a06d752ea4a61d`), with source SHA-256 `41d542a0adf9ae22ca557bd4fd36d26dfacd52eee9be5f95a20501e3dd6a4aee`.
- Retained TEST-only GPID settings, named-script workspace, package cleanup, draft-only routes, default size maps, CSV import, and cache compatibility policy.
- Retained explicit TEST toolchain profiles, historical receipts, lockfiles, separate bindings, sealed Worker build checks and branch-specific workflows. Added focused checks to the existing workflows.
- Server-selected `countryTarget` remains passed into package and bundle generation. Expanded the route test to 3.18, 3.19 and 3.20: TEST Generate, candidate bundle, legacy Generate/Save use the TEST country service; the ordinary server default uses MAIN; browser override attempts fail; historical ZIP bytes remain unchanged.

## Local verification

- `node scripts/bootstrap-toolchain.mjs --profile test`: locked installation passed.
- `node scripts/isolated-toolchain.mjs prepare --profile test`: passed; old generated outputs retained.
- `node scripts/prepare-test-workspace.mjs`: passed, including TEST-only inventory/layout fixtures.
- `node scripts/isolated-toolchain.mjs typecheck --profile test`: passed, without weakening checks.
- `node scripts/isolated-toolchain.mjs build --profile test`: passed. Existing client chunk-size warning remains.
- `node scripts/check-runtime-release-history.mjs e70f6dc`: all 17 records passed provenance and append-only checks.
- Focused Node suites: **170/170 passed**. They cover selector/services, package flow, height compatibility, compiler guards, floor/media/Sticky API validation, inactive overrides, viewport runtime behavior, all GEO package routes, revenue integration, TEST package cleanup, named-script isolation and dependency-free bootstrap history.
- Actual React plus authenticated local Worker browser checks: size-map editing/save failure/retry/reload/Generate recovery **2/2**, and floor validation/unsupported controls preservation/removal/media recovery **4/4**, at 1440px and 390px. The 390px map dialog and desktop saved-control warning were visually inspected; labels remain readable and actions reachable.

Evidence: `.generated/mba393-test-port-node.log`, `.generated/size-map-height-ui/`, `.generated/runtime-controls-validation-ui/`. Synthetic inputs only; no publisher settings, production traffic, hosted deployment or external communications were changed. Hosted verification remains a separate release step.

Early test attempts ran before all TEST-only generated imports were prepared, and one UI start overlapped regeneration; those setup-only failures were resolved by completing preparation and rerunning against stable generated output.
