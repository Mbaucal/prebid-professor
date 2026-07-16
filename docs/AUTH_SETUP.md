# Prebid Professor admin login setup

The dashboard and admin API use three encrypted Cloudflare Worker secrets:

- `ADMIN_EMAIL` — one allowed administrator email, or multiple emails separated by commas.
- `ADMIN_PASSWORD` — minimum 12 characters. Use a unique password.
- `SESSION_SECRET` — minimum 32 characters. Use a randomly generated value.

Never commit these values to GitHub or place them in `wrangler.jsonc`.

## Cloudflare dashboard

Open the `prebid-professor` Worker, then go to **Settings → Variables and Secrets**. Add each variable as type **Secret**, then deploy the new version.

## Wrangler

From a local checkout of the repository, run each command and paste the value only when Wrangler prompts for it:

```bash
npx wrangler secret put ADMIN_EMAIL
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put SESSION_SECRET
```

A browser-console expression that generates a 96-character random session secret is:

```js
Array.from(
  crypto.getRandomValues(new Uint8Array(48)),
  byte => byte.toString(16).padStart(2, '0')
).join('')
```

Do not share the generated value.

## Verification

1. Open `/api/health` and confirm `"auth": "configured"`.
2. Open the dashboard in an Incognito/Private window.
3. Confirm that the dashboard redirects to `/login`.
4. Sign in with `ADMIN_EMAIL` and `ADMIN_PASSWORD`.
5. Confirm the signed-in email and logout control appear in the lower-left corner.
6. After logout, confirm the dashboard redirects back to `/login`.

Sessions use a signed, Secure, HttpOnly, SameSite=Strict cookie and expire after 24 hours. Changing `SESSION_SECRET` invalidates all existing sessions.
