# Tessera audit — MBA-96

Executed 2026-09-22–23 UTC. **Not a production readiness sign-off.**

The first audit pass found a reproducible cross-site artifact deletion risk,
navigation and accessibility problems, and an incomplete hosted Sticky test.
The critical Prebid ownership correction is included in this TEST-first candidate.
The audit remains open for the other high-priority findings and the hosted
delivery/CMP checks below.

## Versions and boundaries

| Item | Exact baseline / observation |
| --- | --- |
| Main code and local dashboard | `8bc698de95fffbed476a9a5dee9e998e5ac0190e` |
| TEST at start | `56320f5ab5f4a730d534ef702fc5bb4a7400f9bd` |
| TEST during hosted runtime inspection | `6edda2b15b8d66c9908d8bf3970d4a5c9ae8b31d`; Cloudflare build `8f68e51c-264c-4781-92ae-dc280150cc93` succeeded |
| Hosted app | `https://prebid-professor-test.mbaucal.workers.dev/` |
| Existing TEST selection | `3.9.1-tessera.preview.2`, Prebid `11.34.0`; selection was not changed |
| Latest main built-in runtime exercised locally | `3.10.0-tessera.preview.1` |
| TEST-only additional runtime | `3.11.0-tessera.preview.1` creative-template work; not approved as main by this audit |
| Hosted artifact created during audit | `builtin-draft-02d6f8290a09c8c30d4ed76d9d01ddcc21dac94b03b2071362555a7bf4ea5de5` |

Only one clearly labelled audit package was added to the existing TEST copy.
No site configuration, original package, production channel, campaign or GAM
inventory was edited. The runtime test sent ad requests after an explicit Start
test action; it did not click creatives. All destructive reproduction used
ephemeral SQLite/D1 and fake/local R2.

The TEST branch moved during the audit due to separate Test page work. Main
dashboard tests use the fixed main baseline, not an assumed equivalence between
the two applications. The authenticated main dashboard was not inspected live;
its real built assets were tested against isolated API fixtures.

## Executed matrix

`Passed locally` is deliberately different from `passed hosted`. Automated
counts overlap across suites; do not add them into an inflated total.

