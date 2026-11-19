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

Each Worker needs its own Cloudflare **Secret** named `GAM_CREDENTIALS_KEY`, with at least 32 random characters: `prebid-professor-test` for TEST and `prebid-professor` for production. Generate independent values; do not reuse a login or Gmail secret. Keep each value stable: changing it without re-encrypting connections makes saved service-account keys unreadable. No secret value belongs in source, logs or this document.

Production uses its existing `prebid-professor-builds` R2 bucket. TEST connections, custom templates and history are not copied into production. After production setup, open **API integracije → GAM povezivanje** and connect the same service-account JSON again. Inventory already created in GAM is visible in a new preview of that network.

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

`node scripts/verify-gam-workerd.mjs` runs the actual Wrangler-compiled TEST Worker in local workerd with native fetch, a freshly generated synthetic RSA key and local OAuth/SOAP responses. It checks authentication, signed OAuth, network verification, encrypted R2 persistence, saved-credential inventory reads, rejected redirects and sanitized Google failures. No Google requests leave this test.

The first live connection attempt exposed two runtime incompatibilities missed by injected-fetch tests: workerd rejects `redirect: 'error'` before sending, and native `fetch` stored on `GamClient` receives the wrong `this` receiver. The adapter now uses `manual` with explicit 3xx rejection and a wrapper around native fetch. Redirects never forward the assertion or bearer token to another destination. On 2026-09-22 the owner confirmed a successful real GAM test and provided a screenshot of active `Billboard1` (ID `23377927393`) under parent `test` in network `22038436483` (`direktno.rs`), including Fluid. The owner explicitly approved promotion to `main`.

`node scripts/verify-gam-workerd.mjs dist/prebid_professor production` additionally exercises the actual production build locally: its login/session boundary, same-origin guard, configured status, OAuth/SOAP transport and encrypted persistence. All credentials and Google responses are synthetic.

