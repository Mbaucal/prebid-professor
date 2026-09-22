# GAM line items — MBA-86

## Scope and workflow

The existing global **API integracije → Line itemi** screen now supports two flows on the saved GAM connection:

- **Prebid postavka:** editable decimal price ranges (up to 5,000 prices), PRICE_PRIORITY/CPM line items, exact `hb_pb` values, CPM-named creative copies for each price and size overrides on each LICA.
- **Jedan line item:** PRICE_PRIORITY, STANDARD, SPONSORSHIP, BULK, NETWORK or HOUSE; CPM/CPC, rate, goal where applicable, immediate/scheduled start and optional/required end date. Standard/Bulk require an end date. Dates entered in the form are UTC.

Both flows select an existing advertiser or create one, then select an order belonging to that advertiser or create a new order with an active trafficker. Inventory targets selected active ad units (including descendants) or existing active placements. New orders split at 400 line items; existing orders are checked against the 450-item limit.

The ordinary line-item flow loads the network currency. The script preset keeps its original EUR currency and reports a mismatch instead of silently converting the original rates. Prebid site-side price granularity and currency must match the chosen GAM setup; this module does not rewrite site settings or runtime artifacts.

Display pixel sizes are editable. New ThirdPartyCreative snippets can be entered as HTML/JS; the code is never executed in Tessera. Existing creatives can be selected from the advertiser. A single ordinary line item may be created without creatives for later completion. Video, native, Fluid and creative-set authoring are outside this display release.

At the owner's request, the default Prebid snippet now exactly matches the original script: Prebid Universal Creative `@latest/dist/creative.js`, `TARGETINGMAP` and `hb_pb`. Saved jobs retain their own snippet. It creates 20 distinct creative copies **per price** by default, configurable from 1 to 50, matching the source script. Each creative is associated only with its own price line item. Jobs allow at most 50,000 new creatives. The number should cover simultaneously eligible page slots. Size overrides use the complete selected line-item size list, which defaults to the original 14 sizes including 1x1. Selecting existing creatives reuses their names and IDs without renaming them. Previously saved jobs retain their original shared-creative layout and recovery batch boundaries; create a fresh review to use the new per-price layout.

### Ready-to-run source-script preset

The owner accepted the ordinary line-item flow in live GAM and requested that Prebid open with the original script values already filled. `GET /line-items/defaults?network=…` performs read-only discovery in the selected saved connection. It never switches to the original script's hard-coded network.

| Setting | Default |
| --- | --- |
| Advertiser | `Prebid`; resolve existing or create if missing |
| Placement | Exact active `Prebid placement` |
| Trafficker | Exact active `marko.baucal@smn.rs` |
| Order prefix | `SMN - Programmatic HB - Prebid` |
| Currency / prices | EUR, 0.01–20.00, step 0.01 |
| Type / rate / key | PRICE_PRIORITY / CPM / `hb_pb` |
| Creatives | 20 per price, original snippet, 1x1, SafeFrame off |
| Sizes | All 14 original sizes on the line item and each association |
| Dates / goal | Immediate, unlimited end, no impression cap |
| Allow overbook | true, as in the source script; request-only GAM flag |

The visible **Pokreni i napravi** button authorizes review followed by creation of the displayed draft in one click. No checkbox is required for this explicit action. Conflicts, missing prerequisites or failed review prevent automatic start. Pause/unmount stops before start; reopening a saved review never auto-starts. The collapsed **Podešavanja — izmeni po potrebi** section keeps every previous control available. Edits are honored by the same run button; **Vrati podešavanja iz skripte** restores the preset with fresh discovery.

Missing/inactive/ambiguous placement or trafficker produces a specific message. The app never substitutes a random user or targets the root inventory as a fallback. Add the original prerequisite in GAM or choose another in the editable settings. New orders remain DRAFT, as in the script. The supported SOAP API remains v202608.

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
2. In the manual review flow, a separate checkbox and **Kreiraj potvrđenu postavku** confirm the saved network and plan. The explicit Prebid **Pokreni i napravi** action performs the same review and start sequentially from one click. Reviews expire after 15 minutes. Newly created orders stay DRAFT; no approval or activation action is sent. Adding items to an already approved order can make them eligible according to their schedule.
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
- Exact preset discovery is read-only and blocks ambiguous/missing prerequisites without substituting another user or inventory.
- The full untouched source-script preset, including original creative HTML, all 14 sizes and placement targeting: **2,000 prices, 5 new orders, 40,000 CPM-named creatives, 40,000 size-override links** with correct targeting and stored progress.
- Native workerd using the compiled TEST Worker, real local R2, synthetic signed OAuth and SOAP responses. Outgoing XML types and field order are checked against the v202608 contract. Both flows and replay are exercised.
- Headless desktop/mobile UI: untouched preset submission and one-click creation, pause before automatic start, editable review/confirmation, both creation flows, saved jobs, no external creative-code execution, no page errors or horizontal overflow.
- Client/Worker build and immutable legacy runtime history. Repository-wide `tsc --noEmit` still reports pre-existing unrelated errors; the new component contributes none.

These checks use synthetic Google data. The owner has accepted the ordinary line-item flow in live GAM. Prebid acceptance is still performed by the owner in TEST. The new feature is not promoted to main until approved after that check.

## Primary references

- https://developers.google.com/ad-manager/api/reference/v202608/UserService
- https://developers.google.com/ad-manager/api/reference/v202608/LineItemService.LineItem
- https://developers.google.com/ad-manager/api/reference/v202608/OrderService.Order
- https://developers.google.com/ad-manager/api/reference/v202608/CreativeService.ThirdPartyCreative
- https://developers.google.com/ad-manager/api/reference/v202608/LineItemCreativeAssociationService.LineItemCreativeAssociation
- https://docs.prebid.org/adops/gam-creative-banner-sbs.html
- https://docs.prebid.org/adops/gam-creative-considerations.html
- https://docs.prebid.org/overview/prebid-universal-creative.html