| Scenario and expected result | Environment / evidence | Result |
| --- | --- | --- |
| Baseline compiler, configuration, security boundaries, failures and integrations | Main; `tests/runtime/*.test.mjs`, `tests/gam/*.test.mjs`, `tests/cloudflare/*.test.mjs`; [full results](baseline-node-tests.tap) | **918/918 passed**, no skipped tests |
| Production frontend/Worker bundle builds | Main, `npm run build` | Passed; frontend chunk warning, 763.44 kB raw / 196.06 kB gzip at baseline |
| Strict static type check | Main, `tsc --noEmit`; [diagnostics](baseline-typecheck.txt) | **Failed: 60 diagnostics**; build does not enforce this gate |
| Fixed viewport, independent content/sidebar scrolling, responsive modals | Actual dashboard and TEST frame, 16 viewport/path combinations | Passed locally |
| Agency → Publisher → Site presentation and assignment | Agency browser suite + compiled production Worker/native D1, stale assignment and Origin checks | Passed locally |
| Selected site/Config survives reload | Actual dashboard, synthetic hierarchy; [before/after](navigation.json) | **Failed**, resets to first site / Overview |
| Site modal closes with Escape | Actual dashboard | **Failed**; focus trap and screen-reader testing still needed |
| Publish header gives an actionable next step | Actual dashboard source and UI | **UX defect**: only selects Releases; repeated click adds no action/guidance |
| New site inventory, duplicate, maps and demand remain consistent | Node handlers and actual service fixtures | General suites passed; duplicate Prebid defect found and corrected separately |
| Seven supplied CSV mapping groups, all 25 breakpoints, fluid and empty sizes | Size-map template/import Node cases | Passed locally; no hosted import performed |
| GAM-only latest main script requires no Prebid file | Release setup browser flow, runtime service + compiled bundle | Passed locally, downloaded ZIP excludes Prebid |
| Script and demand save preserve other fields; stale edits fail | Node/CAS tests, native D1/R2 site/Prebid/settings suites | Passed locally |
| Loading summary follows ATF/BTF, overrides and Sticky selection | Loading summary browser + Node + hosted home → Loading rules | Passed for covered cases; hosted table matches saved TEST selection |
| Generate/save/reopen/download retains exact package bytes | Node and local actual-components browser ZIP round trip; native D1/R2 restart | Passed locally |
| Hosted Generate and save package from existing settings | TEST home → site workspace → Releases | Passed hosted; saved package listed and used by Test page |
| Hosted ZIP download and independent file verification | Same package | UI reported completion, but browser download event timed out at 3s and 60s. **Binary capture/verification blocked**, not classified as an app failure |
| Prebid editor and site editor browser over pinned loopback TLS hostname | Existing `verify-prebid-editor.py` / `verify-site-editor.py` | **Blocked locally** by `ERR_PROXY_CONNECTION_FAILED`; native workerd checks of these data flows passed |
| Existing browser suites for layout, agencies, workspace, release setup, loading, GAM, A/B, script library and positions | [Run summary](browser-runs.json) | **9 suites passed**; two infrastructure failures above remain explicit |
| Worker auth, CRUD/CAS, package restart, Prebid, mocked deployment dispatch/rollback, GAM OAuth/SOAP, A/B, script library | [Nine compiled-worker runs](workerd-runs.json) | Passed locally after supplying the correct compiled directories for two initial setup failures |
| Shipped cache package with actual Prebid, duplicate execution and failure cases | Chromium, native Prebid; GPT/TCF synthetic, external auctions blocked; [52 checks](native-prebid-browser.json) | **52/52 passed** |
| Main 3.10 TakeOver, no-fill, timeout, lazy overrides and viewport behavior | `verify-position-runtime.py` and runtime Node suites | Passed for fixture scenarios; does not certify real campaign delivery |
| Hosted saved 3.9.1 package startup | [Visible runtime evidence](hosted-runtime.txt) | Script/GPT/Prebid ready; DOM 3/3; GPT registered 3/3 |
| Hosted BTF Sticky actually requests after scrolling | Same package, NewPosition selected as Sticky | **Incomplete/failed observation**: 0 requests after scroll; other two slots requested and returned empty; cookie exception in sandbox |
| GAM interstitial registration | Same hosted test | Additional interstitial slot registered/requested once; actual creative display not proven |
| Corrected duplication and original-file preservation | [51 relevant regressions](fix-regressions.tap), including **12 new cases** | Passed locally |
| Corrected duplication through full authenticated production route | Compiled Worker + native ephemeral D1/R2; [8 checks](duplication-workerd.json) | Passed locally, including complete bundle generation and deleting only the copied object |
| Hosted Stage/Publish/rollback and actual public URL bytes | No isolated delivery target was changed | **Not executed**; local dispatch/rollback tests are not a substitute |
| Real publisher CMP/GEO, demand fill, direct creative close buttons, Safari/Firefox and publisher layout | No dedicated publisher staging fixture used | **Not checked**; required before a publisher deployment sign-off |

## Confirmed findings and correction

