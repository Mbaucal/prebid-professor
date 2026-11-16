# Ads.txt versions

Ads.txt versions save immutable copies of the managed file before publishing.

## Operator workflow

1. Review the Managed ads.txt file.
2. Add an optional short note.
3. Click **Save current version**.
4. Open version history to preview, copy or download the saved file.
5. Use **Refresh status** after changing managed rows or when another browser tab saves a version.

Saving a version does not contact the publisher endpoint and does not change the live ads.txt file.

## Storage

- Version metadata is stored in D1.
- Exact file content is stored in R2 under a per-site version key.
- Each site has sequential version numbers.
- The same checksum can be saved only once per site, so repeated clicks do not create duplicate versions.
- Up to 50 recent versions are displayed in history.
- The server checks the current checksum against every saved version, including versions older than the visible 50-row history window.

## Safety

- The server generates the snapshot from the current managed rows; it does not trust file content supplied by the browser.
- The browser sends the checksum of the file the operator reviewed. If the managed file changes before Save is processed, the Worker rejects the request and asks the operator to refresh status.
- Version creation requires an authenticated same-origin request.
- The version file is immutable after creation.
- D1 metadata and the R2 object are cleaned up when creation fails before metadata is committed.
- If metadata was committed but the immediate response cannot reload it, the stored R2 object is retained and the operator can use **Refresh status**.
- Switching sites clears pending save and history actions so one site's state cannot remain active on another site.
- Audit log entries never contain the full ads.txt file.

## Future publishing

A later CMS publishing module will publish one selected immutable version rather than a changing draft. Verification and rollback will therefore refer to exact version IDs and checksums.

## MBA-20 review on current main

The existing PR #25 implementation (b3459768) is preserved and carried onto main
685d90b. The current builtin Worker remains the entrypoint; the versions wrapper
is inserted into its existing downstream chain. Mutation authorization uses the
current shared origin check directly, including rejection of `Origin: null`.

Automated SQLite/R2 tests reproduce missing-checksum 428 and stale-checksum 409
with zero snapshot puts or version inserts. A refreshed checksum saves once and
is deduplicated. A matching version outside the newest 50 is still found. These
results do not establish why the earlier manual second-tab test created Version 2.
The browser verifier records the checksum actually sent and tests the conflict
message while preserving the note, status failure/retry, and late list/save/export
responses across site changes (including A → B → A).

Site deletion first deletes snapshot files and only then cascades metadata. A
partial storage failure leaves the site and all version keys available for a
retry; some individual files may already have been removed. The final D1 batch
checks the append-only version count and absence of pending writes, so a new save
during cleanup blocks deletion instead of losing its key. Bind count is constant,
independent of history size.

A durable `ads_txt_version_intents` record is written before each R2 put. It has no
foreign key or cascade. Successful version registration and intent removal share
one D1 transaction. Failed saves become `cleanup` intents; keys are removed only
after confirmed R2 deletion. Retrying site deletion also drains cleanup intents,
including for a site whose row is already absent. A `writing` intent blocks site
deletion; a writing intent created during cleanup is checked again atomically
with the cascade. A lost response after committed registration does not delete
the successfully saved file.

This is not an atomic transaction across R2 and D1. Process interruption can leave
a durable `writing` intent. There is deliberately no time-based expiry or automatic
reaper: an operator must establish that the owning write has stopped, inspect the
version metadata/object, and resolve it through controlled recovery. Until then,
deletion fails closed and asks the user to contact support if the save remains
pending. No production data or endpoint is touched by these tests. Saving a
version still never publishes live ads.txt.

Reproduce locally after `npm ci` and `npm run build`:

- `node --experimental-strip-types --loader ./tests/support/ts-extension-loader.mjs --test tests/runtime/ads-txt-versions.test.mjs`
- `node scripts/prepare-layout-preview.mjs`
- `python scripts/verify-adstxt-versions.py` (Playwright Chromium; synthetic API)

Browser screenshots/results are written to `.generated/adstxt-version-evidence/`
at desktop 1440px and narrow 390px. Local checks do not establish hosted TEST,
production deployment, or cross-browser accessibility coverage.
