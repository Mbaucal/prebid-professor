# MBA-217: generic Pages delivery with locked source-profile tools

Base TEST: `ac38e41db1d831a35eab76b9eef91148ff335eef`. This is a TEST-reviewed candidate for the existing generic Pages workflow. No workflow dispatch, Pages/publisher deployment, main merge, runtime version/default change or `verify-existing.json` edit was performed.

## Confirmed problem and rejected hypothesis

The initial missing-install hypothesis was **not reproduced**. In a new worktree without `node_modules`, the original `node scripts/pages-release-verification.mjs validate` loaded successfully and reached input validation. Its static closure is `draft-release-store.mjs` → `prebid-artifact-check.mjs`, using Node/Web APIs and no npm package. A permanent test copies that closure to a temporary clean directory and validates a real synthetic input without installing anything. The actual migration need is the generic deploy action's explicit legacy Wrangler 4.118.0 installation.

Only the deploy job now bootstraps locked tools, after identity validation and before any credential-bearing step. Verify and report use Node-only source-profile checks, retaining their read-only/status-only role and no npm install. All three jobs use Node 22.23.3. The exact pinned Wrangler action, outputs, GitHub deployment metadata behavior and separate public verification/callback retry remain in place; it reuses tools-owned Wrangler 4.131.0 from `tools` and the explicit relative asset directory.

## Explicit source-profile contract

`pages-toolchain.mjs` selects a reviewed historical profile from the checked-out source, never a dispatch input or requested channel. TEST requires its marker, TEST receipt and matching baseline `893bf83fbefc29dca966207574f57ce35575e9de`. A TEST receipt without its marker fails rather than falling back to main. The reviewed main layout has no marker or TEST receipt and uses main receipt baseline `685d90b6974133e19e96f7ceb28e60a58b7ce402`. Unexpected markers/baselines fail.

Staging retains the existing validated feature-ref behavior. Production still requires `refs/heads/main` and additionally the main source profile. The repository is constrained to `Mbaucal/prebid-professor`. Profile selection cannot grant publication: existing identity, immutable source, actual Pages production-branch and prepared-byte checks still apply.

The shared tool resolver was extracted from `builtin-pages-preflight.mjs`; its existing exported API and default TEST behavior remain unchanged. Generic preflight passes the selected source profile explicitly. The reviewed main bootstrap/verifier predates explicit profile flags: the new caller uses its existing no-argument main bootstrap, while TEST gets `--profile test`. Clean synthetic main/TEST CLI tests prove this dispatch distinction and reject profile passthrough. Actual main adoption still requires the reviewed main tools baseline/PR137 and a separate reviewed carry of these workflow/helper/proof changes; marker-absent fixture tests are not proof of an already modified or deployed main branch.

## Prepared package and retry behavior

Preparation writes the validated input, GitHub run ID and commit alongside the already verified project/file inventory. Both preflight and public verification reject a proof for another input/run/commit/release/project/channel. Preflight checks exact regular files, sizes, hashes and unchanged `_headers`, including compact complete-release delivery. Unknown files, duplicate/unsafe inventory names, symlinks and altered assets/headers fail before action tool execution. Existing private builtin draft denial remains enforced by the original validator.

Generic deploy, public verification and report remain separate jobs. The callback outcome/message logic is unchanged; report retries never redeploy. The retained action still supplies deployment and alias URLs. The existing action-contract harness now also exercises generic staging/production command-message arguments using fake local npm/npx and blocked network; it verifies install skipping, working directory, argument boundaries, structured outputs and failed-command behavior. Optional GitHub metadata remains retained/source-reviewed, not live API-tested.

## Validation and dependency patch

The separately reviewed tools patch from worker2 (`84539cd0699c144b615f8db6ec13cb1774fef9d6`, carried here as `2502c8f`) pins sharp 0.35.5; only its tools manifest/lock and sharp native closure change. The shared tools lock SHA is `4849ee2954ed15420ef62d0d8da76cfef6c949a5fa48dd552c8e622e664190d6`. Root compiler lock and frozen signatures remain unchanged. This patch is included before final candidate validation rather than leaving a newly discovered active-tools advisory open.

Local Node 24.19.0 validation passed: fresh patched npm-ci bootstrap, strict3, App build, 182 combined generic/builtin/delivery/public/callback/reverification checks, then the final 32-case generic suite including two additional clean CLI compatibility cases. Existing synthetic tests execute the actual prepare and public-verify commands for legacy, compact and main-production fixtures; a different run is rejected before any mocked fetch. The action-contract scenarios pass with no real tool command or network. Historical verification confirms 16 installed compiler package instances and all 66 fixed TEST outputs. Fresh audit: historical full root lock **7 high / 0 critical**, active root-production **0**, active tools **0**. No global audit-zero claim is made.

The existing Pages verification CI retains all previous tests and adds the generic suite and relevant helper paths for both PR and push. Exact candidate Node 22.23.3 CI is a separate gate. Run preflight suites before an App build, as the fresh deployment job does: a generated `.wrangler/deploy/config.json` redirect from a prior Vite build is intentionally rejected by the unchanged tools boundary. No application UI behavior changed, and accepted hosted manual tests were not repeated. MBA-52 remains open for remaining main/default/deployment adoption and historical inventory.
