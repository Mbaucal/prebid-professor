# Country signal v1 (MBA-25)

This is an independent country signal. It does not change CMP, Prebid, GPT,
bidder selection, refresh or any existing publisher package. The first consumer
in a generated ads runtime must be introduced as a new explicitly selected
runtime version after this foundation is verified.

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
`crossorigin="anonymous"`. It is optional and is not inserted into existing ads.js.

```js
// After the optional helper has loaded:
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
node scripts/bootstrap-toolchain.mjs --profile test
node --test tests/runtime/geo-country.test.mjs
node scripts/isolated-toolchain.mjs typecheck --profile test
node scripts/isolated-toolchain.mjs build --profile test
node scripts/isolated-toolchain.mjs test-build --profile test
TESSERA_TEST_TOOLCHAIN=isolated node scripts/verify-geo-country.mjs
TESSERA_TEST_TOOLCHAIN=isolated node scripts/verify-geo-country.mjs --workspace
node scripts/check-runtime-release-history.mjs origin/feature/isolated-runtime-workspace-v1
node scripts/isolated-toolchain.mjs test-deploy-check --profile test
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

The TEST integration uses the same route module from the separate workspace
entrypoint. `--workspace` checks the actual sealed TEST bundle, public metadata,
and the preserved anonymous 401 for private APIs using synthetic credentials.
Its evidence is `.generated/geo-evidence/workspace-results.json`. No hosted
storage or credentials are used by these local checks.

## Primary references

- [Cloudflare incoming request metadata](https://developers.cloudflare.com/workers/runtime-apis/request/#incomingrequestcfproperties)
- [Cloudflare country and special codes](https://developers.cloudflare.com/fundamentals/reference/http-headers/#cf-ipcountry)

Documentation reviewed 2026-11-09. Existing runtime source hashes, release records
and saved packages remain unchanged.
