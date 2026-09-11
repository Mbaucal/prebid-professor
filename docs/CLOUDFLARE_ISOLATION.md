# MBA-19 — Cloudflare isolation and continuation checkpoint

## Current verified boundary (11 September 2026)

The supplied Bindings screenshot shows `prebid-professor` with `DB → prebid-professor-db`, `BUILDS → prebid-professor-builds` and `ASSETS`. It does not identify the active version or PR #26's effective preview resources. The screenshot has already been supplied; do not ask Marko for the same screen again. A separate preview hostname does not establish separate data.

The built-in runtime is in draft PR #26, not main. Its stored-draft adapter is locally tested, but the remote Save route, live writer and migration are not enabled. Do not connect it to the current shared resources merely because its caller flag says test store.

`ops/tessera-isolation-plan.json` is a proposal, NOT a Wrangler deployment file. Its test Worker/database/bucket names have not been provisioned or verified. Null IDs must not be replaced with invented identifiers. Neither this change nor the audit modifies production bindings, application code, migrations, auth, cron or public routes.

## What this tooling actually does

`scripts/cloudflare/audit-isolation.mjs` reads only Cloudflare metadata using a dedicated read-only API token:

1. Read the production Worker's actively serving deployment (first in the deployments response).
2. Inspect every production version in the traffic split, not just one.
3. Read the exact requested test version's bindings and test Worker's cron schedules.
4. Reread production deployment and schedules; reject a changing snapshot.
5. Compare all D1 IDs/R2 names, including aliases, against current production and the repository's known production baseline. Require expected `DB`/`BUILDS` bindings and flag unknown/inherited resources, shared Worker, cron and integration bindings.

All requests are GET to `api.cloudflare.com`, redirects are refused, responses are size/time bounded. It does not read SQL rows, R2 file content, execute the Worker or call publisher URLs. Values of plain-text/JSON/secret bindings and API error bodies are never written into reports or logs. Resource identifiers are operational metadata and the report should stay in the project/private CI artifact.

Result `resource_separation_observed` is only point-in-time resource evidence. **remoteWritesAuthorized is always false.** It does not prove safe test data, credential separation, test hostname routing, lack of network side effects, backup, cleanup or permission to publish. `blocked` means a concrete resource/policy problem; `unverified` means insufficient evidence or a failed read. Both return exit code 2.

## Observed GitHub environment and protection limits

Marko supplied the environment configuration screenshot on 11 September 2026. It shows `tessera-isolation-audit`, **Selected branches and tags**, exactly one allowed branch `main`, zero tags, and a successful saved-rule banner. Environment secrets and variables are still empty in that screenshot. Required-reviewer controls are not shown. This is screenshot evidence, not an API or runner test of the environment's enforcement.

The previous instruction to require the owner as an environment reviewer must not be assumed available. GitHub documents that required reviewers for private repositories are not available on Free/Pro/Team. Do not change the repository's visibility or require a paid upgrade solely for this metadata audit.

For this limited read-only audit, the proposed setup uses the observed **main-only environment**, the existing **manual workflow_dispatch/main-only job**, a dedicated single-account Workers Scripts Read token and a **seven-day token lifetime**. This is not equivalent to independent reviewer approval: trusted repository administrators/main writers can change workflows and access an environment secret. Do not apply this exception to a deployment/write credential. When an approval gate is available and appropriate, add it separately without claiming it already exists.

## How to run safely

The PR tests run with synthetic responses and NO Cloudflare credentials. For an actual read, review/merge the standalone operations PR first; the workflow-dispatch job is deliberately restricted to main and is not available before the workflow exists on the default branch. This must not require merging unfinished runtime PR #26. Preparing the main-restricted environment settings is separate from authorizing a live run; do not execute credentialed PR-head code or select an unreviewed branch.

Use the existing GitHub environment **tessera-isolation-audit**, restricted to branch `main`. Store:

- environment variable `CF_ACCOUNT_ID`: the verified Cloudflare account ID;
- environment Secret `CLOUDFLARE_AUDIT_API_TOKEN`: a new token limited to **Account → Workers Scripts → Read** for that specific account, expiring in seven days.

