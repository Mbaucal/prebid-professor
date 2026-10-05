# Builtin package delivery v1 — TEST only

MBA-46. This stage adds `/deployments` to the isolated Tessera Worker: saved
package selection, nonsecret Pages target settings, deployment history, and
restoring an original previously verified package. It does not change the ads.js
engine version or regenerate the accepted Tanjug v1 ZIP.

The user confirmed manually installing ads.js on Tanjug. That is recorded as user
feedback, not fabricated Pages workflow evidence. The first automatic TEST
deployment was created on 2026-09-14; its initial verification failed at the Pages
HTML redirect and was subsequently verified without redeployment. PR44 then
delivered the compact script layout and proved a real full-archive restore and
compact-layout restore. See `docs/evidence/tanjug-compact-restore/README.md`.

## Connection required for the first real run

Configure the following **only after the TEST target has been identified**. Never
paste token values into the form, source control, comments, logs, or chat.

| Location | Name / setting | Purpose |
| --- | --- | --- |
| TEST Worker secret | `TEST_GITHUB_ACTIONS_TOKEN` | A token scoped to Actions write on `Mbaucal/prebid-professor`; sends the existing workflow dispatch. |
| TEST Worker secret | `TEST_DEPLOY_SECRET` | Dedicated random secret, at least 32 characters, for private package transfer and reporting. |
| GitHub repository Actions secret | `TESSERA_TEST_DEPLOY_SECRET` | Same dedicated transfer secret. Do not reuse the session or legacy callback secret. |
| GitHub repository Actions secret | `CLOUDFLARE_API_TOKEN` | Existing Cloudflare Pages token with access to the selected account. One secret can serve multiple publisher targets; suffixed names such as `CLOUDFLARE_API_TOKEN_TANJUG` remain supported. The UI stores only this name. |
| Tessera TEST → Objave | Account ID, Pages project, TEST branch, secret name | Nonsecret destination settings. A typical preview branch is `tessera-test`. |

The UI reports configuration presence, not proof that credentials are valid.
New targets default to the shared secret name `CLOUDFLARE_API_TOKEN`; existing
saved secret names are preserved. The saved account ID, Pages project and TEST
branch determine the destination independently of the secret's name.
It can save the target while connection secrets are absent. No credentials are
required to inspect the new page and its frozen Tanjug package selection.
Do not guess an account ID from a public `pages.dev` hostname.

## Delivery contract

### Publisher scripts layout

New TEST deliveries use the versioned `publisher-scripts-v1` layout. The private
accepted archive remains intact. Cloudflare receives these original source bytes:

| Public name | Archived source | Purpose |
| --- | --- | --- |
| `ads.js` | `ads.min.js` | Existing parser-minified wrapper, copied without reminifying |
| `prebid.js` | `prebid.js` | Original accepted Prebid build, when enabled |
| `_headers` | Versioned delivery policy | CORS `*`, nosniff, noindex, `public, max-age=0, must-revalidate` |

Config, source manifest, readable wrapper, CSV, styles and implementation examples
remain in the authenticated Tessera archive. The wrapper already injects sticky
styles; existing publisher placement CSS stays on the publisher's page. This
layout does not rewrite the site, its DOM IDs, existing script URLs, or saved
settings. Tanjug retains `https://tanjug.pages.dev/ads.js` and `/prebid.js` for a
later production promotion. The preview alias is separate.

The delivery descriptor pins its profile, source package SHA, public-to-source
file mapping and `_headers` SHA. Run identity includes the layout, so a compact
delivery of the same accepted source is a distinct version. The claim returns
that frozen descriptor; the runner reconstructs and checks it against the exact
cached ZIP. Success callbacks must match its delivery hash.

Old rows without a delivery descriptor retain `archive-v1`: all original files
and the original no-store header policy. Restore always uses the historical
layout and original ZIP, including when the source package hash is unchanged.
It never silently converts a historical full package into today's compact layout.

The new public verifier checks both the immutable deployment and the exact saved
preview alias: script bytes, MIME, CORS/nosniff/noindex, revalidation cache policy,
ETag/304, and absence of excluded source files. Full-archive restore checks all
its original bytes and headers at both URLs. The workflow retains separate
verification and reporting jobs, so report retries do not redeploy or rerun
successful byte checks.