Sources consulted: [AdUnit v202608](https://developers.google.com/ad-manager/api/reference/v202608/InventoryService.AdUnit), [InventoryService](https://developers.google.com/ad-manager/api/reference/v202608/InventoryService), [GAM authentication](https://developers.google.com/ad-manager/api/authentication), [service-account OAuth2](https://developers.google.com/identity/protocols/oauth2/service-account).

## Slow or interrupted create responses — MBA-425

Create requests wait up to 60 seconds, including response-body reading; reads retain their 25-second deadline. This is below the line-item job's existing 90-second cancellation guard. The previous 25-second create deadline could abandon a batch already committed by Google. A virtual-clock regression demonstrates a successful 40-second response failing under the old deadline and completing under the new one.

Transport failures distinguish deadline expiration from a connection/body interruption. Sanitized logs contain only service, operation, entity count, response stage, elapsed time and deadline. They do not include raw exceptions, credentials, SOAP bodies or creative snippets. Explicit Google SOAP rejections keep their existing reason handling.

An unconfirmed create is still never replayed automatically. Use **Proveri ishod u GAM-u** to inspect existing entities, then explicitly **Nastavi posao** after successful reconciliation. Existing plans, batch sizes, attempts and saved cursors are unchanged, so interrupted 100-creative jobs remain recoverable. This change does not prove the historical production interruption was specifically a timeout; the previous implementation discarded that distinction.

## Automatic ads.js reporting setup — MBA-429

New Prebid and ordinary line-item plans first prepare the current ads.js reporting
catalog. Existing networks can use the **Key-values** tab with no advertiser,
order, inventory or creative selection. This uses the same saved review,
network confirmation, execution and recovery flow. Preview/review only read GAM;
they never create or update keys. A network's existing unfinished job must be
recovered or explicitly closed before starting a separate job.

The versioned plan snapshot contains twelve keys and 283 known values:

| Keys | New-key type | Known values |
| --- | --- | --- |
| `refresh_bucket`, `refresh_policy`, `aq_timed_out` | PREDEFINED | Existing frozen reporting contract |
| `aq_bid_origin`, `aq_first_request`, `aq_consent_wait` | PREDEFINED | All 17 request-reporting values |
| `geo_country`, `Variant` | PREDEFINED | 250 accepted country codes; A and B |
| `refresh_count`, `aq_bid_count`, `aq_bidder_count` | FREEFORM | Initial value 0 |
| `refresh_interval` | FREEFORM | initial and unscheduled |

New reporting keys use `reportableType=ON`; their values use `matchType=EXACT`.
An existing ON or CUSTOM_DIMENSION key is reused. An active OFF key is reviewed
as **Za dopunu**, then updated by its existing ID, preserving its actual name,
display name and type. The API does not reactivate inactive keys, convert key
types, downgrade custom dimensions, or enable high-cardinality Prebid render IDs
for reporting. Case-insensitive key/value matching and parent-scoped value
reads prevent duplicate creation. A failed, malformed or incomplete read cannot
establish absence. An uncertain update is reconciled read-only before another
explicit continuation; update writes share the 60-second create deadline.

Reporting requirements are separate from line-item serving criteria. They are
never added as mandatory targeting rules. Old saved jobs retain their original
snapshots; reopening an otherwise identical legacy plan resumes the old job
without silently adding new work. Once that job is complete, a new reporting
setup can prepare its network.

The four numeric domains are open. Defining a FREEFORM key does **not** make every
future value reportable. The preview therefore identifies these domains rather
than promising complete coverage. API callers can supply explicit additions in
`reportingValues`, for example:

```json
{
  "mode": "reporting",
  "networkCode": "123456",
  "reportingValues": {
    "refresh_count": [1, 2, 3],
    "refresh_interval": [30],
    "aq_bid_count": [1, 2, 3],
    "aq_bidder_count": [1, 2]
  }
}
```

Only these four keys accept additions, up to 1,000 values each and 4,000 total.
Counters must be nonnegative safe integers; intervals must be positive seconds
with at most six decimal places. Values are canonicalized and deduplicated.
Choose actual configured/observed values before measurement. Google excludes
undefined values from reports and does not backfill historical impressions.
GAM reportable-key/value limits and available report types still apply.

The independent reporting suite checks read-only review, metadata-only updates,
case-insensitive reuse, key-scoped values, malformed/incomplete reads, mixed
update/create batches, lost responses, externally changed/deleted keys and old
job recovery. The compiled TEST and production Worker checks also execute the
standalone preparation and repeated no-write replay against local SOAP fixtures.
Browser checks cover desktop/mobile preview, confirmation and recovery. These
checks use synthetic credentials and Google responses; deployment alone does
not provision a real connected GAM network.

Sources: [CustomTargetingKey v202608](https://developers.google.com/ad-manager/api/reference/v202608/CustomTargetingService.CustomTargetingKey),
[CustomTargetingService](https://developers.google.com/ad-manager/api/reference/v202608/CustomTargetingService),
[Report on key-values](https://support.google.com/admanager/answer/14528835?hl=en),
[Make key-values reportable](https://support.google.com/admanager/answer/10018898?hl=en),
[Key-value matching](https://support.google.com/admanager/answer/10020177?hl=en).

## Choose Key-values and follow the result — MBA-431

**API integracije → Key-values** is a separate operator flow. Select the connected
network, then choose the suggested keys and values. Select all, clear the
selection, or choose only the three new auction-reporting labels. The values can
be narrowed as well: selecting `geo_country` does not require all 250 countries.
Numeric keys accept explicit additions using the existing bounds. A key with
no selected values prepares only the key; the preview shows zero values for it.

The authenticated, read-only `GET /api/integrations/gam/key-values/catalog`
returns the twelve-key preset without contacting Google or requiring an existing
network connection. The existing preview endpoint accepts an exact selection:

```json
{
  "mode": "reporting",
  "networkCode": "123456",
  "reportingSelection": [
    {"key": "aq_bid_origin", "values": ["fresh", "cached", "none"]},
    {"key": "geo_country", "values": ["RS"]},
    {"key": "refresh_count", "values": [0, 1, 2, 3]}
  ]
}
```

Omitting a key's `values` list chooses all known values for that key; an empty
list prepares only the key. Omitting `reportingSelection` preserves the complete
preset and existing `reportingValues` behavior. Explicit selections require known
unique keys and valid values; empty selection is rejected. Closed domains accept
their preset values only. The server canonicalizes names and order before saving
the immutable plan. Unselected keys are not created or made reportable. Selection
applies to standalone reporting jobs; ad plans keep their full reporting setup.

Visible status distinguishes checking, ready for confirmation, creating, waiting
for reconciliation, completed and cancelled. A ready preview is not a completed
GAM write. The network, phase and saved progress remain visible while requests
run. Uncertain writes stay pending until a successful read confirms their state.
Opening history or an active job only reads saved state; writes still require
the network confirmation, shared lock and durable attempt protocol.

Saved responses include `reporting.results`: one row per selected key with its
verified GAM ID, state, outcome, explanation and selected value rows.
`reporting.outcomes` counts key and value outcomes separately. Successful create
responses are reported as created. Existing OFF keys confirmed ON are reported
as updated, preserving that result through parent checks and reloads. A lost
create reply followed by a matching read is existing with `reconciled: true`
and an explanation: the read cannot prove which concurrent actor created it.
Read errors, missing confirmations and conflicts are not successful completion.

Compiled TEST/production checks exercise two selected keys and one value, a
key-only choice, an untouched unselected OFF key, a persisted update with a lost
reply, read-only reconciliation, durable results and zero-write replay.
Independent handler tests and pinned desktop/mobile browser checks cover
selection, progress, errors and history. All demand and GAM responses stay local.
The owner's screenshot showed only `hb_pb` and `hb_bidder` in real Direktno
network `22038436483` at that time; these tests do not modify that network.
