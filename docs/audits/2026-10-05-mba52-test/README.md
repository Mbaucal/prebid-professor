# TEST isolated toolchain compatibility and deployment handoff

Hosted isolated TEST Build/Deploy adoption and the hosted acceptance flow are **confirmed**, as recorded in [MBA-52](https://linear.app/mbaucal/issue/MBA-52) and the current [START HERE](https://linear.app/mbaucal/document/tessera-start-here-aktuelni-pm-rad-57156b7568fa) on 6 October 2026. The remaining issue covers legacy/main toolchain migration and the historical full root lock; this is not production promotion.

## Reproduced compatibility

Baseline: exact TEST `893bf83fbefc29dca966207574f57ce35575e9de`, installed with historical root lock and Wrangler 4.118.0. Candidate: unchanged signed root lock/runtime compiler closure plus isolated tools lock, Wrangler 4.131.0, Miniflare 5.20260910.0-alpha, esbuild 0.28.1. Original local validation used Node 24.19.0. Node 22.23.3 CI subsequently passed (build/typecheck/audit run `37356199269`, TEST workspace run `37356199523`); the hosted build below also confirms Node 22.23.3.

Both active and disabled candidate TEST bundles match baseline SHA-256 `1237490e7876c0c36ddbf592c960f24a2b006892505494bf026a8a9c67ecd289`. Equality of the outer bundle is observed here, not a general requirement for future toolchain changes.

[Compiled parity receipt](compiled-parity.json) records seven passing assertions. Actual local compiled Workers use separate persistent D1/R2 directories and synthetic authentication. For both 3.14.0 and 3.15.0, modern Generate supplies one signed review receipt to both old and modern Save handlers. Both regenerate and validate the same timestamp, config and package hash; downloaded ZIP bytes match exactly. Duplicate Save, verified reopen and full Worker restart preserve both original archives after the later runtime selection. No outbound request occurs. This covers GAM-only generation, not all runtime/options combinations, hosted storage or live ad delivery.

Existing suites also pass in `TESSERA_TEST_TOOLCHAIN=isolated` mode: workspace 22, selection 12, delivery 8, named scripts 17, site editor 17, Prebid 27. The shared adapter verifies the TEST profile and tools lock before using tools-owned Miniflare. It converts the legacy options explicitly and preserves `resourcePersistencePath`; restart assertions verify actual disk persistence. With no isolated mode, legacy root Miniflare behavior is unchanged. Unknown modes fail.

Reproduce after TEST bootstrap and `test-build`:

```sh
node tools/verify-test-workerd-parity.mjs /absolute/path/to/pristine-893bf83/.generated/test-workspace-active-dry-run/index.js
TESSERA_TEST_TOOLCHAIN=isolated node scripts/verify-workerd-workspace.mjs
TESSERA_TEST_TOOLCHAIN=isolated node scripts/verify-workerd-selection.mjs
TESSERA_TEST_TOOLCHAIN=isolated node scripts/verify-workerd-delivery.mjs
TESSERA_TEST_TOOLCHAIN=isolated node scripts/verify-named-script-test-workerd.mjs
TESSERA_TEST_TOOLCHAIN=isolated node scripts/verify-workerd-site-editor.mjs
TESSERA_TEST_TOOLCHAIN=isolated node scripts/verify-workerd-prebid.mjs
```

The baseline argument is hash-checked before use. The parity harness writes `.generated/toolchain-test-evidence/parity.json`; it never downloads or executes publisher assets.

## Confirmed hosted adoption

The complete build log for [build `1dd2f4f2-006c-4a5f-a95d-0b6cdc43f3d8`](https://dash.cloudflare.com/b5e5e6f70b811e8f97af71df1af46308/workers/services/view/prebid-professor-test/production/builds/1dd2f4f2-006c-4a5f-a95d-0b6cdc43f3d8), completed 5 October 2026 at 22:00:21 UTC, confirms Node 22.23.3, npm 10.9.2, skipped automatic dependency installation, the isolated bootstrap, Wrangler 4.131.0 and sealed deployment. It published Worker version `3316cfca-8afe-47ea-b085-af884425fdca`, also confirmed by successful check `111997947172`.

The build and pre-deploy receipts identify clean commit `1c4d33b2184f4c473d8084688cf1b2cd4a1ab3f6`, tree `beaf266fcc661ad867f52fad03fa0fc835f2c000`, tools lock SHA `765891574b1733ab2e3df8ccc52bb7d7e7aa75a7d2fa0ac2606ba62651548a0d`, unchanged historical root lock and both compiled hashes shown above. Actual deployment used `TEST_WORKSPACE_ENABLED=true` and the existing TEST origin, D1 and R2 resources. The earlier disabled dry-run value was a validation step, not the deployed setting.

Adopted configuration and retained constraints (not a request to repeat setup). Effective commands, Node version, skipped install and deployed TEST resources are evidenced by the log; branch/root follow the accepted PM configuration evidence. The OFF setting and unchanged token/secrets remain constraints, not independently inspected settings from this build log:

| Setting | Adopted value or retained constraint |
| --- | --- |
| Branch | Keep `feature/isolated-runtime-workspace-v1` |
| Root directory | Keep `ops/runtime-test` |
| Build variable | `SKIP_DEPENDENCY_INSTALL=1` |
| Node version build variable | `NODE_VERSION=22.23.3` |
| Build command | `node ../../scripts/bootstrap-toolchain.mjs --profile test && node ../../scripts/isolated-toolchain.mjs test-build --profile test` |
| Deploy command | `node ../../scripts/isolated-toolchain.mjs test-deploy --profile test` |
| Non-production branch builds | Keep OFF |
| Token, runtime secrets, resources | Keep existing values; no new credentials or resources |

The deploy wrapper accepts no arbitrary Wrangler flags, uses the fixed active TEST configuration and requires the current clean commit/tree, tool lock, source/config and generated/compiled input seals to match its build receipt. `test-deploy-check` is the read-only seal check; it does not deploy. No actual deploy command was executed locally.

Hosted acceptance completed on 6 October 2026 at 13:07 CEST. PM directly checked login, Generate, Save and persistence after full reload. The user confirmed ZIP download and supplied Open saved release JSON with `verified:true`, `storageState:"stored"`, release ID `builtin-draft-d02d68896ccc83d8e33f310d7b4b0eb4c5cf3e9089c7d1d2429fa700a735efcc`, package SHA `d02d68896ccc83d8e33f310d7b4b0eb4c5cf3e9089c7d1d2429fa700a735efcc` and creation time `2026-10-06T09:02:53.019Z`. Runtime 3.14.0, Prebid 11.34.0, 11 files and 596724 bytes match the saved draft metadata. Download is user-confirmed; PM did not independently inspect the downloaded ZIP bytes. This isolated draft remains non-publishable and does not publish to a publisher. No repeat of accepted manual testing or Cloudflare configuration is needed.

Root historical development advisories remain archived inventory; audit-zero isolated dependencies is not audit-zero of every lockfile in the repository.

Official references: [Cloudflare build configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/) and [build image and dependency-install controls](https://developers.cloudflare.com/workers/ci-cd/builds/build-image/).

## Separate historical gate and guarded commands

`tools/test-historical-inputs.json` records the exact old TEST baseline above: 34 signed source components, six available generated manifests, all seven release-history records, 16 installed historical production packages, and 66 fixed generated outputs. The main receipt is unchanged. Mutable Test-page/UI output is excluded from the permanent historical gate; the deployment seal binds its current prepared bytes instead. This receipt preserves available historical inputs and fixtures, not arbitrary previously saved archives that are unavailable locally.

Reproduce the receipt independently in a detached checkout of the exact baseline: `npm ci --ignore-scripts`, `node scripts/prepare-builtin-runtime.mjs`, then `node --experimental-strip-types scripts/prepare-site-ab-baseline.mjs`. From the candidate run `node scripts/capture-historical-toolchain.mjs /absolute/path/to/baseline --profile test`. This command compares independently prepared evidence; it does not update expected hashes. Extra mutable baseline outputs are not counted among the 66 compared outputs.

From the repository root after explicit TEST bootstrap:

```sh
node scripts/isolated-toolchain.mjs typecheck --profile test
node scripts/isolated-toolchain.mjs build --profile test
node --test tests/runtime/toolchain-isolation.test.mjs
node scripts/audit-isolated-toolchain.mjs --profile test
```

From `ops/runtime-test`, on a clean committed candidate:

```sh
node ../../scripts/isolated-toolchain.mjs test-build --profile test
node ../../scripts/isolated-toolchain.mjs test-deploy-check --profile test
node --test ../../tests/runtime/test-toolchain-seal.test.mjs
```

Deployment uses the validated compiled `index.js` with Wrangler `--no-bundle`, fixed active TEST config and no passthrough arguments. The read-only check proves that this packaging path retains identical bytes. Source, tools lock, current commit/tree, active configuration, both compiled bundles and every direct generated input file are sealed. Existing Worker generated imports are direct files; evidence/output subdirectories are excluded. A changed generated UI file or compiled Worker fails; writing audit/parity evidence does not invalidate the seal. Tracked dirty files block deployment; untracked files in the covered source directories participate in the hash. This protects reproducible build/install mistakes, not arbitrary hostile filesystem mutation. Installed tool versions are checked against the dedicated lock; npm ci supplies integrity verification during installation.

This change migrates the existing CI build job and TEST workspace jobs (including their local Miniflare fixtures) to explicit isolated commands on Node 22.23.3. The independent upstream Prebid source install retains its own lock and tools. The follow-up also migrates the existing site-editor and Prebid-editor workflows, preserving their test commands and artifact paths and extending triggers to toolchain/config inputs. The remaining TEST validation migration is tracked in MBA-213 and MBA-214 below; the hosted TEST commands above are already adopted. Default root npm scripts and main/production paths remain outside this TEST-only adoption. Main opt-in PR #137 remains a separate reviewed draft, not an adopted default. No main receipt, root package/lock, frozen runtime bytes, runtime registry/default, or seven-record TEST history is changed.


## Editor workflow follow-up validation — 6 October 2026

The two editor workflows retain all original test/browser commands, artifact paths and branch triggers. Their install, App build and TEST dry-run commands now select the existing isolated TEST profile; the job-level adapter setting reaches browser fixture subprocesses. No underlying helper edit was needed.

Local Node 24.19.0 validation passed: checked-in npm-ci bootstrap, all three strict type configurations, App build, both TEST dry-runs (unchanged compiled SHA above), 278 source tests, compiled artifact/auth boundaries, eight duplication checks, 17 site-editor checks and 27 Prebid checks. Every existing browser command also passed: both desktop/390px login recovery modes, site editor (13), Prebid editor (16), Prebid config (15), site workspace, release setup, loading summary, saved-package Test page and position runtime fixtures. Evidence stays in the workflows' existing `.generated/*-evidence/` paths. Local browser processes excluded inherited proxy settings for their isolated loopback fixtures; workflow commands and network restrictions were unchanged. Source tests ran in UTC, matching the site workflow and Ubuntu runner. This is local evidence; the follow-up's exact Node 22.23.3 GitHub run is a separate gate. No application code, hosted setting or deployment changed, and completed hosted acceptance was not repeated.


## Remaining TEST validation workflows — MBA-213 / MBA-214

On TEST base `5e40f1f564a79a0fd9f024fcb13500db16730ddf`, MBA-213 migrates consent readiness, creative templates and Pages package-verification checks to the same explicit isolated TEST bootstrap and Node 22.23.3. Every previous test command, runtime-history guard, branch trigger and artifact path is retained. Toolchain/configuration/lock changes now trigger these checks, including both Pages PR and push filters. The Pages workflow verifies synthetic package/deployment boundaries; it does not deploy.

The TEST validation inventory is: CI build and test-workspace checks (PR #138), site-editor and Prebid-editor checks (PR #139), these three checks (MBA-213), and agency hierarchy, App layout and GAM integrations (separate MBA-214 candidate). Completion of the last two candidates' independent review, exact Node 22 CI and TEST integration establishes adoption across this inventory; a local candidate alone does not establish it.

Remaining scope is explicit: actual `deploy-pages-release.yml`, `deploy-builtin-test.yml`, `verify-existing-builtin-test.yml` and `run-feature-release-schain-patch.yml` operations are unchanged; main-only artifact/builtin/stored-draft/audit workflows, historical runtime-foundation/bridge checks, root default commands and main/production adoption are not migrated by these changes. Main opt-in PR #137 remains separate. The independent upstream Prebid build keeps its own locked build tools. No full-root audit exception is implied: the prior accepted Node 22 run reported **7 high / 0 critical** in the unchanged historical full lock and **0** in each active root-production/tools install. This supersedes the older six-node inventory without changing frozen inputs or claiming global audit-zero. MBA-52 remains open for that remaining scope.

MBA-213 local validation uses Node 24.19.0: fresh checked-in npm-ci bootstrap, all three strict type configurations, App build, all 163 existing source checks from the three workflows, and the unchanged seven-record runtime history pass. A fresh installed audit again reports historical full lock 7 high / 0 critical, active root-production 0 and active tools 0. All three existing readiness browser commands also pass: generated runtime/native Prebid scenarios, atomic boundary and negative controls, and explicit version setup/persistence on desktop and mobile, with external requests blocked. Evidence remains in `.generated/readiness-evidence/` and `.generated/readiness-setup-evidence/`. Existing commands, branch triggers and artifact paths were compared against the exact TEST base. Exact-candidate Node 22.23.3 CI remains a separate gate; no deployment or accepted hosted manual test was performed in this follow-up.
