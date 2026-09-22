# GAM line items — MBA-86

## Scope and workflow

The existing global **API integracije → Line itemi** screen now supports two flows on the saved GAM connection:

- **Prebid postavka:** editable decimal price ranges (up to 5,000 prices), PRICE_PRIORITY/CPM line items, exact `hb_pb` values, shared creative copies and size overrides on each LICA.
- **Jedan line item:** PRICE_PRIORITY, STANDARD, SPONSORSHIP, BULK, NETWORK or HOUSE; CPM/CPC, rate, goal where applicable, immediate/scheduled start and optional/required end date. Standard/Bulk require an end date. Dates entered in the form are UTC.

Both flows select an existing advertiser or create one, then select an order belonging to that advertiser or create a new order with an active trafficker. Inventory targets selected active ad units (including descendants) or existing active placements. New orders split at 400 line items; existing orders are checked against the 450-item limit.

The network currency loads automatically. Prebid site-side price granularity and currency must match the chosen GAM setup; this module does not rewrite site settings or runtime artifacts.

Display pixel sizes are editable. New ThirdPartyCreative snippets can be entered as HTML/JS; the code is never executed in Tessera. Existing creatives can be selected from the advertiser. A single ordinary line item may be created without creatives for later completion. Video, native, Fluid and creative-set authoring are outside this display release.

The default Prebid snippet uses the version-pinned Prebid Universal Creative `1.18.0/dist/banner.js`, `TARGETINGMAP` and `hb_pb`. It creates a shared set of 20 creative copies by default, configurable from 1 to 50. Copies are shared across all prices, rather than creating 20 new creative objects per line item. The number should cover simultaneously eligible page slots. Size overrides use the complete selected line-item size list.

## Review, execution and recovery

1. **Proveri postavku u GAM-u** performs only Google reads, validates currency/inventory/trafficker, and resolves advertiser/order/key/value/creative/line-item identities. The plan is saved privately in R2. Exact names are not sufficient to reuse an entity: targeting, price, sizes, goal, schedule and creative snippet/options must match. Conflicts block execution.
2. A separate checkbox and **Kreiraj potvrđenu postavku** confirm the saved network and plan. Reviews expire after 15 minutes. Newly created orders stay DRAFT; no approval or activation action is sent. Adding items to an already approved order can make them eligible according to their schedule.
3. The browser advances small, durable batches. Closing or pausing the screen stops subsequent batches; the history list opens the saved job for continuation. Already created GAM objects remain intact.
4. Each mutating batch has an immutable attempt record written *before* the Google call. Concurrent requests use R2 ETag conditions and one active job per network. A lost response never automatically causes another create request.
5. **Proveri ishod u GAM-u** reads back the uncertain batch. It advances only when all expected objects exist and match. Otherwise the user can check again or, after at least 90 seconds, stop the job and produce a fresh review. Fresh reviews recover compatible existing entities.
6. Confirmed associations are counted compactly rather than storing 40,000 redundant link records in the job. CSV export includes every line-item name, price, state, GAM ID and order ID. History keeps the latest 100 summaries per actor/network and always includes an older active job.

API paths are under the existing authenticated, same-origin `/api/integrations/gam/line-items/` or TEST `/test-api/integrations/gam/line-items/` boundary. Jobs bind actor, origin, network and connection revision. Google endpoints are fixed. Credentials remain in the existing encrypted connection store. New job/history/attempt/lock data uses only private `api-integrations/gam/line-items/v1/` R2 keys; there are no D1 migrations or changes to site configuration/releases.

## Validation and acceptance

Local automated verification covers:

- Existing ad-unit regression tests and TEST host/session boundary.
- Ordinary Standard creation, new advertiser/order, existing advertiser/order/creative selection, key-value creation, decimal precision, conflicts, capacity, changed parents and changed creatives, actor/origin/confirmation restrictions.
- Lost responses, read-only reconciliation, missing results, concurrent execution and stale cursors.
- The full source-script scale: **2,000 prices, 5 new orders, 20 creatives, 40,000 size-override links** with correct targeting and stored progress.
- Native workerd using the compiled TEST Worker, real local R2, synthetic signed OAuth and SOAP responses. Outgoing XML types and field order are checked against the v202608 contract. Both flows and replay are exercised.
- Headless desktop/mobile UI: explicit review/confirmation, both creation flows, saved jobs, no external creative-code execution, no page errors or horizontal overflow.
- Client/Worker build and immutable legacy runtime history. Repository-wide `tsc --noEmit` still reports pre-existing unrelated errors; the new component contributes none.

These checks use synthetic Google data. Live GAM acceptance is still performed by the owner in TEST, ideally first with a short range such as 0.01–0.03 and then an ordinary line item. The new feature is not promoted to main until approved after that check.

## Primary references

- https://developers.google.com/ad-manager/api/reference/v202608/LineItemService.LineItem
- https://developers.google.com/ad-manager/api/reference/v202608/OrderService.Order
- https://developers.google.com/ad-manager/api/reference/v202608/CreativeService.ThirdPartyCreative
- https://developers.google.com/ad-manager/api/reference/v202608/LineItemCreativeAssociationService.LineItemCreativeAssociation
- https://docs.prebid.org/adops/gam-creative-banner-sbs.html
- https://docs.prebid.org/adops/gam-creative-considerations.html
- https://github.com/prebid/prebid-universal-creative/releases/tag/1.18.0