References: [Pages cache and ETag behavior](https://developers.cloudflare.com/pages/configuration/serving-pages/),
[Pages `_headers`](https://developers.cloudflare.com/pages/configuration/headers/).
The chosen cache value is the Pages default, not a long browser TTL on a mutable
`ads.js` filename. TEST no-store was intentionally stricter than this policy.

### Existing source and authorization boundaries

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
- Wrangler delivers the original bytes selected by the frozen delivery layout
  plus its Pages `_headers`. The immutable deployment URL must belong to the
  selected project. Public files are read back at that URL and the preview alias,
  checking size, SHA-256, MIME, CORS, nosniff and the layout's cache policy.
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

Pages redirects `/implementation.html` to `/implementation`. Public verification
permits only one 301/308 hop to that exact path on the same immutable origin, then
checks the original HTML bytes and every delivery header. Redirects for other
assets, additional hops, query strings, foreign origins, private transfers and
provider APIs remain rejected. Read errors identify the affected filename.

Rerunning an old verification job also reruns its old code. When that code needs
repair, review a recipe in `ops/runtime-test/verify-existing.json` together with
its SHA-pinned original source metadata in `docs/evidence/`. Merging that recipe
to the TEST branch triggers `verify-existing-builtin-test.yml`. It confirms the
original GitHub deployment identity, rereads the exact cached private ZIP,
rechecks the actual Pages production branch, and verifies every public file at
the existing immutable URL. It has no deployment or claim operation.

The separate report job consumes that run's verification receipt, waits for the
same commit's TEST Worker build, and confirms the existing request using its
original run ID, commit and URL. Separate `verificationRunId`/`verificationCommit`
fields retain the new verifier's audit; history links to that verification run.
Final receipt metadata is immutable. If reporting fails, retry only the report
job. Failed verification leaves the existing uncertain state locked. Receipts
are retained in Actions for 90 days; preserve completed milestone evidence in
git/Linear rather than relying on expiring artifacts alone.

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

The target and secrets are now confirmed by real API calls and delivery:
account `6cb2ac6a0a1a0d8b8fc7f9db917cce3d`, project `tanjug`, TEST branch
`tessera-test`; Cloudflare confirmed production branch `main`. Original run
[34858629084](https://github.com/Mbaucal/prebid-professor/actions/runs/34858629084)
created `https://276a50d0.tanjug.pages.dev`. Original source artifact `10354340938`
is preserved in `docs/evidence/tanjug-test-v1-source.json`; the recovery recipe
pins both source JSON and original artifact archive hashes. Do not ask for the
secrets or create another deployment to recover this run.

Public verification completed on 2026-09-14 in
[34861322056](https://github.com/Mbaucal/prebid-professor/actions/runs/34861322056):
all 10 original files, delivery headers and actual preview branch passed. The
existing request was confirmed without redeployment. The first report returned
422; retrying only that report job succeeded. The successful original-byte receipt
was reused. Evidence is in `docs/evidence/tanjug-test-v1-public-verification.json`
and `docs/evidence/tanjug-test-v1-verification.md`.

PR44 acceptance completed on 2026-09-14: compact delivery run `34864698144`,
full-archive restore `34865064215`, compact restore `34865304443`. Every deploy,
verify and report job succeeded on its first attempt. Both historical layouts
were restored from the same unchanged accepted source archive. The final preview
is compact at `https://f9b56105.tanjug.pages.dev` and
`https://tessera-test.tanjug.pages.dev`. This proves changing and restoring the
delivery version; it does not claim a newly generated source configuration.

Remaining production work: implement a reviewed production promotion path for
the exact verified delivery, preserve the current live version for rollback, and
validate the selected Prebid build in the publisher's live context. The observed
production `ads.js` already matches the accepted minified bytes, but production
Prebid was **10.10.0**, while TEST is **11.34.0**. Earlier user confirmation of
working live ads is not proof that Prebid 11.34.0 was live. Existing builtin
staging guards and `completeRelease:false` remain intact; no production promotion
was performed. Previous accepted user tests must not be requested again.
