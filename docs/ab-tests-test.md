# A/B tests on TEST (MBA-416 P2)

An A/B test compares two saved versions of the TEST site (`test-site`). Each visitor gets version A or version B. A saved test never changes. This page covers the TEST line only. MAIN gets the same panel and API in a later step (P4a).

## Where it is

- The **A/B tests** panel is inside **Generate and releases** (`/site-workspace#packages`), below Saved versions.
- The TEST home page has an **A/B tests** button after **Bid caching**. It opens `/site-workspace#ab-tests`, which shows Generate and releases with the panel scrolled into view.
- Generate now calls its text field **Version name** (it was "What changed?", and "Version note" on the TEST home page). The name is what the A/B panel shows for each saved version. It can have up to 160 characters.

The panel offers the stored drafts of `test-site` (newest first, at most 20). There is no production version on TEST, so the panel says: "This site has no production version on TEST. Choose A yourself: use the version your test page runs now."

The test name, the TestId and both version names are published inside `/ads.js`. Do not use private notes there.

## Routes

All routes are under `/test-api/ab-tests`. They pass the existing TEST gates first, unchanged: the TEST host, the method allow-list, same-origin for every request that is not GET, and the session (JSON 401). Then the schema must be ready, or the answer is 409 "Prepare TEST data first.". A query string is 400 "Unknown query." (only `GET /` takes `cursor=`). An unknown sub-path is the workspace 404. An unknown method on a known path is 405.

The routes do not check that the TEST site settings are in a consistent state. Saved tests stay readable while settings are mid-edit, and the composer reads only saved bytes, never the live settings.

| Method and path | Body | Answer |
|---|---|---|
| `GET /` | none | 200 `{supported, site, testOnly, defaults:{trafficBPercent:50}, proposedTestId, current:null, versions, tests, deleted, nextCursor:null, limits:{tests:100, name:60}}`. `tests` and `deleted` are the complete lists. |
| `POST /check` | `{a, b}`; `name`, `testId` and `trafficBPercent` are accepted and ignored, so the form posts one body | 200 with the compatibility result and `arms`. A refusal is also 200, with `compatible:false`. This is the dry run. |
| `POST /` | `{name, testId, a, b, trafficBPercent}` | 201 `{created:true, record, recordSha256}`, or 200 `{created:false, record, recordSha256, deletedAt}` for a test saved before |
| `GET /<abx>` | none | 200 `{record, recordSha256, deletedAt, events}` |
| `GET /<abx>/download` | none | the stored ZIP, `ab-<testId>-<last 8 of abx>.zip`, with `x-package-sha256` |
| `GET /<abx>/record` | none | the exact stored record bytes, `ab-<testId>-<last 8 of abx>.json`, with `x-record-sha256` |
| `DELETE /<abx>` | `{confirmId, sha256}` | 200 `{ok, id, deleted:true}`: moves the test to Deleted A/B tests |
| `PUT /<abx>` | `{confirmId, sha256}` | 200 `{ok, id, deleted:false}`: restores it |
| `POST /<abx>/events` | `{type}`, `marked-live` or `marked-stopped` | 201 `{event}` |

`a` and `b` are saved draft ids (`builtin-draft-<64 hex>`). The same id twice is an A/A check. Bodies are JSON of at most 4 KB: 415 without JSON, 413 when larger, 400 for invalid JSON and 422 for an unknown field. `confirmId` is the abx id and `sha256` is the ZIP sha256. Every error body is `{error, code?, check?}`. An unexpected failure is 503 "The A/B test could not be verified. Nothing was changed. Retry.".

Error codes in plain words:

- 400 `invalid-request`: a missing or malformed field ("Choose a saved version for A and B.", a name of 1 to 60 characters, a TestId of 1 to 24 lowercase letters, digits or underscores, a whole number from 0 to 100 for B traffic). A name with line breaks, tabs or other control characters is also 400.
- 422 with `code` and `check`: the two versions cannot be compared (site, Prebid, layout files, GAM path, consent).
- 422 `package-missing`: "Version A is no longer in Saved versions. Choose another saved version. Saved A/B tests keep their own copies." On `/check` this is a 200 refusal. Another read error is 503 "Version A could not be read. Nothing was saved. Retry."
- 422 `bundle-too-large`: a file over 8 MB, all files over 12 MB, or the ZIP over 13 MB (the same limits as TEST delivery).
- 422 `names-too-long`: the list summary would be over 1800 bytes. Version names are cut to fit, so this names the test name: "The test name is too long to store. Shorten the test name and try again." No name the API accepts reaches it today.
- 409 `testid-taken`: the TestId belongs to another test on this site.
- 409 `limit`: the lifetime cap (below).
- 409 `record-unverified` or "ZIP differs from its record.": stored bytes do not match. Nothing is changed.

