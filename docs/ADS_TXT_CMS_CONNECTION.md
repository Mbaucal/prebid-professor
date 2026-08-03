# Ads.txt CMS connection

This release stores the connection details required for a future direct ads.txt publishing workflow.

## Per-site fields

- Endpoint URL
- HTTP method: `POST` or `PUT`
- Authorization type: Bearer token, API key, or none
- Authorization header name
- Encrypted credential

The credential is never returned to the browser after saving. The UI receives only a `credentialSet` flag.

## Current safety boundary

Saving or removing connection settings does not publish or change a publisher ads.txt file. This release does not include Test connection, Publish, Verify, or Rollback actions.

## Publisher developer request

Ask for:

1. Endpoint URL that accepts the complete ads.txt file.
2. `POST` or `PUT`.
3. Authorization type and header name.
4. Token or API key through a secure channel.
5. HTTP `200` or `204` on success.

The public ads.txt URL is already configured per site in Tessera.

## Storage and security

- Settings are isolated by immutable site ID.
- Credentials are encrypted before D1 storage.
- `ADS_TXT_CONNECTOR_ENCRYPTION_KEY` is preferred; `GMAIL_TOKEN_ENCRYPTION_KEY` is accepted as a compatibility fallback.
- Save and delete actions require an authenticated same-origin request.
- Save and delete actions are written to the audit log without exposing the credential.
