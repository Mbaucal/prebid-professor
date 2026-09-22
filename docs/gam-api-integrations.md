# GAM API integrations — MBA-85

The main navigation now has an independent **API integracije** tab. The same React panel is served at `/api-integrations` on the isolated TEST Worker and is linked from both the TEST home and site workspace.

## First release

GAM povezivanje is the first tab and opens by default. The JSON file picker works before server setup; it only selects a local file. The connect action stays disabled until the encryption Secret is configured. Proveri podešavanje rechecks server readiness without losing the selected file.

- Eight editable presets reproduce the supplied Colab definitions (26 child positions in the full selection), including 470×1080 branding.
- Group count, starting index, `{n}` patterns, pasted names, sizes, Fluid and descriptions can be edited. Custom templates are saved independently.
- Connect a service account to a selected GAM network. Connection verification calls `getCurrentNetwork`; it creates no inventory.
- Browse an existing parent, or prepare a new parent under the effective root. Explicit preview reads live inventory and returns new, existing and conflicting rows.
- A reviewed, actor/origin-bound plan expires after 15 minutes. Explicit create rechecks the connection and live inventory before any mutation.
- Each review permits one execution attempt; a repeated successful request returns the same saved result. An uncertain attempt needs a fresh read-only preview. Google creates run in batches of at most 20, up to 100 units per plan. Partial results identify unconfirmed rows.
- Immutable result records retain GAM IDs and full paths plus the user-entered site label. They do **not yet attach automatically to the existing Tessera site's local ad-unit records**. That is a follow-up within MBA-85; existing site configurations and runtime packages remain unchanged.
- History shows up to 100 saved results. The connection list and custom-template library are also limited to 100 in this first release.

## Credential setup

On the existing TEST Worker, add a new Cloudflare **Secret** named `GAM_CREDENTIALS_KEY`, with at least 32 random characters. Do not reuse a production, login or Gmail secret. Keep it stable: changing it without re-encrypting connections makes saved service-account keys unreadable. No secret value belongs in source, logs or this document.

The UI then accepts the user's existing service-account JSON. It validates the network before storing a reduced credential encrypted with AES-256-GCM, a fresh IV and the network code as additional authenticated data. Connection responses expose only network metadata and service-account email. JSON file text is transient in the submit handler and is never put in browser storage. The original file input is cleared after the connection attempt.

Enable API access in GAM and grant the service account inventory read/create permissions. Delegated domain-wide authentication and credential rotation/disconnect UI are not implemented in this first release.

GAM API operations target the **selected real GAM network**, even when the UI is on Tessera TEST. A TEST deployment alone cannot create ad units: the separate encryption Secret, an explicitly connected account and the in-product create action are required. The UI displays the exact network, parent and rows being created. Use a GAM test network for the first end-to-end check where available.

## Storage and API

All new records use private R2 keys under `api-integrations/gam/v1/`. No D1 schema change, seed import, runtime selection, release regeneration or publisher deployment is performed. The TEST route remains behind the existing exact-host, isolated-session and same-origin guards; the main route uses the existing application login and an explicit same-origin mutation check.

SOAP v202608 is used to preserve the supplied InventoryService workflow. Authentication uses a one-hour RS256 service-account assertion and the documented Ad Manager OAuth scope. Network/token endpoints are fixed in code; uploaded token URLs are ignored. Raw Google error bodies, keys and access tokens are never sent to the browser or logged.

The XML parser is vendored separately because the legacy runtime identity includes the root package lockfile. See `vendor/gam-xml-parser/README.md`; all prior runtime hashes and dependency pins remain intact.

## Validation

`node --test tests/gam/integrations.test.mjs` covers credential encryption, OAuth signatures, XML payloads, parent creation, ID/path persistence, replay/concurrency, stale previews, partial result recovery and templates using synthetic Google responses. `node --experimental-strip-types --test tests/gam/test-routes.test.mjs` exercises the real TEST host/session/Origin guards without network calls.

Build and local tests are not evidence of access to a real GAM network. A hosted deployment and an owner-provided connection must be verified separately.

The synthetic browser test (`python scripts/verify-gam-ui.py`) checks desktop/mobile layout, editable presets, saved templates, explicit review/create, resulting paths/history and the unconfigured connection state. It only talks to a local in-memory fixture and blocks external browser requests.

Sources consulted: [AdUnit v202608](https://developers.google.com/ad-manager/api/reference/v202608/InventoryService.AdUnit), [InventoryService](https://developers.google.com/ad-manager/api/reference/v202608/InventoryService), [GAM authentication](https://developers.google.com/ad-manager/api/authentication), [service-account OAuth2](https://developers.google.com/identity/protocols/oauth2/service-account).