## Wording on TEST

The shared composer says "under Releases" in two refusals. The TEST mount rewrites that to "under Generate and releases" in the `error` and `refusal.message` of `POST /check` and `POST /` (`testAbMessage` in `worker/test-workspace/site-workspace.mjs`). The shared file stays unchanged. TEST pages never show "Config →" or "Releases →".

## R2 keys

Everything is in the existing `BUILDS` bucket, under `site-experiments/v1/test-site/`. There is no D1 table, no new binding and no new variable. Every write is create-only (`If-None-Match: *`), carries its sha256 and `cache-control: private, no-store`, and is read back and checked.

| Key | Body | customMetadata |
|---|---|---|
| `records/<abx>.json` | the record | `{kind:'ab-test-record', sha256, summary}` |
| `files/<abx>/<path>` | each bundle file | `{kind:'ab-bundle-file', sha256}` |
| `zips/<abx>.zip` | the exact bundle ZIP | `{kind:'ab-bundle-zip', sha256, zipByteSize}` |
| `test-ids/<testId>.json` | `{schemaVersion:1, site, testId, id}` | `{kind:'ab-test-id', sha256}` |
| `deleted/<abx>.json` | trash marker (`worker/site-runtime/saved-package-trash.mjs`) | that module's format |
| `events/<abx>/<nnnn>.json` | `{schemaVersion:1, id, seq, type, at, by}`, `nnnn` from 0001 to 0050 | `{kind:'ab-test-event', sha256}` |

None of these keys is under `publishers/test-site/releases/`. **Delete all generated packages** therefore never removes A/B tests. A test keeps its own copy of both scripts, so it stays listed and downloadable after its versions are gone. The panel then tags the version "no longer in Saved versions".

## Record and summary

The record is the composer's record (`composeAbBundle().record`, schema `tessera-ab-test-1`, layout `publisher-ab-v1`) with `createdBy` (the signed-in email) and `createdAt` (ISO time). Nothing else is added. `recordSha256` is the sha256 of the stored bytes. It is returned by the API and is not a delivery identity.

The abx id is `abx-` + sha256 of the test identity: schema, layout, site, name, TestId, B traffic, both arms, Prebid, loader and the file list without `ads.js`. `createdBy`, `createdAt`, the ZIP and the derived compatibility result are left out.

A record is accepted on read only when the schema and site match, the key id equals `record.id`, the id is the hash of its identity, the bytes match `customMetadata.sha256`, and the summary equals the one computed from the record. Otherwise the answer is 409 `record-unverified`.

The **summary** in `customMetadata.summary` is what the list shows. It has exactly: `id`, `name`, `testId`, `trafficBPercent`, `createdAt`, `createdBy`, `zipSha256`, `prebidVersion`, `fileCount`, and `arms:{A,B}` with `release`, `runtimeVersion` and `name`. Each arm name is cut to at most 150 bytes of JSON-escaped UTF-8 (a control character counts six bytes) on a code-point boundary, with "…" when cut. The full names stay in the record. The summary must fit in 1800 bytes (R2 allows 2 KB of metadata), or the create is refused with `names-too-long` before anything is stored.

## Lifetime cap of 100

A TEST site can store at most 100 A/B tests over its whole lifetime. Deleted tests still count, because their bytes are kept. The 101st create gets 409: "This TEST site has reached its lifetime limit of 100 A/B tests. Deleted tests still count, because their bytes are kept." The count follows the R2 cursor across pages. Two creates at the same moment can overshoot by one or two. Every listing follows the cursor, so no record is hidden.

## Creating a test, idempotency and TestId reservation

Everything that can refuse runs before the first write, and the record is written last:

1. Read A and B (once for A/A) and compose the bundle.
2. Check the sizes and the summary length.
3. If the record already exists and verifies, return it with `created:false` and write nothing. The same inputs always give the same abx id and the same bytes, so saving twice never makes a duplicate. If the saved test is in the trash, the panel says to restore it there.
4. Check the lifetime cap.
5. Claim the TestId: write `test-ids/<testId>.json` create-only and read it back. If it names another abx, refuse with `testid-taken`.
6. Write each bundle file, then the ZIP, then the record. The record is the commit point.

