# Tessera ads.txt CMS/API connector

## Purpose

Tessera prepares an immutable ads.txt version, publishes it through a restricted publisher endpoint, verifies the public file, and can roll back to an earlier approved version.

The current implementation is a **sandbox simulation**. It writes only to a Tessera mock endpoint and never changes the publisher website.

## Workflow

1. Test the connection.
2. Prepare a complete ads.txt version from saved Tessera requirements.
3. Calculate the SHA-256 checksum.
4. Publish the approved version.
5. Verify the public `/ads.txt` checksum.
6. Roll back to a previous approved version when required.

## Recommended publisher endpoint

```http
PUT /internal/tessera/ads-txt
Authorization: Bearer <restricted-token>
Content-Type: application/json
```

Example request:

```json
{
  "siteId": "magazin-politika-rs",
  "domain": "magazin.politika.rs",
  "versionId": "ads-magazin-politika-rs-0007-a1b2c3d4",
  "checksum": "0f12ab34...",
  "content": "# Google\ngoogle.com, pub-123, DIRECT, f08c47fec0942fa0\n",
  "publishedAt": "2026-07-30T12:00:00.000Z"
}
```

Expected success response:

```json
{
  "ok": true,
  "siteId": "magazin-politika-rs",
  "versionId": "ads-magazin-politika-rs-0007-a1b2c3d4",
  "checksum": "0f12ab34...",
  "publishedAt": "2026-07-30T12:00:01.000Z"
}
```

## Optional read endpoint

A publisher may expose the current managed source or publication metadata:

```http
GET /internal/tessera/ads-txt
Authorization: Bearer <restricted-token>
```

Suggested response:

```json
{
  "ok": true,
  "versionId": "ads-magazin-politika-rs-0007-a1b2c3d4",
  "checksum": "0f12ab34...",
  "content": "complete ads.txt content"
}
```

Tessera still verifies the public `https://domain.example/ads.txt` after every publication. A successful private API response alone is not treated as proof that the public file changed.

## Publisher requirements

The publisher technical team should provide:

- staging and production endpoint URLs;
- authentication restricted only to ads.txt operations;
- permission to read and replace only the ads.txt resource;
- the accepted version ID and checksum in every successful response;
- cache-purge behaviour after publication;
- rollback support, or acceptance of a complete earlier version;
- confirmation of the current ads.txt source of truth so another CMS task cannot overwrite Tessera's version.

Tessera does not need access to the complete CMS, hosting account, database, or Cloudflare account.

## Authentication

The first real connector should support one of these modes:

1. Bearer token stored as a Cloudflare secret.
2. HMAC signature containing timestamp, body checksum, and site ID.

Credentials must never be returned to the browser, stored in GitHub, written to logs, or kept as plain text in D1.

## Suggested HTTP responses

- `200` or `201`: version accepted and published.
- `400`: invalid request body.
- `401` or `403`: authentication or permission failure.
- `409`: version conflict or stale publication attempt.
- `413`: ads.txt body is too large.
- `422`: ads.txt content failed validation.
- `500` or `503`: publisher CMS could not complete publication.

## Safety rules

- Only an explicitly approved immutable version may be published.
- Every test, publication, verification, failure, and rollback is written to the Tessera audit log.
- Tessera verifies the public ads.txt after publication.
- A failed verification must never be shown as a successful deployment.
- Rollback uses a previously approved complete version, never a partial patch.
