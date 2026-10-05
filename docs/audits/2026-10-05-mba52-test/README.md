# TEST isolated toolchain compatibility and deployment handoff

Local validation passes. Hosted Cloudflare Build adoption is **pending**: no account settings or hosted deployment were changed by this work. A merge, repository CI success, or connected build using the old saved commands does not establish adoption.

## Reproduced compatibility

Baseline: exact TEST `893bf83fbefc29dca966207574f57ce35575e9de`, installed with historical root lock and Wrangler 4.118.0. Candidate: unchanged signed root lock/runtime compiler closure plus isolated tools lock, Wrangler 4.131.0, Miniflare 5.20260910.0-alpha, esbuild 0.28.1. Local Node 24.19.0; Node 22 is a separate CI gate.

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

## Pending external settings change

The existing saved commands are documented in `ops/runtime-test/README.md`: root `npm ci` and `npx --no-install wrangler`. Repository edits cannot replace dashboard-saved commands. The Pages workflows are a different deployment surface and are not a substitute.

After review and the exact candidate's Node 22 CI passes, update only **prebid-professor-test → Settings → Build**:

| Setting | Required value |
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

Record the exact candidate commit, tools-lock SHA, build receipt, effective install/build/deploy commands and Node/Wrangler versions from the fresh Cloudflare build. Then verify its deployed TEST version and effective DB/R2/origin bindings, and complete the existing hosted login/Generate/Save/reopen/download smoke. Only that evidence establishes hosted adoption. Keep the previous TEST version for code rollback; never reset storage. Root historical development advisories remain archived inventory; audit-zero isolated dependencies is not audit-zero of every lockfile in the repository.

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

This change migrates the existing CI build job and TEST workspace jobs (including their local Miniflare fixtures) to explicit isolated commands on Node 22.23.3. The independent upstream Prebid source install retains its own lock and tools. Other repository workflows, default root npm scripts, and dashboard-saved deployment commands remain legacy until deliberately migrated. No main receipt, root package/lock, frozen runtime bytes, runtime registry/default, or seven-record TEST history is changed.