A TestId is unique per site and is never released, not even by Delete. GAM reports therefore never mix two tests. The panel proposes the next free `test_site_<n>` (`test_site_1` first). After step 5, only an R2 failure can stop a create (503). A retry with the same body reuses the claim and the stored bytes.

## Events: Mark live and Mark stopped

Mark live and Mark stopped record when the owner says the test went live or stopped. They change no files. P3 will read this window for measurement.

- The first event must be `marked-live`. Each new event must differ from the previous one.
- At most 50 events per test. A deleted test takes no events; restore it first.
- Each event is a numbered create-only key. Two clicks at the same moment give one 201 and one 409 "Someone else changed this test. Reload A/B tests."

## What the ZIP holds

| Path | What it is |
|---|---|
| `_headers` | `Access-Control-Allow-Origin: *`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store` and `X-Robots-Tag: noindex` for every path (`shared/pages/headers.mjs`) |
| `ads.js` | the A/B loader 1.0.1 with this test's settings |
| `prebid.js` | the Prebid.js file both versions share (left out when both are GAM only) |
| `r/<version id>/ads.js` | the exact saved `ads.min.js` of each version; one file for A/A |

The loader picks A or B at random with the saved B share. It loads the arm script with its SHA-384 integrity value and `crossorigin="anonymous"`. It puts the page-level keys `Variant` (`A` or `B`) and `TestId` in the GPT command queue, so the first ad request carries them. If the arm fails to load, it loads A once as a fallback.

## Deliver by hand: download the ZIP and upload it to Pages

Delivery in this PR is by ZIP download only. The panel says: "Download the ZIP and upload all of its files, unchanged, as one Pages deployment."

1. In the panel, use **Download A/B ZIP**. The panel checks the bytes against the saved sha256 before it saves the file. **Download test record** saves the record the same way.
2. Unzip it. Keep every file and path as it is, including `_headers` and the `r/` folder.
3. In Cloudflare, open a test-only Pages project for `test-site` and upload all files as one deployment (Direct Upload). Use a preview branch. Never use the Tanjug project or its `tessera-test` branch: two TEST copies cannot share a target. Never use a live publisher project.
4. On a TEST page (not a live publisher page), load `prebid.js` (if the ZIP has one) and then the loader from the deployment's origin, as normal script tags: `<script src="https://<deployment>/prebid.js"></script>` and `<script async src="https://<deployment>/ads.js"></script>`. Remove any other Tessera `ads.js` tag from that page.

## Hosted check

These steps are for the owner after merge. Nothing in this PR deploys.

1. `https://<deployment>/ads.js` answers 200, starts with `/* tessera-ab-loader 1.0.1 */`, and has the headers from `_headers` (`access-control-allow-origin: *`, `cache-control: no-store`).
2. `https://<deployment>/r/<version id>/ads.js` answers 200 for each arm, with `access-control-allow-origin: *`. In the network panel the arm request is a CORS request, and the browser accepts it with its SRI integrity value (no integrity error in the console).
3. Open the TEST page with the network panel. The first GAM request (`securepubads.g.doubleclick.net/gampad/ads`) carries `Variant=A` or `Variant=B` and `TestId=<testId>` in its `cust_params`. Reload a few times to see both groups.
4. For QA, add `?tessera_ab=A` or `?tessera_ab=B` to the page URL. The loader then loads that version and sets no `Variant` or `TestId`, so QA pageviews are not counted. `AdVariant.inspect()` in the console shows the variant, the status (`forced`) and the loaded script.
5. In GAM, add the key `Variant` with the values `A` and `B` and the key `TestId` with the test's value, and turn on reporting for both. The panel's **GAM setup checklist** lists the same steps. GAM does not report traffic from before this setup.
6. Use **Mark live** when the page starts to load the loader, and **Mark stopped** when it stops.

## Not in this PR

- **Delivery through the TEST deployments page** (`/deployments`, the `publisher-ab-v1` source in the TEST runner) is a later step. It needs its own Pages target for `test-site` (account, project and branch). `test-site` has none yet, and it cannot share the Tanjug target.
- P3: the count endpoint, loader 1.1.0, GAM CSV import, sample ratio checks and the measurement view.
- P4a: the same panel and API on MAIN (`/api/publishers/<id>/ab-tests`). P4b: direct production publish.

## Verifiers and CI

All checks are local and synthetic. They use the real TEST Worker, local SQLite or Miniflare D1, and a memory R2 or Miniflare R2. They make no external network calls. Passing them is not a hosted check.

