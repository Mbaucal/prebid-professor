# Isolated test workspace — MBA-53

This standalone entrypoint is built on PR #26. It reuses the approved generator, authentication primitives with separate test credentials/session namespace, and immutable draft storage. It never imports or delegates to the production application router. This is NOT all of Tessera's screens or a production release.

## Scope

A synthetic example.invalid site; GPT-only generation, optional approved TakeOver code, text-only preview, reviewed Save and verified historical ZIP download. No actual ad requests from the workspace. No CMS, email, publisher publish, deletion, bulk upload, general site management or cron. The HTML inside a downloaded candidate can request ads if separately served; do not install it live.

`POST /test-api/setup` is explicit, authenticated and same-origin. It accepts only an empty database, creates checksum-locked schema without production seeds, and creates one synthetic site as one D1 batch. GET requests never initialize. Recognized schemas are reusable; other/nonempty databases are refused. Twenty-package quota includes partial upload intents. No automatic cleanup or destructive reset.

Generate performs no R2 write. A 20-minute signed review receipt binds the actor, origin, configuration, runtime, timestamp, TakeOver choice and exact package hash. Save accepts that receipt, not uploaded files, and compares the deterministic regenerated package before using the immutable store. Historical reads verify saved bytes without regenerating. Failed/uncertain storage is retained for exact retry.

## Explicit TEST activation — owner setup confirmed 12 September 2026

Marko confirmed saving the three separate runtime TEST_* Secrets on the EXISTING test Worker and supplied its Visit URL: https://prebid-professor-test.mbaucal.workers.dev/ . Their values were not requested or read. This owner confirmation does not prove a hosted login or effective bindings. Do not repeat resource/Secret creation or the unchanged bootstrap audit.

`wrangler.jsonc` stays disabled with an empty origin. `wrangler.active.jsonc` is the explicitly selected test-only activation configuration: only TEST_WORKSPACE_ENABLED and TEST_PUBLIC_ORIGIN differ. Neither file contains passwords or session keys. The offline allowlist checker rejects different worker/account/storage/entrypoint/route/cron/extra bindings or plaintext credentials. It validates DECLARATIONS, not hosted resources.

Only after the exact branch head passes CI, change **prebid-professor-test → Settings → Build**:

| Setting | Value |
| --- | --- |
| Git branch / production branch for THIS TEST Worker | `feature/isolated-runtime-workspace-v1` |
| Root directory | `ops/runtime-test` |
| Build command | `npm --prefix ../.. ci --ignore-scripts && node ../../scripts/check-test-activation.mjs && node ../../scripts/prepare-builtin-runtime.mjs && node ../../scripts/prepare-test-workspace.mjs` |
| Deploy command | `npx --no-install wrangler deploy --config wrangler.active.jsonc` |
| Non-production branch builds | OFF |
| Build token | Keep the existing `prebid-professor-test build token` |

No production Worker, main merge, new token, Build variables or new Secret is required. The dashboard label 'production branch' belongs to this TEST Worker; it does not mean the live application. Do not run the repository-root `npm run build` / `npm run deploy` here. Do not create another Worker. Do not override origin/enable in dashboard plaintext variables; the explicit config is the source of those settings.

Save all settings together BEFORE triggering a fresh build from the selected feature branch. Do not retry an old main-branch bootstrap build to test a feature-branch checkout. When the owner confirms settings saved, a reviewed documentation-only commit on the selected branch can trigger the connected test build; a GitHub CI success is not Cloudflare deployment proof. Verify the resulting build's branch and root.

After successful deployment, record the actual Current Version ID and check that version's effective test DB/R2, no routes/crons/integrations, and private bucket access BEFORE the first explicit setup. Saving runtime Secrets may itself have changed the bootstrap version. Never reuse the old bootstrap UUID as proof for this deployment. Keep the prior test version for test-only code rollback; never delete/reset test storage to roll back code.

Then the owner signs in with the already configured test credentials, clicks Prepare empty test database once, generates a package, acknowledges review, saves it twice (one release), reloads, reopens and downloads the original ZIP. Until this hosted check passes, MBA-53 stays In Progress and no publisher/live readiness is claimed.

## Test build handoff — 12 September 2026

The owner has now confirmed saving all of the test Build settings above. This documentation-only checkpoint is pushed to the selected feature branch to request a fresh connected TEST build, without retrying a checkout from main. The application, active configuration, storage schema and production files are unchanged from reviewed head `69e41299217df456643d202ea740ff92b9d54c9c`.

The confirmation is not a successful deployment or hosted test result. Next inspect the new Cloudflare build and actual deployed version, then complete the pre-setup checks and the owner login/Generate/Save/download test above. No additional Secret or infrastructure creation is required.

## Verification and limits

The integrated workflow runs Node auth/schema/storage/config tests, two credential-free Wrangler dry-runs, a byte-for-byte comparison of the disabled and active compiled Worker modules, local workerd with Miniflare D1/R2 including restart, and loopback Chromium UI checks. Local fixtures provide independent synthetic credentials and storage. Passing these tests is not hosted resource isolation, real ad delivery, independent security approval or permission to publish to production.

The bootstrap's prior metadata separation result remains version-specific. Global authentication/rate-limit review, hosted CPU/budget behavior, real Prebid/site editing and production promotion remain outside this controlled synthetic admin test. Known dependency warnings are tracked in MBA-52.

Official build settings: https://developers.cloudflare.com/workers/ci-cd/builds/configuration/
Runtime Secrets: https://developers.cloudflare.com/workers/configuration/secrets/
