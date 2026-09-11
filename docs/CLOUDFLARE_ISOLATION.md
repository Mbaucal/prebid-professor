# MBA-19 — Cloudflare isolation and continuation checkpoint

## Verified boundary (11 September 2026)

The supplied Bindings screenshot shows `prebid-professor` with `DB → prebid-professor-db`, `BUILDS → prebid-professor-builds` and `ASSETS`. It does not identify the active version or PR #26's effective preview resources. Do not ask Marko for the same screenshot again. A separate preview hostname does not establish separate data.

The built-in runtime remains in draft PR #26. Its stored-draft adapter is locally tested, but the remote Save route, writer and migration are not enabled. This operations PR does not change application/Worker code, Wrangler, dependencies, migrations, cron, auth, bindings or public routes. A normal repository integration may build a main commit, but this tooling never issues a deployment command.

`ops/tessera-isolation-plan.json` is a proposal, NOT a Wrangler file. Test names/IDs/URL are not provisioned or verified. Never replace null IDs with guessed values or clone production credentials/data to test resources.

## User setup completed; live access not yet verified

The environment screenshot shows `tessera-isolation-audit`, Selected branches and tags, one branch `main`, zero tags and a saved-rule banner. Required-reviewer controls are not shown. Do not change the private repository's visibility/plan to obtain this control.

For this limited metadata read, use the observed main-only environment, manual `workflow_dispatch` on main, and a dedicated single-account Workers Scripts Read token with a seven-day lifetime. This is not independent reviewer approval: administrators/main writers remain trusted. It is not a model for write/deployment credentials.

Marko subsequently confirmed that both values below were saved. This is a user report, not proof of successful token authentication, exact permissions or environment enforcement. Do not read or request their secret values.

- Environment variable `CF_ACCOUNT_ID`: the correct Cloudflare account ID, not Zone/D1 ID or email.
- Environment Secret `CLOUDFLARE_AUDIT_API_TOKEN`: a separate Account → Workers Scripts → Read token for that specific account. Store the token only, without `Bearer `.

No Workers Edit, D1 Edit, R2 write, global API key, production deploy credential or Gmail/admin password is needed. Revoke the temporary token after use. Never send it through chat, Linear, PR comments, workflow inputs or screenshots.

## First run — obtain real version IDs without copying screenshots

After this reviewed operations PR is on main:

1. GitHub → Actions → Cloudflare isolation audit → Run workflow.
2. Branch: `main`.
3. Operation: `discover_versions`.
4. Worker: `prebid-professor` (the actual Worker already shown by Marko).
5. Leave `test_version_id` empty and run.

Discovery uses GET requests for that Worker's active deployment, the first page of its version list, then its deployment again to reject drift. It exports only version UUIDs, version numbers, normalized dates and explicit preview/traffic flags. It never copies author details, annotations, raw bindings or credentials. It is NOT an account-wide inventory and does NOT choose the latest version as the test target.

A green `versions_discovered` means the list was read. `isolationChecked:false`, `completeVersionInventory:false`, `remoteWritesAuthorized:false` and `launchApproved:false` remain explicit. It does not establish that PR #26 is deployed, that a preview hostname routes to a particular version or that storage is isolated. Use a proven exact target in the second step; do not infer one merely from recency. If the intended version is absent from the first page, obtain its exact identity separately.

## Second run — exact-version isolation audit

Run the same workflow on main with Operation `audit`, the exact test Worker script name and full Cloudflare version UUID. Branch names, short version prefixes and hostnames are not version UUIDs. An audit of a version on `prebid-professor` itself is allowed for diagnosis but intentionally reports the same-Worker policy blocker; it is not a separate test environment.

The audit:

1. Reads the production Worker's active deployment and all its weighted versions.
2. Reads the exact requested test version's resource bindings and that Worker's cron schedules.
3. Rereads production deployment and test schedules to reject drift.
4. Compares every D1 ID and R2 name, including aliases and the repository's known production baseline. Missing/ambiguous/inherited/additional resources, cron and integration bindings require review.

The cron parser preserves the official `{ schedules: [] }` result shape and additionally accepts the direct-array variant raised in review. Only this endpoint accepts both forms; missing or malformed schedules never mean an empty list. This is compatibility hardening, not evidence of which form the user's account currently returns.

All requests are GET to api.cloudflare.com, redirects are refused and response reads are bounded. No SQL rows, R2 object contents, publisher endpoints or Worker application requests are used. Plain-text/JSON/Secret binding values and raw API errors are never emitted.

`resource_separation_observed` is only point-in-time resource evidence. `remoteWritesAuthorized:false` and `launchApproved:false` ALWAYS remain. `blocked` means concrete resource/policy issues; `unverified` means insufficient evidence or a failed read. Both return exit code 2. Discovery and audit are separate modes, not interchangeable approvals.

## Workflow security and evidence

The PR/main automatic jobs run synthetic tests without Cloudflare credentials. The credentialed job is manual, main-only, and checks out the exact dispatched SHA with persisted Git credentials disabled. Never run credentialed PR-head code. Unfinished runtime PR #26 does not need to be merged for this operation.

Reports remain private repository Actions artifacts for seven days. Copy relevant identities, mode, date/version and result into MBA-19 and the Linear START HERE document; do not rely on expiring artifacts alone. Do not upload raw API responses. A successful local/offline test is not a hosted audit.

The currently available GitHub connector supports run reads/retries but has no workflow-dispatch action. The owner may need to click Run workflow once; no token should be pasted to compensate for that limitation.

CLI: set `CF_AUDIT_OPERATION` to `discover_versions` or `audit` and the environment values above locally. Audit additionally requires `CF_TEST_VERSION_ID`. Missing credentials or unknown operations return unverified before network calls. There is no provisioning/deploy mode.

## Remaining isolated platform gates

If separate resources do not exist, provision new test Worker/D1/private R2 after ownership/name checks. Do not replace production bindings. Use schema-only reviewed initialization and synthetic rows, separate test login Secrets, no cron or integration tokens and no custom public routes. Legacy migrations contain seed data and must not run blindly against an existing database.

Record the exact deployed test version and hostname, run the exact audit, verify safe test data/auth/outbound behavior and backup/cleanup, then connect only reviewed authenticated Save/list/download routes. The caller's test-store flag is not isolation evidence. Direct Cloudflare provisioning has not occurred.

## Regression tests

```sh
node --test tests/cloudflare/*.test.mjs
```

The original 48 synthetic tests are retained. The additional contract/discovery suite contains 36 tests, executed locally with no real Cloudflare access. CI must verify the combined suite for the exact head before merge. Tests cover both cron shapes, malformed results, drift, sanitization, no automatic version selection and explicit audit UUID requirements.

## Official contracts consulted

- https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/list/
- https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/get/
- https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/list/
- https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/schedules/methods/get/
- https://developers.cloudflare.com/workers/wrangler/environments/
- https://developers.cloudflare.com/workers/versions-and-deployments/preview-urls/
- https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments
- https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow
- https://developers.cloudflare.com/fundamentals/api/get-started/create-token/