| Issue | Priority | Finding / state |
| --- | --- | --- |
| [MBA-97](https://linear.app/mbaucal/issue/MBA-97) | High | Duplicated site retained the original Prebid pin and R2 key. Generation failed, and deleting the duplicate's archived build deleted the original site's file. **Correction prepared and tested in this candidate.** |
| [MBA-98](https://linear.app/mbaucal/issue/MBA-98) | High | Reload loses site/section. Add validated URL navigation and back/forward coverage. Open. |
| [MBA-99](https://linear.app/mbaucal/issue/MBA-99) | Medium | Generate/Publish header buttons have the same navigation action. Clarify package selection, Stage, Publish and external delivery. Open. |
| [MBA-100](https://linear.app/mbaucal/issue/MBA-100) | Medium | Site modal lacks Escape behavior and dialog labelling; complete keyboard/focus audit. Open. |
| [MBA-101](https://linear.app/mbaucal/issue/MBA-101) | Medium | 60 TypeScript diagnostics; mainly missing module/API types and browser/Worker type mixing. Not 60 demonstrated runtime bugs. Open. |
| [MBA-102](https://linear.app/mbaucal/issue/MBA-102) | High | Hosted BTF Sticky never requested in the observed test; sandbox cookie write also threw. Root cause and behavior on 3.10 need separate investigation. Open, linked to Test page work. |

MBA-97 reproduction is retained in [the baseline evidence](duplication-before.json).
The new regression deliberately begins with a valid, verified source selection.
The fix verifies source bytes, copies to a new site/build key with conditional R2
creation, updates the copied pin, and compares source configuration/current build
inside the D1 transaction. Copy-without-build keeps the chosen script version and
demand but clears the foreign Prebid pin and presents the existing setup guidance.
GAM-only copying still generates successfully without any Prebid artifact.

Deletion rejects legacy foreign/shared keys. Its conditional database deletion
precedes R2 cleanup so concurrent activation cannot lose a newly current file.
Unconfirmed database responses retain R2 bytes. Existing corrupt/shared rows are
not automatically migrated; SQL/R2 failures can leave an unreferenced private
copy for later cleanup. This trades retained storage for preserving valid files.
No engine source or immutable historical release was edited.

## Organization and release hygiene

`PROJECT.md` still described PR #19 / the old monitoring branch as current and
omitted Agency from its central product model. Those two stale references are
corrected here. The existing frontend has one large initial bundle and many
Worker wrappers; this is a maintenance/performance observation, not evidence for
a broad rewrite. Prioritize typed API boundaries and shared navigation before
adding more settings screens.

The current TEST commit has a successful Cloudflare deployment and a successful
normal workspace run. A separate historical PR **#29**, targeting
`feature/builtin-runtime-foundation-v1`, fails its append-only runtime-history
check (`4 !== 2`) because that PR compares against an old foundation without the
register. Do not weaken the guard or treat that stale PR failure as a failed
production deployment. New correction PR checks must be evaluated against their
actual target and exact head.

## Reproduction and next acceptance gates

Baseline preparation and test command:

```sh
node scripts/prepare-builtin-runtime.mjs
node scripts/prepare-test-workspace.mjs
node --experimental-strip-types scripts/prepare-site-ab-baseline.mjs
node --experimental-strip-types scripts/prepare-position-browser-fixtures.mjs
node --experimental-strip-types --experimental-loader ./tests/support/ts-extension-loader.mjs --test --test-concurrency=4 tests/runtime/*.test.mjs tests/gam/*.test.mjs tests/cloudflare/*.test.mjs
npm run build
npx --no-install tsc --noEmit
```

Focused correction checks (run after preparation/build):

```sh
node --experimental-strip-types --experimental-loader ./tests/support/ts-extension-loader.mjs --test tests/runtime/site-duplication.test.mjs tests/runtime/builtin-prebid-integration.test.mjs tests/runtime/site-runtime-service.test.mjs tests/runtime/site-package-flow.test.mjs
node scripts/verify-site-duplication-workerd.mjs
python scripts/audit-dashboard-navigation.py
TANJUG_PACKAGE_DIR=.generated/script-library-delivered/cache/deploy python scripts/verify-tanjug-cache.py
```

The last command requires the delivered cache fixture produced by
`verify-script-library-workerd.mjs`. The nine native suite commands and the two
initial harness failures are preserved in the run JSON files. Evidence file
checksums are in [evidence-sha256.json](evidence-sha256.json).

Before closing MBA-96: review/deploy the critical ownership fix through TEST,
verify the release candidate from its exact commit, resolve the navigation and
Sticky findings, independently verify a hosted downloaded ZIP, and exercise
isolated hosted publish → public URL → rollback. Then use a dedicated publisher
staging page for current 3.10 GAM-only/Prebid, CMP granted/denied/delayed, no-fill,
refresh/hidden tab/resize, sticky/direct creative close buttons and interstitial.
Main promotion requires the owner's TEST-first approval; this audit does not
authorize a production campaign change.
