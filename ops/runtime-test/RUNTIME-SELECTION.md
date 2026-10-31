# Site runtime selection — MBA-54

This is a server-side module for the next settings editor, not a newly enabled
screen. The existing hosted synthetic workspace and its validated ZIP are
unchanged. No migration, test-storage reset, runtime template upload, new secret,
production data import or deployment is required for this module's tests.

## Implemented contract

`prepareSiteRuntimeSelection` receives a trusted saved-site snapshot including
current Prebid rows, a code-owned runtime catalog, an expected full snapshot
revision, and an explicit selection. It returns a **proposal**, not a saved
configuration. It only changes `enablePrebid` and `builtinRuntimeSelection` in a
copy of `config_json`; unrelated settings are retained. `configJson` is internal
server data and must not be sent wholesale to the browser or written to logs.

The selection is an exact runtime ID/version/engine hash/schema/capabilities pin.
Preview requires explicit opt-in. There is no latest/Stable/Preview alias
resolution. Only real bundled descriptors should be offered by the eventual UI;
multiple synthetic descriptors in unit tests do not add real runtime versions.

When Prebid is enabled, the selected ID must match exactly one current build for
this site. Existing `inspectPrebidArtifact` checks the stored upload checksum,
version, declared modules and requirements derived by `previewInput` and
`prebidRequirements`. The 8 MB candidate limit applies before reading the body.
This first step does not support selecting archived builds or uploading new ones.
The proposal records exact Prebid ID/version/hash/size/modules. GPT-only neither
reads nor deletes Prebid storage and explicitly uses a null pin.

`readPinnedSiteRuntime` re-resolves a previously saved selection. Unknown or
changed runtimes and replaced current Prebid IDs/bytes/modules are conflicts,
not silent upgrades. It returns the same inspected Prebid bytes for the existing
candidate builder. Every generation must call it from an authenticated route
with a fresh server-read snapshot. Unpinned legacy configs require an explicit
selection; historical releases keep using `readDraftRelease`, never regeneration.

Both calls only inspect the caller-supplied snapshot and the explicit read-only
bucket interface. They do not prove hosted isolation, write to D1/R2, fetch a URL,
execute Prebid, authenticate a browser, or authorize publication. A valid header
is a declaration, not proof that adapters are registered or ads will be served.

## Required next integration

1. Add an authenticated, same-origin test-settings route/editor using existing
   isolation and schema guards. Do not accept a browser-provided catalog/snapshot.
2. Re-read and atomically compare the full reviewed revision when applying a
   proposal; the comparison in this planner is NOT a concurrent-write lock.
   Preserve existing test data and immutable saved release files.
3. Read the saved exact pin during Generate and bind settings/runtime/Prebid
   identity to the existing review receipt and Save path; check drift again.
4. Add controlled test-only Prebid upload/selection and tests of complete settings
   save, two-tab conflict, Generate/Save/reopen/download, then hosted owner testing.
5. Keep the existing deployed synthetic guard until this full integration is
   reviewed. Do not merely remove the GPT-only/site guard to call it integrated.

For now: no action for Marko, no repeat setup/audit/ZIP request, and no live
feature merge. Track the actual commit and CI result in MBA-54 and START HERE.
