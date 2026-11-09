# Country signal v1 (MBA-25)

This is an independent country signal. It does not change CMP, Prebid, GPT,
bidder selection, refresh or any existing publisher package. Runtime 3.18.0 adds
the lookup to newly generated scripts only after an explicit version selection.
Older selected versions and previously saved packages remain unchanged.

## Public endpoints

- `GET /geo/v1/country`: `{version:1,status:"known",country:"RS",source:"cloudflare"}`.
  Missing, malformed or special Cloudflare codes (`XX`, `T1`) yield
  `{version:1,status:"unknown",country:null,source:"cloudflare"}`.
- `GET /geo/v1/client.js`: optional, self-contained browser helper. Loading it
  starts one background lookup and exposes `window.__AD_GEO`.
- Both support HEAD and OPTIONS; other methods return 405. Query parameters
  return 400. No authentication, cookies, database writes or outbound services
  are involved. Only the incoming `request.cf.country` is read. Headers, query,
  browser language, timezone and GPS are not country sources.

Responses are non-cacheable at browser and CDN layers. JSON CORS permits
credential-free cross-origin callers. The response never includes IP addresses,
city, coordinates or other `request.cf` metadata. The application adds no country
logging or persistent storage; ordinary Cloudflare operational logging remains
subject to the host's existing configuration.

Country represents the network exit location, including VPN/proxy exits. It is
not proof of residence or a consent decision. ISO alpha-2 codes and the commonly
used geolocation code XK are supported; no region/GDPR policy is inferred.

## Shared browser API

Load the helper from the verified deployment origin with an async script and
`crossorigin="anonymous"`. Existing scripts do not gain it automatically. Runtime
3.18.0 embeds the same helper directly in ads.js; no separate helper tag is needed.

```js
// After ads.js 3.18.0 (or the optional helper) has loaded:
console.table([window.__AD_GEO.getSnapshot()]);
window.__AD_GEO.ready().then(result => console.table([result]));
```

`getSnapshot()` is synchronous. `ready()` always resolves and all consumers share
the same promise. Results have `version`, `status` (pending/known/unknown),
`country` (two-letter code or null), `source`, `reason` and `elapsedMs`.
The factory also exposes idle before it is started; the served helper starts it
immediately. A terminal result is frozen and never replaced by a late response.

The fetch and body share a 1500ms deadline. Requests omit credentials and referrer,
disable cache and reject redirects. Unsupported fetch, timeout, HTTP error,
network failure, malformed JSON or an incompatible protocol settle to unknown.
There are no retries, persistent caches, cookies or localStorage. A repeated
helper load reuses the existing global and never starts another lookup. An
existing unrelated `__AD_GEO` property is preserved rather than overwritten.

The result lasts for this document, including a restored document. Changing VPN
or connection requires a new page load to obtain a new result. Future consumers
must use their existing/default behavior while pending or unknown; they must
not await GEO before starting ads or treat a known country as consent.

## Verification

```sh
node scripts/bootstrap-toolchain.mjs
node --test tests/runtime/geo-country.test.mjs
npm run typecheck
npm run build
TESSERA_TEST_TOOLCHAIN=isolated node scripts/verify-geo-country.mjs
node scripts/check-runtime-release-history.mjs origin/main
npm run deploy:dry-run
```

The compiled check exercises the actual Worker routes and evaluates the exact
helper emitted by the built Worker. Its injected RS/DE/AT/unknown/Tor fixtures
are synthetic; they are not geographic end-user measurements. It also verifies
anonymous metadata access, preserved authentication for private settings, one
lookup per document and isolation between documents. All outbound requests are
forbidden. Evidence: `.generated/geo-evidence/compiled-results.json`.

Hosted acceptance must separately verify the real edge country, no-store/CORS
headers, emitted helper, and unknown/failure behavior. Different real locations
or VPN exits are a later geography check; a single hosted call does not prove
global geolocation accuracy. TEST precedes production activation.

## Primary references

- [Cloudflare incoming request metadata](https://developers.cloudflare.com/workers/runtime-apis/request/#incomingrequestcfproperties)
- [Cloudflare country and special codes](https://developers.cloudflare.com/fundamentals/reference/http-headers/#cf-ipcountry)

Documentation reviewed 2026-11-09. Existing runtime source hashes, release records
and saved packages remain unchanged.

## Generated runtime 3.18.0

Choose 3.18.0 in Script setup, save, and generate a new package. Country lookup
starts in an isolated block before the inherited 3.17 ad runtime and never delays
that runtime. No new targeting keys, bidder filters, consent policy, responsive
map rule or refresh policy are derived from the result. The existing CMP still
decides when ads may start.

All package-generation routes choose the endpoint from server-owned environment
context: MAIN uses `https://prebid-professor.mbaucal.workers.dev/geo/v1/country`;
TEST uses `https://prebid-professor-test.mbaucal.workers.dev/geo/v1/country`. The
selected endpoint is included in config.json and README.txt. Sites with a CSP
need the corresponding origin in connect-src. A blocked call returns unknown.

Automated runtime and package checks:

```sh
node scripts/prepare-builtin-runtime.mjs
node scripts/prepare-test-workspace.mjs
node --experimental-strip-types --experimental-loader ./tests/support/ts-extension-loader.mjs --test tests/runtime/geo-runtime.test.mjs tests/runtime/geo-package-routes.test.mjs
node scripts/prepare-geo-runtime-fixtures.mjs
python scripts/verify-geo-runtime.py
python scripts/verify-geo-runtime-ui.py
```

The 88 full-script cases cover readable/minified, GAM/Prebid and desktop/mobile
output, known/unknown countries, deadline and failure paths, existing globals,
CMP waiting and later refresh. They intercept all network calls and use synthetic
demand. The admin test saves an explicit version and checks the downloaded ZIP.
The route regression checks all TEST generation paths, MAIN default, refusal of
client endpoint overrides and byte-preservation of an older saved ZIP.

Manual hosted probe (TEST endpoint only, synthetic ads, no paid traffic):
`python scripts/verify-geo-hosted.py --test`. This is opt-in, not CI. Its recorded
result must be inspected; a completed probe with unknown/network-error does not
prove a successful live lookup.
