# Tessera test Worker bootstrap — MBA-19

## What this is

A separate, temporary Worker shell. It does **not** import Tessera or access a database, bucket, secrets, email, CMS or ad network. `/` displays a setup notice; `/health` states `bootstrap_only` and keeps application/writes/publication flags false. All other routes and mutations are disabled. This allows the deployed Worker bindings to be audited before application initialization.

It is not the new generator UI and a 200 health response is not proof of resource ownership, D1/R2 availability or isolation. PR #26 remains a separate unfinished runtime change.

## Resource identities

- New Worker target: `prebid-professor-test` (not confirmed created).
- Account: `b5e5e6f70b811e8f97af71df1af46308` (from the previous successful audit job).
- `DB`: `prebid-professor-test-db`, ID `d27843e4-a53c-403a-baed-04a193f6d5c6`.
- `BUILDS`: `prebid-professor-test-builds`.

Marko reported creating D1/R2 and supplied this database ID on 11 September 2026. No Cloudflare API has independently verified these new resources yet. R2 must remain private; binding it to a Worker does not require public bucket access.

Production `prebid-professor`, D1 `7ef68f78-0fd8-4937-a774-d2fd1d5353e6` and R2 `prebid-professor-builds` must not be reused or edited. The production baseline audit is already complete; do not repeat it as a user task.

## Deployment settings for a NEW Worker only

Review this PR and its tests first. Use Cloudflare Workers Builds with repository `Mbaucal/prebid-professor` and Worker name `prebid-professor-test`. Stop if that Worker already exists and its ownership/history is unclear. Do not edit the existing production project's build settings.

Set **Root directory** to `ops/test-worker`, so the project's default Wrangler file is the test config rather than the production config. Use these explicit commands from that directory:

- Build: `npm --prefix ../.. ci && node --test ../../tests/cloudflare/test-worker-bootstrap.test.mjs`
- Deploy: `npx --no-install wrangler deploy --config wrangler.jsonc`
- Branch: the reviewed branch containing these files; use `main` only after this standalone PR is actually merged.

For this first setup, do not enable non-production-branch preview builds. Do not accept a default root `npm run build` / `npm run deploy` configuration or an automatic root Wrangler rewrite. This bootstrap is a standalone Worker, **not** a Vite build. It has its own explicit config and imports no application files.

Deployment needs Cloudflare's authorized build/deployment access. The existing `CLOUDFLARE_AUDIT_API_TOKEN` is read-only and must not be repurposed or broadened. Do not put API tokens or runtime passwords in workflow inputs, source, chat or Linear. No runtime Secret is needed for this data-inert bootstrap; separate test authentication comes with the application stage.

Obtain the actual deployment/version ID and URL from Cloudflare after creation. Do not infer a live URL from the proposed Worker name. Audit **that exact test Worker version** with the existing main-only audit workflow. The audit must report the new database ID, the new bucket, no cron and no integrations. Keep the bucket private. Do not initialize schema or data before reviewing that report.

## Checks

`node --test tests/cloudflare/test-worker-bootstrap.test.mjs`

The Node tests use Requests/Responses and deliberately inaccessible environment/context objects. They verify config identities and static, side-effect-free route behavior. The dedicated CI also runs a Wrangler **dry-run** compile with no Cloudflare secret. These are not hosted deployment tests.

## Next application stage

After the exact deployed bindings and resource ownership are confirmed: prepare a reviewed test-only schema/seed and separate auth Secrets, connect the PR #26 test entry/build to these resources, and then activate only reviewed test Save/list/read routes. Preserve this no-access boundary until that stage. No production data or secrets are copied. Test isolation is not authorization to publish a publisher wrapper.

Official references:
- https://developers.cloudflare.com/workers/ci-cd/builds/configuration/
- https://developers.cloudflare.com/workers/wrangler/configuration/
- https://developers.cloudflare.com/r2/buckets/public-buckets/
