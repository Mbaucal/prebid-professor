# Tessera test Worker bootstrap — MBA-19

## What this is

A separate, temporary Worker shell. It does **not** import Tessera or access a database, bucket, secrets, email, CMS or ad network. `/` displays a setup notice; `/health` states `bootstrap_only` and keeps application/writes/publication flags false. All other routes and mutations are disabled. This allows the deployed Worker bindings to be audited before application initialization.

It is not the new generator UI and a 200 health response is not proof of resource ownership, D1/R2 availability or isolation. PR #26 remains a separate unfinished runtime change.

## Resource identities

- New Worker target: `prebid-professor-test` (hosted deployment not yet confirmed).
- Account: `b5e5e6f70b811e8f97af71df1af46308` (from the completed production audit).
- `DB`: `prebid-professor-test-db`, ID `d27843e4-a53c-403a-baed-04a193f6d5c6`.
- `BUILDS`: `prebid-professor-test-builds`.

Marko reported creating D1/R2 and supplied this database ID on 11 September 2026. These identities are also recorded in `../tessera-isolation-plan.json`. Do not ask him to create them or supply the ID again. Independent Cloudflare verification of the new storage and deployed test bindings remains pending. R2 must remain private.

Production `prebid-professor`, D1 `7ef68f78-0fd8-4937-a774-d2fd1d5353e6` and R2 `prebid-professor-builds` must not be reused or edited. The production baseline audit is already complete; do not repeat it as a user task.

## One-time dashboard setup — NEW Worker only

Use the existing repository `Mbaucal/prebid-professor`, NOT the public-repository clone flow. Create a NEW Worker named `prebid-professor-test`. Do not edit the production project's build settings. Stop if a Worker of that name already exists and its history is unknown.

The current Create application screen labels the project directory **Advanced settings → Path**. This is the **Root directory** setting discussed in the Workers Builds documentation; do not ask the operator to find a second field of that name.

After this standalone PR #28 is actually merged, use the default `main` branch. The bootstrap files must exist on main before clicking Deploy. The initial form may not expose a branch selector; no special branch is needed after the merge. The unfinished PR #26/#25 must not be merged for this setup.

| Dashboard field | Value |
| --- | --- |
| Repository | `Mbaucal/prebid-professor` |
| Project name | `prebid-professor-test` |
| Advanced settings → Path | `ops/test-worker` |
| Build command | `npm --prefix ../.. ci && node --test ../../tests/cloudflare/test-worker-bootstrap.test.mjs` |
| Deploy command | `npx --no-install wrangler deploy --config wrangler.jsonc` |
| Builds for non-production branches | Off |
| API token | Create new token for this Worker's builds |
| Build variables / runtime Secrets | None needed for this inert bootstrap |

Both commands run from **ops/test-worker**, not the repository root. The build installs the existing locked root tooling and runs the bootstrap checks; it does not run the application build. Deploy explicitly uses the local test Wrangler file. Never accept an automatic root Wrangler rewrite or default root `npm run build` / `npm run deploy` for this setup.

Cloudflare can create a build/deployment API token in the **API token → Create new token** option. This grants deployment access to Cloudflare Builds; it is not a runtime binding and is not the read-only audit token. Do not reuse or change the existing Rei salon build token, do not paste tokens into chat/source/Linear and do not broaden `CLOUDFLARE_AUDIT_API_TOKEN`. An unrelated token's email-routing warning is not evidence that this Worker has an email feature: this bootstrap has no email handler, binding or routing setup. Do not add unrelated email-routing permissions to an existing project's token to work around the warning.

## Audit AFTER the actual test deployment

Record the actual URL and full version UUID shown by Cloudflare. Do not infer a deployed URL from the project name. In **GitHub → Actions → Cloudflare isolation audit → Run workflow**, explicitly set:

| Input | Value |
| --- | --- |
| Branch | `main` |
| operation | `audit` |
| test_worker | `prebid-professor-test` |
| test_version_id | The full UUID of the version just deployed to the TEST Worker |

**Do not accept `test_worker=prebid-professor`: the historical workflow default names production.** This must be overridden for every test discovery/audit. If version discovery is needed, use `operation=discover_versions`, **test_worker=prebid-professor-test** and an empty version field. Then audit the proven exact test version. Do not repeat discovery/audit of production as a separate operator task.

The report must show D1 `d27843e4-a53c-403a-baed-04a193f6d5c6`, R2 `prebid-professor-test-builds`, no cron and no unexpected integrations. A resource-separation result does not authorize application writes or publisher deployment. Do not initialize schema/data before reviewing the report.

## Checks

`node --test tests/cloudflare/test-worker-bootstrap.test.mjs`

The 19 Node tests use Requests/Responses and deliberately inaccessible environment/context objects. They verify config identities and static, side-effect-free route behavior. Dedicated CI also runs Wrangler **--dry-run** compilation without Cloudflare credentials. These are not hosted deployment tests.

## Next application stage

After the exact deployed bindings and resource ownership are confirmed: reviewed test-only schema/seed and separate auth Secrets, then the PR #26 test application with only reviewed Save/list/read routes. No production data or secrets are copied. Preserve this no-access boundary until that stage. Test isolation is not authorization to publish a publisher wrapper.

Official references:
- https://developers.cloudflare.com/workers/ci-cd/builds/configuration/
- https://developers.cloudflare.com/workers/ci-cd/builds/build-branches/
- https://developers.cloudflare.com/workers/wrangler/configuration/
- https://developers.cloudflare.com/r2/buckets/public-buckets/
