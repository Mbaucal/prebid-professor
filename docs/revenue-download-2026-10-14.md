# Saved revenue package ZIP download

The hosted TEST user saved and reopened release
`builtin-draft-f7f8d43059e7b5917c2684a19c0875396f0fceab9702284b9284a13e49edbb39`
with runtime `3.16.0-revenue.preview.2`. Its verified inventory contains 12 files,
including `deals-plan.json` and `gam-reporting.json`. The browser download helper
still accepted at most 11 files and did not allow `deals-plan.json`, so it refused
this valid package before fetching any file. The server download route and saved
package verification did not exercise that browser helper.

The correction admits the existing revenue file and 12-file inventory while
retaining the filename allowlist, duplicate checks, byte limits, per-file hashes,
TEST package identity, and MAIN manifest validation. It changes the admin download
path only; existing saved packages, runtime pins, generated scripts and ZIP contents
are not regenerated or rewritten.

The regression suite exercises the actual browser helper and malformed inventories.
The existing consent-readiness workflow also exercises both hosted-style TEST UI
download controls against an isolated SQLite/R2 fixture at 1440 and 390 pixels,
including loading, failure and retry. All network requests are intercepted locally.

After TEST deployment, the operator can reload the TEST interface and download the
already saved release. No new script version or repeated Formats save is needed for
this correction. A completed browser download is separate from validating video
rendering, demand-partner activation, or live revenue.
