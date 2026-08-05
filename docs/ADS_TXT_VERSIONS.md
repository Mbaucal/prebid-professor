# Ads.txt versions

Ads.txt versions save immutable copies of the managed file before publishing.

## Operator workflow

1. Review the Managed ads.txt file.
2. Add an optional short note.
3. Click **Save current version**.
4. Open version history to preview, copy or download the saved file.

Saving a version does not contact the publisher endpoint and does not change the live ads.txt file.

## Storage

- Version metadata is stored in D1.
- Exact file content is stored in R2 under a per-site version key.
- Each site has sequential version numbers.
- The same checksum can be saved only once per site, so repeated clicks do not create duplicate versions.
- Up to 50 recent versions are returned in the operator history.

## Safety

- The server generates the snapshot from the current managed rows; it does not trust file content supplied by the browser.
- Version creation requires an authenticated same-origin request.
- The version file is immutable after creation.
- D1 metadata and the R2 object are cleaned up when version creation fails.
- Audit log entries never contain the full ads.txt file.

## Future publishing

A later CMS publishing module will publish one selected immutable version rather than a changing draft. Verification and rollback will therefore refer to exact version IDs and checksums.
