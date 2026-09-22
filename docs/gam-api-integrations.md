# GAM API integrations — MBA-85

The main navigation now has an independent **API integracije** tab. The same React panel is served at `/api-integrations` on the isolated TEST Worker and is linked from both the TEST home and site workspace.

## First release

GAM povezivanje is the first tab and opens by default. The JSON file picker works before server setup; it only selects a local file. The connect action stays disabled until the encryption Secret is configured. Proveri podešavanje rechecks server readiness without losing the selected file.

- Eight editable presets retain 26 child positions. MBA-91 updates their sizes from the supplied 7 responsive maps, including the shared Branding_Map; stored custom templates keep their own sizes.
- Group count, starting index, `{n}` patterns, pasted names, sizes, Fluid and descriptions can be edited. Custom templates are saved independently.
- Connect a service account to a selected GAM network. Connection verification calls `getCurrentNetwork`; it creates no inventory.
- Browse an existing parent, or prepare a new parent under the effective root. Explicit preview reads live inventory and returns new, existing and conflicting rows.
- A reviewed, actor/origin-bound plan expires after 15 minutes. Explicit create rechecks the connection and live inventory before any mutation.
- Each review permits one execution attempt; a repeated successful request returns the same saved result. An uncertain attempt needs a fresh read-only preview. Google creates run in batches of at most 20, up to 100 units per plan. Partial results identify unconfirmed rows.
- Immutable result records retain GAM IDs, sizes and full paths. MBA-91 adds an explicitly selected Tessera site, automatic additive local sync after confirmed GAM creation, and reviewed local recovery/history attachment. Existing configuration and published runtime packages remain unchanged. See `gam-site-inventory.md`.
- History shows up to 100 saved results. The connection list and custom-template library are also limited to 100 in this first release.

## Credential setup

Each Worker needs its own Cloudflare **Secret** named `GAM_CREDENTIALS_KEY`, with at least 32 random characters: `prebid-professor-test` for TEST and `prebid-professor` for production. Generate independent values; do not reuse a login or Gmail secret. Keep each value stable: changing it without re-encrypting connections makes saved service-account keys unreadable. No secret value belongs in source, logs or this document.

Production uses its existing `prebid-professor-builds` R2 bucket. TEST connections, custom templates and history are not copied into production. After production setup, open **API integracije → GAM povezivanje** and connect the same service-account JSON again. Inventory already created in GAM is visible in a new preview of that network.

The UI then accepts the user's existing service-account JSON. It validates the network before storing a reduced credential encrypted with AES-256-GCM, a fresh IV and the network code as additional authenticated data. Connection responses expose only network metadata and service-account email. JSON file text is transient in the submit handler and is never put in browser storage. The original file input is cleared after the connection attempt.

Enable API access in GAM and grant the service account inventory read/create permissions. Delegated domain-wide authentication and credential rotation/disconnect UI are not implemented in this first release.

GAM API operations target the **selected real GAM network**, even when the UI is on Tessera TEST. A TEST deployment alone cannot create ad units: the separate encryption Secret, an explicitly connected account and the in-product create action are required. The UI displays the exact network, parent and rows being created. Use a GAM test network for the first end-to-end check where available.

## Storage and API

GAM jobs and immutable results use private R2 keys under `api-integrations/gam/v1/`. MBA-91 additionally writes new local ad units/maps and an atomic ID/path receipt to existing D1 inventory/audit tables. No D1 schema change, seed import, runtime selection, release regeneration or publisher deployment is performed. The TEST route remains behind the existing exact-host, isolated-session and same-origin guards; the main route uses the existing application login and an explicit same-origin mutation check.

SOAP v202608 is used to preserve the supplied InventoryService workflow. Authentication uses a one-hour RS256 service-account assertion and the documented Ad Manager OAuth scope. Network/token endpoints are fixed in code; uploaded token URLs are ignored. Raw Google error bodies, keys and access tokens are never sent to the browser or logged.

The XML parser is vendored separately because the legacy runtime identity includes the root package lockfile. See `vendor/gam-xml-parser/README.md`; all prior runtime hashes and dependency pins remain intact.

## Validation

`node --test tests/gam/integrations.test.mjs` covers credential encryption, OAuth signatures, XML payloads, parent creation, ID/path persistence, replay/concurrency, stale previews, partial result recovery and templates using synthetic Google responses. `node --experimental-strip-types --test tests/gam/test-routes.test.mjs` exercises the real TEST host/session/Origin guards without network calls.

Build and local tests are not evidence of access to a real GAM network. A hosted deployment and an owner-provided connection must be verified separately.

The synthetic browser test (`python scripts/verify-gam-ui.py`) checks desktop/mobile layout, editable presets, saved templates, explicit review/create, resulting paths/history and the unconfigured connection state. It only talks to a local in-memory fixture and blocks external browser requests.

`node scripts/verify-gam-workerd.mjs` runs the actual Wrangler-compiled TEST Worker in local workerd with native fetch, a freshly generated synthetic RSA key and local OAuth/SOAP responses. It checks authentication, signed OAuth, network verification, encrypted R2 persistence, saved-credential inventory reads, rejected redirects and sanitized Google failures. No Google requests leave this test.

The first live connection attempt exposed two runtime incompatibilities missed by injected-fetch tests: workerd rejects `redirect: 'error'` before sending, and native `fetch` stored on `GamClient` receives the wrong `this` receiver. The adapter now uses `manual` with explicit 3xx rejection and a wrapper around native fetch. Redirects never forward the assertion or bearer token to another destination. On 2026-09-22 the owner confirmed a successful real GAM test and provided a screenshot of active `Billboard1` (ID `23377927393`) under parent `test` in network `22038436483` (`direktno.rs`), including Fluid. The owner explicitly approved promotion to `main`.

`node scripts/verify-gam-workerd.mjs dist/prebid_professor production` additionally exercises the actual production build locally: its login/session boundary, same-origin guard, configured status, OAuth/SOAP transport and encrypted persistence. All credentials and Google responses are synthetic.

Sources consulted: [AdUnit v202608](https://developers.google.com/ad-manager/api/reference/v202608/InventoryService.AdUnit), [InventoryService](https://developers.google.com/ad-manager/api/reference/v202608/InventoryService), [GAM authentication](https://developers.google.com/ad-manager/api/authentication), [service-account OAuth2](https://developers.google.com/identity/protocols/oauth2/service-account).
