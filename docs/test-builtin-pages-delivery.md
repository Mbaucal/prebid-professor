# Builtin package delivery v1 — TEST only

MBA-46. This stage adds `/deployments` to the isolated Tessera Worker: saved
package selection, nonsecret Pages target settings, deployment history, and
restoring an original previously verified package. It does not change the ads.js
engine version or regenerate the accepted Tanjug v1 ZIP.

The user confirmed manually installing ads.js on Tanjug. That is recorded as user
feedback, not fabricated Pages workflow evidence. There are initially no automatic
deployment rows and no previous automatic version to restore.

## Connection required for the first real run

Configure the following **only after the TEST target has been identified**. Never
paste token values into the form, source control, comments, logs, or chat.

| Location | Name / setting | Purpose |
| --- | --- | --- |
| TEST Worker secret | `TEST_GITHUB_ACTIONS_TOKEN` | A token scoped to Actions write on `Mbaucal/prebid-professor`; sends the existing workflow dispatch. |
| TEST Worker secret | `TEST_DEPLOY_SECRET` | Dedicated random secret, at least 32 characters, for private package transfer and reporting. |
| GitHub repository Actions secret | `TESSERA_TEST_DEPLOY_SECRET` | Same dedicated transfer secret. Do not reuse the session or legacy callback secret. |
| GitHub repository Actions secret | e.g. `CLOUDFLARE_API_TOKEN_TANJUG` | Scoped Cloudflare Pages token for the explicitly selected target account. The UI stores only this name. |
| Tessera TEST → Objave | Account ID, Pages project, TEST branch, secret name | Nonsecret destination settings. A typical preview branch is `tessera-test`. |

The UI reports configuration presence, not proof that credentials are valid.
It can save the target while connection secrets are absent. No credentials are
required to inspect the new page and its frozen Tanjug package selection.
Do not guess an account ID from a public `pages.dev` hostname.

## Delivery contract

- Existing `deploy-pages-release.yml` dispatch inputs are retained unchanged.
  Correlation IDs beginning `builtin-test-` call `deploy-builtin-test.yml` at the
  same commit. This reuses the workflow already registered on the default branch
  while dispatching **only** `feature/isolated-runtime-workspace-v1`.
- Both Worker and runner pin the repository, TEST origin, source/callback routes,
  staging channel, site, target, release ID and manifest hash. The runner validates
  these before reading credentials. Legacy draft-publication guards are retained.
- Browser writes require the existing exact TEST boundary, signed-in user,
  same-origin JSON, and the reviewed ledger revision. Only the precise runner
  routes use a separate bearer credential. That credential cannot bypass the
  outer TEST deployment/binding boundary.
- Sources are the frozen Tanjug v1 ZIP or original stored `test-site` builtin
  packages. The complete file inventory and original Prebid declarations are
  verified, copied to an immutable private ZIP cache and verified again by the
  runner. ZIP expansion and every file are size bounded. JavaScript is not
  executed during source validation.
- R2 `test-deployments/v1/state.json` is the single conditional-write authority.
  `If-None-Match` creates it and `If-Match` updates the quoted ETag. No D1 schema
  changes, database setup, source mutation, bucket listing or deletion occurs.
  The first 100 attempts are retained; reaching the bound blocks new attempts
  rather than discarding history. Original ZIPs use a separate immutable prefix.
- A job claims its frozen request once. The actual target Pages project and its
  current production branch are fetched from Cloudflare before Wrangler runs.
  A matching production branch is refused, even when named something unexpected.
  Both legacy and builtin jobs share account/project/branch concurrency.
- Wrangler delivers all original files plus Pages `_headers`. The immutable
  deployment URL must belong to the selected project. All package files are read
  back and checked for exact size, SHA-256, MIME, CORS, nosniff and no-store.
  The source manifest remains `completeRelease:false`; it is never relabeled as
  a production release.
- Restoring creates a new deployment request for the selected previous successful
  package on the same account/project/branch. It reuses every cached original byte
  and retains the version being replaced. It does not rerun the generator.

## Status and recovery

`queued` → `running` → `success` after public verification. A provider failure
before the Wrangler step is `failed` and permits a new reviewed request. A lost
dispatch response is `dispatch_unknown`; an attempted deployment without complete
public proof is `unverified`. Those states preserve the lock and the last verified
version. They must not be treated as evidence that nothing was deployed.

Verification and reporting are separate jobs with 14-day source/public metadata
artifacts. A failed report can be retried by rerunning **that report job** without
deploying again. A failed verification can rerun verification and then report;
an unverified result can become success only for the same claimed run and URL.
The deploy job cannot claim a request twice, including GitHub workflow reruns.

If a run was cancelled, a dispatch outcome cannot be found, or metadata artifacts
expired, inspect GitHub and the target's actual Pages deployment before any
operator reconciliation. There is intentionally no browser button that clears an
uncertain lock. Recovery must establish the original run, target and immutable
URL, verify its original bytes, and report with the dedicated runner credential;
it must not silently resubmit or overwrite the last verified record.

## Verification and remaining acceptance

New focused tests cover CAS races, stale tabs, missing/wrong credentials, exact
source/target identity, claim-once, ambiguous dispatch, immutable complete restore,
pre-deploy branch checks, callback retries and authentication boundaries. A local
compiled-workerd check exercises actual Miniflare R2 conditions and restart.
Chromium covers the new setup, explicit connection explanation, queued status,
version history and phone layout with synthetic jobs and all network pinned to
loopback. These are not live A→B evidence.

Still required before MBA-46 can be Done: an approved target account/project and
connected secrets, a real staging run with public byte/header evidence, a second
approved package and a real complete restore. No production promotion is included
in this stage. Previous accepted Prebid/template/Tanjug user tests are not requested
again; the existing repository CI remains a required gate.
