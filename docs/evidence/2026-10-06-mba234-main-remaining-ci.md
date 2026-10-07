# MBA-234: remaining MAIN editor/readiness/bootstrap checks

Base: `555cf6f97854c1ed17e053307b7922eae318c07d`. Owner code: `00e19849b3eaa6838d2cb747ebff56ae056aaf29`. Local validation also includes MBA-233 shared runner `2a9d5f5` (cherry-picked locally as `13e8c1e`). The owner commit depends on that runner; it is not a standalone fixed-compilation implementation.

Four existing workflows now use MAIN locked bootstrap and Node 22.23.3: site editor, Prebid editor, consent readiness, and test Worker bootstrap. Existing test commands, branch coverage and artifact paths remain. Prebid adds MAIN pull-request coverage without adding MAIN push coverage. Path filters include tools/locks and applicable configuration/runner dependencies. Seven fixture changes only replace bare Miniflare imports with the existing explicit local adapter; all assertions remain unchanged. Jobs select `TESSERA_TEST_TOOLCHAIN=isolated`, inherited by Python child fixtures.

The fixed runner commands are `node scripts/isolated-toolchain.mjs test-dry-run` and `node scripts/isolated-toolchain.mjs test-bootstrap-dry-run`. They compile existing configurations to existing output paths without deployment or arbitrary flags. The first runs after the existing App build/security checks: explicit fixed `--config` bypasses Vite's generated deployment redirect. The original production dry-run behavior is unchanged. Cloudflare isolation audit, builtin TEST deploy/reverify, root/default/hosted commands, package locks, frozen inputs and runtime/UI sources are untouched.

## Executed local validation

Node **24.19.0**, `TZ=UTC`; actual Node **22.23.3 CI remains a separate gate**. Installation used the checked-in root-production/tools locks through `node scripts/bootstrap-toolchain.mjs`.

| Check | Observed result |
| --- | --- |
| All existing source suites from the four workflows, combined | 305 passed, 0 failed |
| Shared fixed-target guard tests | 4 passed |
| `isolated-toolchain.mjs typecheck` | App, Worker, tooling strict checks passed |
| `isolated-toolchain.mjs build` | Passed; 63 historical outputs and 16 historical production dependency instances preserved |
| `test-dry-run` and `test-bootstrap-dry-run` after App build | Disabled/active runtime TEST and bootstrap TEST compilation passed |
| Production compiled artifact/auth/login-logo boundaries | Passed; original HTML, redirects, login/rate-limit, schema and actor checks retained |
| Compiled site duplication | 8 passed |
| Compiled site editor / Prebid | 17 / 27 passed, 0 outbound requests |
| Native Prebid readiness / consent boundary / setup | 34 / 8 controls and setup passed |
| Login branding / login recovery | Passed; production and TEST fixture modes |
| Site editor / site workspace / test page | 13 site-editor checks and both other suites passed |
| Release setup / loading summary / position runtime | All existing browser commands passed |
| Prebid editor / configuration browser | 16 / 15 passed |

Browser commands were the unchanged workflow commands, using `/tmp/mba212-py/bin/python`, Playwright 1.55.0 and `PLAYWRIGHT_BROWSERS_PATH=/tmp/mba212-browsers`. The first branding invocation stopped before execution because local Pillow was missing; installing workflow-pinned Pillow 11.3.0 resolved that prerequisite. No assertion changed or failed result was ignored. Proxy variables were omitted only from the local synthetic browser child environment; DNS-pinned loopback fixtures and request interception remained intact. No hosted session, external credentials or live ads were used.

Desktop and narrow site-editor screenshots were opened and inspected: fields/cards remain readable within the viewport, with unchanged save/review controls and English UI. Existing browser suites cover loading/error/retry and keyboard behavior. Screenshot/report directories remain the existing workflow artifacts. App JS SHA256 `e4cf0a4dcc87da2e22c3d9100b83002eddfb7606c6785132d6add931000d320a` and CSS SHA256 `726caf07dc7d20d038ea9f52cc6624a2f903a378d31e8e113973f179a4a79913` exactly match the previously compiled MBA-230 candidate.

This is local MAIN-candidate CI/tool compatibility evidence. It is not a MAIN merge, TEST/production deployment, hosted verification or publisher privacy result. Root and tools lockfiles are unchanged; historical audit inventory and deferred adoption work remain separate.
