# Managed ads.txt file

The managed ads.txt file is generated from the physical source rows saved in Tessera.

## What the operator can do

- Preview the complete generated file.
- Copy the complete file to the clipboard.
- Download it as `ads.txt`.
- Refresh the generated result after editing, deleting, importing or copying requirements.

None of these actions changes the public publisher ads.txt file.

## Output behavior

- Every saved physical row is included, including repeated canonical records.
- `VARIABLE=VALUE` declarations such as `OWNERDOMAIN=...` are preserved.
- Inline comments remain on their original rows.
- Explicit source labels are rendered as `#Source label` headings.
- Automatically inferred labels, such as an ad-system domain or variable name, are not repeated as artificial headings.
- Consecutive rows with the same explicit source label share one heading.

## Metadata

The API returns:

- physical row count;
- canonical record count;
- repeated-row count;
- generated line count;
- byte size;
- SHA-256 checksum for future publish/version verification.

## Safety boundary

The generated file is limited to 2 MB, matching the existing ads.txt fetch safety limit. The endpoint is read-only and requires an authenticated Tessera session.