### Operator setup

1. In the correct Cloudflare account, use dashboard Search (`Cmd/Ctrl+K`) → `Copy account ID`. This is not a Zone ID, D1 ID or email address. In GitHub's existing environment choose **Add environment variable**, Name `CF_ACCOUNT_ID`, Value the copied account ID.
2. In Cloudflare choose **My Profile → API Tokens → Create Token → Create Custom Token**. Name it `Tessera isolation audit`. Set only **Account → Workers Scripts → Read**. Under Account Resources choose **Include → Specific account** and the account that contains `prebid-professor`. Set expiry seven days from creation. Review the summary before creating it.
3. Copy the token directly into GitHub's **Add environment secret**, Name `CLOUDFLARE_AUDIT_API_TOKEN`. The value is only the token, without a `Bearer ` prefix. Do not put it under variables or repository-wide secrets.
4. Confirm completion without sharing the token or an unmasked screenshot. Creation/storage is not yet verified merely because these instructions were supplied. After the reviewed audit, revoke the temporary token when it is no longer needed.

No Workers Edit, D1 Edit, R2 write, global API key, Gmail token or administrator password is required for the audit. Never paste the token into chat, Linear, issue comments or workflow inputs. Do not repurpose an existing production deployment credential. Read access remains sensitive; it is not permission-free access to the account.

Only after the operations PR is reviewed and merged, run **Actions → Cloudflare isolation audit → Run workflow** on main, supplying the actual test Worker script name and its complete version UUID from Cloudflare. The same Worker name may be inspected to diagnose today's preview, but that deliberately yields a blocker for the proposed separate-Worker test policy. Do not substitute a branch name, short version prefix or guessed hostname for a version UUID.

The sanitized report is retained as a private repository Actions artifact for 7 days. Copy its important resource identities, date/version and result to MBA-19 and the Linear continuation document; do not rely solely on expiring artifacts. Raw API responses must not be uploaded.

A developer can also run the CLI in their own environment with `CF_ACCOUNT_ID`, `CLOUDFLARE_AUDIT_API_TOKEN`, `CF_TEST_WORKER` and `CF_TEST_VERSION_ID` set locally. The CLI has no provisioning/deploy mode. Missing credentials return `unverified` before a network call.

## What is still needed for an isolated test platform

If no separate test environment exists, create new resources using the proposal after ownership/name checks. Do not replace production bindings or copy production DB/R2/Secrets. Start with synthetic test rows, separate login Secrets, no cron, no integration tokens and no custom public routes. Initialization must be schema-only and reviewed; the legacy migrations include seed data and should not be run blindly against an existing database.

Then bind/deploy the explicit reviewed candidate in that isolated Worker, record its exact version/URL, run the metadata check, validate data/auth/outbound protections and only then connect the reviewed Save/list/download API/UI. Actual cloud account creation requires authorized account access not supplied by this tooling. The current connector directory did not provide a Cloudflare app; no live inventory/provisioning was performed when this change was authored.

## Tests

```sh
node --test tests/cloudflare/isolation-audit.test.mjs
```

The 48 synthetic tests cover traffic splits, alias/shared storage, missing/ambiguous fields, drift, unknown bindings, cron, input validation, output sanitization, API failures and size limits. This is not a hosted Cloudflare audit or a production security certification. The subsequent environment-setup documentation edit does not add new test results.

## Official contracts consulted

- https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/list/ — first deployment is actively serving traffic.
- https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/get/ — exact version resource bindings, Workers Scripts Read.
- https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/schedules/methods/get/ — cron metadata.
- https://developers.cloudflare.com/workers/wrangler/environments/ — environment bindings must be explicitly configured.
- https://developers.cloudflare.com/workers/versions-and-deployments/preview-urls/ — version/alias URLs are not a separate storage policy.
- https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments — environment secrets, branch rules and private-repository reviewer limitations.
- https://developers.cloudflare.com/fundamentals/api/get-started/create-token/ — permissions, account resources, TTL and handling the generated token.
- https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/ — copy the correct account ID.
