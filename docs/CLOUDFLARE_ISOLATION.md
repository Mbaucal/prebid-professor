# MBA-19 — Cloudflare isolation and continuation checkpoint

## Current checkpoint — owner-reported test storage, bootstrap deployment pending

The production baseline audit is complete. Marko then confirmed creating **prebid-professor-test-db** and **prebid-professor-test-builds**, and supplied D1 ID **d27843e4-a53c-403a-baed-04a193f6d5c6** on 11 September 2026. **Do not ask him to recreate these resources or provide this ID again.** These are owner-reported identities, not independent verification of new storage or test isolation.

`ops/tessera-isolation-plan.json` is a checkpoint/proposal, NOT a deploy configuration. It now records the supplied ID and separate owner-report/verification status. Its `provisioned:false` refers to the complete test Worker environment remaining undeployed/unverified; it does not deny the reported creation of D1/R2. No test version UUID or deployed URL is known yet.

The standalone bootstrap in **ops/test-worker** uses only the new test resources and serves a static notice and `/health`. It has no application imports, data reads/writes, cron, email or CMS. The production root Wrangler/Vite/application files are unchanged. A normal existing repository integration may build a main commit; merging preparation is not a test deployment and does not itself prove isolation.

Use the full dashboard instructions in [ops/test-worker/README.md](../ops/test-worker/README.md). On the current form **Advanced settings → Path** is the project/root directory: **ops/test-worker**. After PR #28 is actually merged, the default **main** branch contains the bootstrap. No branch-selector hunt is needed. Keep non-production builds off, use the explicit test build/deploy commands, and create a new build token instead of changing the existing Rei salon token or the read-only audit token. No runtime Secret is needed for this inert shell.

The unfinished built-in runtime PR #26 and Ads.txt versions PR #25 remain separate. The remote Save writer/application initialization is not enabled by this bootstrap. A healthy bootstrap endpoint does not establish D1/R2 ownership, availability or isolation.

## Completed production baseline — historical evidence, not a task to repeat

Actual Cloudflare metadata was read at **2026-09-11T21:06:11.487Z**, run **34647641518**, main **a490b021ab77626e2169f82832a1a50356eb35ce**. Evidence is retained in Linear MBA-19; artifact **10283225234** has limited retention.

- Production Worker: `prebid-professor`.
- Active deployment: `78861b13-7dbb-4aba-94b1-909db6d1145a`.
- Active version: `6d7c963b-a282-40de-80a5-c7e7e619ded7` at 100%.
- D1 ID: `7ef68f78-0fd8-4937-a774-d2fd1d5353e6`. Its name `prebid-professor-db` was separately shown in the owner screenshot.
- R2: `prebid-professor-builds`.

The audit intentionally compared production with itself, so `same_worker_as_production`, shared D1/R2, one cron and integration-review blockers were expected. This was not an authentication failure and not evidence about another preview Worker. Do not disable production cron, delete integrations or alter production bindings to get a green result. Do not repeat this self-audit as an operator task.

## Read-only audit access already set up

The owner created GitHub environment **tessera-isolation-audit**, limited to the **main** branch, and saved:

- Environment variable `CF_ACCOUNT_ID` for this Cloudflare account.
- Environment Secret `CLOUDFLARE_AUDIT_API_TOKEN`, a dedicated single-account Workers Scripts Read token.

The completed metadata run proves that those credentials worked for the read at that time, not that the token will never expire or that it has an independently verified permission inventory. No secret value was read or requested. The instructed lifetime was seven days; revoke the temporary token when the audit work is finished. Never broaden this token for deploy/provisioning or store its value in chat, Linear, source, inputs or screenshots.

The environment's main-only rule was observed, not independent reviewer approval. Administrators/main writers remain trusted. Repository visibility was later observed as public through GitHub metadata; earlier private-repository wording is not a guarantee. Do not change repository visibility or plan to obtain a control, and do not include sensitive data in reports.

## Next audit — the NEW test Worker only, after actual deployment

Once the bootstrap is deployed, obtain its full version UUID and URL from the real Cloudflare deployment. If the UUID is already known, directly run:

1. GitHub → Actions → **Cloudflare isolation audit** → **Run workflow**.
2. Branch **main**.
3. **operation = audit**.
4. **test_worker = prebid-professor-test**.
5. **test_version_id = the actual TEST deployment's full version UUID**.

**Override the historical workflow default `prebid-professor`; it is production.** Do not copy the production UUID above into a test audit. If discovery is necessary, run **operation=discover_versions**, **test_worker=prebid-professor-test** with an empty version field, then select the proven exact test version. No account-wide inventory or automatic newest-version selection is performed.

A successful discovery is not isolation evidence. The audit reads the currently active production deployment as a comparison baseline internally, the exact requested test version and test schedules, then rereads deployment/schedule metadata to reject drift. It compares D1 IDs/R2 names, including aliases and known production identities. Missing, ambiguous, inherited or extra bindings, cron and integrations require review.

The cron parser accepts the official `{ schedules: [] }` object and the supported direct-array variant. Missing/malformed schedules do not mean no cron. All requests are GET to api.cloudflare.com with redirects refused and bounded reads. No SQL rows, R2 file contents, publisher endpoints or Worker application requests are used; secret/plain-text/JSON binding values and raw API errors are not exported.

`resource_separation_observed` is point-in-time evidence only. `remoteWritesAuthorized:false` and `launchApproved:false` always remain. `blocked` means concrete policy/resource findings; `unverified` means insufficient evidence or failed reads. Both return exit 2. Retain exact mode, timestamp, Worker/version identities and result in MBA-19 and START HERE, not just the expiring artifact.

## Workflow security and evidence

Automatic PR/main jobs run synthetic tests without Cloudflare credentials. The credentialed job is manually dispatched on main and checks out the dispatched SHA with persisted Git credentials disabled. Never execute credentialed PR-head code or merge unfinished runtime PR #26 for this operation.

Reports are access-controlled GitHub Actions artifacts with seven-day retention, not a reason to publish secrets. The connector previously supported reads/retries but not initial workflow dispatch, so the owner may need to click Run workflow. Do not request a pasted token to work around a tooling limitation. CLI operation remains read-only; there is no provisioning/deploy mode in the audit tool.

## Remaining isolated platform gates

Do not recreate the reported test D1/R2. Confirm actual bootstrap deployment, exact test bindings and resource ownership/privacy first. Then review test-only schema initialization and minimal synthetic `.invalid` data, separate test authentication, no cron/outbound integrations and explicit Save/list/download boundaries. Legacy migrations contain seed data and must not be run blindly against an existing database. No production data or credentials may be copied.

A test-store flag or bootstrap 200 response is not isolation evidence, and test isolation is not authorization for live publisher publication. Record the actual test version and hostname before activating the test writer.

## Regression tests

```sh
node --test tests/cloudflare/*.test.mjs
```

The audit suites contain 48 original plus 36 contract/discovery tests. The bootstrap adds 19 static route/config tests and credential-free Wrangler dry-run compilation. CI must pass for the current head; these are offline checks, not a new hosted audit.

## Official contracts

- https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/list/
- https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/get/
- https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/list/
- https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/schedules/methods/get/
- https://developers.cloudflare.com/workers/ci-cd/builds/configuration/
- https://developers.cloudflare.com/workers/ci-cd/builds/build-branches/
- https://developers.cloudflare.com/workers/wrangler/environments/
- https://developers.cloudflare.com/workers/versions-and-deployments/preview-urls/
- https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments
- https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow
- https://developers.cloudflare.com/fundamentals/api/get-started/create-token/
