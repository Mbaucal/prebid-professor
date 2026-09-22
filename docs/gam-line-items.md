# GAM line items — MBA-86

## Scope and workflow

The existing global **API integracije → Line itemi** screen now supports two flows on the saved GAM connection:

- **Prebid postavka:** editable decimal price ranges (up to 5,000 prices), PRICE_PRIORITY/CPM line items, exact `hb_pb` values, CPM-named creative copies for each price and size overrides on each LICA.
- **Jedan line item:** PRICE_PRIORITY, STANDARD, SPONSORSHIP, BULK, NETWORK or HOUSE; CPM/CPC, rate, goal where applicable, immediate/scheduled start and optional/required end date. Standard/Bulk require an end date. Dates entered in the form are UTC.

Both flows select an existing advertiser or create one, then select an order belonging to that advertiser or create a new order with an active trafficker. Inventory targets selected active ad units (including descendants) or existing active placements. New orders split at 400 line items; existing orders are checked against the 450-item limit.

The network currency loads automatically. Prebid site-side price granularity and currency must match the chosen GAM setup; this module does not rewrite site settings or runtime artifacts.

Display pixel sizes are editable. New ThirdPartyCreative snippets can be entered as HTML/JS; the code is never executed in Tessera. Existing creatives can be selected from the advertiser. A single ordinary line item may be created without creatives for later completion. Video, native, Fluid and creative-set authoring are outside this display release.

The default Prebid snippet uses the version-pinned Prebid Universal Creative `1.18.0/dist/banner.js`, `TARGETINGMAP` and `hb_pb`. It creates 20 distinct creative copies **per price** by default, configurable from 1 to 50, matching the source script. Each creative is associated only with its own price line item. Jobs allow at most 50,000 new creatives. The number should cover simultaneously eligible page slots. Size overrides use the complete selected line-item size list, which defaults to the original 14 sizes including 1x1. Selecting existing creatives reuses their names and IDs without renaming them. Previously saved jobs retain their original shared-creative layout and recovery batch boundaries; create a fresh review to use the new per-price layout.

### Automatic names and prices

The form displays the actual generated order names and sample line-item/creative names before review. For a prefix `SMN - Programmatic HB - Prebid`, a 0.01–20.00 range and a 0.01 step, five orders are generated: `#1 (0.01-4.00 EUR)` through `#5 (16.01-20.00 EUR)`. Even a single new Prebid order receives its number and exact price range. An existing selected order keeps its current name.

For each price, one integer micro-amount determines all of the following:

| Field | Example |
| --- | --- |
| Line item name | `HB €18.03` |
| CPM rate | `18.03 EUR` (`18030000` micros) |
| Key-value targeting | `hb_pb = 18.03` |
| Creative names | `HB €18.03, #1` through `HB €18.03, #20` |

Currency and prefixes remain editable. For non-EUR currencies the line-item name uses the currency code, for example `HB USD 18.03`.

## Review, execution and recovery

1. **Proveri postavku u GAM-u** performs only Google reads, validates currency/inventory/trafficker, and resolves advertiser/order/key/value/creative/line-item identities. The plan is saved privately in R2. Exact names are not sufficient to reuse an entity: targeting, price, sizes, goal, schedule and creative snippet/options must match. Conflicts block execution.
2. A separate checkbox and **Kreiraj potvrđenu postavku** confirm the saved network and plan. Reviews expire after 15 minutes. Newly created orders stay DRAFT; no approval or activation action is sent. Adding items to an already approved order can make them eligible according to their schedule.
3. The browser advances small, durable batches. Closing or pausing the screen stops subsequent batches; the history list opens the saved job for continuation. Already created GAM objects remain intact.
4. Each mutating batch has an immutable attempt record written *before* the Google call. Concurrent requests use R2 ETag conditions and one active job per network. A lost response never automatically causes another create request.
5. **Proveri ishod u GAM-u** reads back the uncertain batch. It advances only when all expected objects exist and match. Otherwise the user can check again or, after at least 90 seconds, stop the job and produce a fresh review. Fresh reviews recover compatible existing entities.
6. Confirmed associations are counted compactly rather than storing 40,000 redundant link records in the job. Creative references are also stored compactly. CSV export includes every line-item name, price, hb_pb, state, GAM ID, order ID and the matching creative names/IDs. History keeps the latest 100 summaries per actor/network and always includes an older active job.

API paths are under the existing authenticated, same-origin `/api/integrations/gam/line-items/` or TEST `/test-api/integrations/gam/line-items/` boundary. Jobs bind actor, origin, network and connection revision. Google endpoints are fixed. Credentials remain in the existing encrypted connection store. New job/history/attempt/lock data uses only private `api-integrations/gam/line-items/v1/` R2 keys; there are no D1 migrations or changes to site configuration/releases.

## Validation and acceptance

Local automated verification covers:

- Existing ad-unit regression tests and TEST host/session boundary.
- Ordinary Standard creation, new advertiser/order, existing advertiser/order/creative selection, key-value creation, decimal precision, conflicts, capacity, changed parents and changed creatives, actor/origin/confirmation restrictions.
- Lost responses, read-only reconciliation, missing results, concurrent execution, stale cursors and continuation of previously saved shared-creative jobs.
- The trafficker lookup filters UserService by `status = 'ACTIVE'`; `isActive` is a response field, not a supported PQL filter. Native SOAP checks include inactive users to catch the original `UNEXECUTABLE` regression.
- The full source-script scale: **2,000 prices, 5 new orders, 40,000 CPM-named creatives, 40,000 size-override links** with correct targeting and stored progress.
- Native workerd using the compiled TEST Worker, real local R2, synthetic signed OAuth and SOAP responses. Outgoing XML types and field order are checked against the v202608 contract. Both flows and replay are exercised.
- Headless desktop/mobile UI: explicit review/confirmation, both creation flows, saved jobs, no external creative-code execution, no page errors or horizontal overflow.
- Client/Worker build and immutable legacy runtime history. Repository-wide `tsc --noEmit` still reports pre-existing unrelated errors; the new component contributes none.

These checks use synthetic Google data. Live GAM acceptance is still performed by the owner in TEST, ideally first with a short range such as 0.01–0.03 and then an ordinary line item. The new feature is not promoted to main until approved after that check.

## Primary references

- https://developers.google.com/ad-manager/api/reference/v202608/UserService
- https://developers.google.com/ad-manager/api/reference/v202608/LineItemService.LineItem
- https://developers.google.com/ad-manager/api/reference/v202608/OrderService.Order
- https://developers.google.com/ad-manager/api/reference/v202608/CreativeService.ThirdPartyCreative
- https://developers.google.com/ad-manager/api/reference/v202608/LineItemCreativeAssociationService.LineItemCreativeAssociation
- https://docs.prebid.org/adops/gam-creative-banner-sbs.html
- https://docs.prebid.org/adops/gam-creative-considerations.html
- https://github.com/prebid/prebid-universal-creative/releases/tag/1.18.0
