# Isolated test workspace — MBA-53

This is a separate, initially disabled entrypoint built on PR #26. It reuses the approved generator, existing authentication primitives (with separate test credentials/session namespace) and immutable draft storage. It never imports/delegates to the production application router. This is NOT a production-ready release or all of Tessera's screens.

## Scope

A synthetic example.invalid site; GPT-only generation, optional approved TakeOver code, text-only preview, reviewed Save and verified historical ZIP download. No actual ad requests from the workspace. No CMS, email, publisher publish, delete, bulk upload, general site management or cron. The HTML inside a downloaded candidate is an implementation example which can request ads if separately served; do not install it live.

`POST /test-api/setup` is explicit, authenticated and same-origin. It accepts only an empty database, creates checksum-locked schema without the legacy publisher seeds, and creates one synthetic site as a single D1 batch. GET requests never initialize. Recognized schemas are reusable; other/nonempty databases are refused. Storage quota: 20 intents/packages, enforced by a SQL trigger including partial uploads. No automatic cleanup or destructive reset.

Generate performs no R2 write. It returns a 20-minute signed receipt binding the authenticated actor, origin, configuration, runtime, deterministic timestamp, TakeOver choice and exact package hash. Save accepts that receipt, not uploaded code/files, rechecks current settings and regenerates the same deterministic bytes for hash equality before using the existing idempotent store. Failed/uncertain storage remains tracked for retry. Historical reads return and verify saved bytes, not a new generation.

## Activation is NOT performed by this PR

The existing test bootstrap/main deployment stays unchanged. This branch must first pass the route, schema, storage, auth, browser and Worker compile checks. Review the generated schema and effective resources before enabling setup writes. The prior bootstrap audit is not a hosted test of this new entry.

For the later approved TEST deployment only: use this reviewed feature branch, root `ops/runtime-test`, build `npm --prefix ../.. ci --ignore-scripts && node ../../scripts/prepare-builtin-runtime.mjs && node ../../scripts/prepare-test-workspace.mjs`, deploy `npx --no-install wrangler deploy --config wrangler.jsonc`. Do not change production's root or branch. Non-production preview builds stay off.

Current config is intentionally disabled (`TEST_WORKSPACE_ENABLED=false`, `TEST_PUBLIC_ORIGIN` empty). Activation must explicitly set the confirmed exact HTTPS test origin and enable flag in the reviewed test config; the router accepts only prebid-professor-test.mbaucal.workers.dev, not production or version preview hosts. That allowlist is a deployment constraint, NOT evidence the URL was contacted/verified.

Separate runtime credentials: `TEST_ADMIN_EMAIL`, `TEST_ADMIN_PASSWORD` (at least 12 characters), `TEST_SESSION_SECRET` (random, at least 32 characters). Store secret values in the test Worker's Secrets only, never repository variables/chat/Linear. Do not reuse production ADMIN_PASSWORD or SESSION_SECRET. The existing read-only audit token is unrelated and remains read-only. Missing/wrong/disabled configuration fails before database access.

A later operator test signs in, explicitly prepares the empty test database once, generates, reviews/saves, repeats Save (one package), refreshes and reopens/downloads the same release. The current draft code does not authorize deployment or Marko testing yet. Do not repeat the already completed bootstrap/metadata setup.

Limitations: first workspace is fixed synthetic GPT-only, no Prebid upload, no general configuration editor, no production promotion. Authentication reuses the current signed-session implementation; global brute-force/rate-limit review and deployed CPU/storage behavior still need verification before activation beyond a controlled admin test. Test cookie is host-only and uses a test-specific signing namespace.

Official API contracts: https://developers.cloudflare.com/d1/worker-api/d1-database/ ; https://developers.cloudflare.com/d1/best-practices/read-replication/ ; https://developers.cloudflare.com/workers/configuration/secrets/ .