| Check | What it covers | Where it runs |
|---|---|---|
| `tests/runtime/ab-store.test.mjs` | the key set, record and summary checks, idempotency (0 writes), concurrent creates, the TestId race, size caps, `names-too-long` before any write, the lifetime cap across pages, 102 listed records, tampering, trash and restore, event order and races, paging, and `PAGES_HEADERS` equality | test-workspace.yml `workspace`, step "A/B test store, the shared A/B tests API, its TEST routes …" |
| `tests/runtime/ab-tests-api.test.mjs` | the route table on memory R2 with plain-word 400, 404, 405, 413, 415 and 422 bodies, a `/check` refusal as 200, `package-missing`, and a control character in the name | same step |
| `tests/runtime/ab-tests-test-workspace.test.mjs` | the real TEST Worker through `worker.fetch`: 401, 403 cross-site, 405, 400 query, 409 before setup, create and download with `x-package-sha256`, a removed version, the list while site settings are mid-edit, and the TEST wording | same step; site-editor-checks.yml `editor`, step "A/B tests of the TEST site through the TEST Worker …" |
| `tests/runtime/ab-tests-wording.test.mjs` | Version name, the home page link, the panel sentences, `runtime.css` unchanged, and no `role="status"` on `runtime-message` or `runtime-error` | the same two steps |
| `scripts/verify-ab-tests-workerd.mjs` with `scripts/ab-tests-line.mjs` | the sealed TEST Worker on local workerd: ZIP, ids and every file equal a direct compose, the loader template hash equals the registry, no serialized function without canonical text, the same bytes after a restart, R2 keys inside the site prefixes, and no `api.cloudflare.com` in the bundle. Writes `.generated/ab-tests-workerd/report.json`. | test-workspace.yml `generation-parity`, step "A/B tests from the sealed Worker on LOCAL workerd …" |
| `scripts/verify-ab-tests-ui.py` with `scripts/site-workspace-browser-fixture.mjs --ab-tests --cleanup` | Chromium at 1280 and 390 px: the `#ab-tests` link, the no-production note, `test_site_1`, a refused pair, a compatible pair, save twice, a taken TestId with values kept, A/A, ZIP and record downloads, Mark live and stopped, Delete and Restore, cleanup with the tag, a 160-character name, no horizontal scroll, and the loading and failed-load states. Screenshots go to `.generated/ab-tests-ui/`. | site-editor-checks.yml `editor`, step "A/B tests panel in Generate and releases …" |

The A/B loader itself is covered by `tests/runtime/ab-loader.test.mjs`, `tests/runtime/ab-bundle.test.mjs` and `scripts/verify-ab-loader-browser.py` (test-workspace.yml, step "Generic A/B loader and bundle …").

## Files shared with MAIN (P4a baseline)

These files are meant to be byte-identical on both lines. P4a carries them to MAIN in one commit and adds a pinned blob-hash check. Blob hashes at this PR's head (`git rev-parse HEAD:<file>`):

| File | Blob |
|---|---|
| `worker/experiments/ab-store.mjs` | `894ac74` |
| `worker/experiments/ab-tests-api.mjs` | `f9d0020` |
| `worker/experiments/ab-bundle.mjs` | `71fecf1` |
| `shared/pages/headers.mjs` | `31ef2a6` |
| `src/components/AbTestsPanel.tsx` | `218b0f0` |
| `src/components/ab-tests.css` | `8fa4372` |
| `tests/support/memory-r2.mjs` | `3ce0be2` |
| `tests/support/ab-synthetic-drafts.mjs` | `3653ea4` |
| `tests/runtime/ab-store.test.mjs` | `3680613` |
| `tests/runtime/ab-tests-api.test.mjs` | `facad88` |
| `scripts/verify-ab-tests-workerd.mjs` | `2222386` |
| `scripts/verify-ab-tests-ui.py` | `868b9f2` |
| `tests/support/test-workspace-store.mjs` | `0381eaf` (main and this PR's base: `74e52b0`) |

`scripts/ab-tests-line.mjs` is the TEST line adapter and differs on MAIN on purpose. The delivery files (`delivery-layout.mjs`, `deployment-contract.mjs`, `deployments.mjs`, `deployment-page.mjs`, `scripts/builtin-test-delivery.mjs`, `scripts/publisher-delivery-verification.mjs`, `tests/support/deployment-store.mjs`, `scripts/deployment-ui-server.mjs`) are not changed by this PR.
