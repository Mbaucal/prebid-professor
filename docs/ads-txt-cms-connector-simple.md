# Ads.txt CMS connector — minimal integration

The AdOps user should request only these details from the publisher developer:

1. **Endpoint URL** — an API URL that accepts and replaces the complete ads.txt file.
2. **HTTP method** — `POST` or `PUT`.
3. **Authorization** — Bearer token or API key, including the required header name.
4. **Success status** — confirmation that a successful update returns HTTP `200` or `204`.

A staging endpoint is useful but optional.

Tessera already knows the public ads.txt URL from the site's **Ads.txt URL** field. The AdOps user does not need to ask the publisher for it again.

Tessera is responsible for:

- building and sending the complete ads.txt file;
- keeping approved versions;
- verifying the configured public ads.txt URL after publication;
- restoring an older version by sending that complete file again;
- calculating checksums internally;
- recording publication and verification results.

Advanced items such as custom JSON responses, HMAC, IP allowlisting, cache purge rules, special timeouts, or a separate rollback endpoint are not part of the initial request. They are handled only when the publisher developer says their endpoint requires them.

## Copyable developer message

```text
Subject: Ads.txt API connection

Hello,

We want to connect Tessera to your CMS so it can replace the complete ads.txt file.

Please send us:
1. The API endpoint URL that accepts and replaces the complete ads.txt file.
2. Whether the endpoint uses POST or PUT.
3. The authorization method and header name, for example Bearer token or API key.
4. Confirmation that a successful update returns HTTP 200 or 204.

If you have a staging endpoint, please send it as well.

We do not need access to your CMS admin panel, hosting account, or server. The access credential should be limited only to ads.txt updates. Please send the credential through a secure channel, not by email.
```
