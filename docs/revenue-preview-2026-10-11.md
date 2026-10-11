# Revenue preview: Deals and Banner + Outstream

Marko's priority order is Deals and Banner + Outstream, then CMP recovery and GEO,
then the publisher delivery flow. MBA-105 and MBA-109 remain in progress: this is
a bounded review candidate, not completion of every partner or live acceptance.

The explicit `3.16.0-revenue.preview.1` runtime layers native Send All Bids and the
new settings onto the recorded 3.14 consent-readiness engine. It does not promote
the separate 3.15 GPID/identity work or change any site's selected version.

## Operator behavior

- Config → Demand → Bidders → Deals saves string IDs, UTC validity, position scope
  and commercial mode. The generated read-only GAM plan includes matching native
  bidder-specific deal/adId keys and resolved inventory sizes. It never creates
  an SSP agreement, a returned bid, or a GAM line item.
- Config → Inventory → Formats selects Banner, Outstream, or Banner + Outstream.
  The first pilot requires checked Prebid 11.34.0, PubMatic, an explicitly confirmed
  activated renderer ID, and the supported VAST cache. Banner configuration stays
  saved. Player dimensions must occur in every nonempty enabled GPT size-map row.
- Video stays under the native friendly-iframe creative path. Current dispatched
  adId, consent epoch and bid expiry are checked before rendering and again when
  the vendor renderer's deferred callback executes. Video-enabled pilot positions
  do not automatically refresh, including after a banner/direct selection.
- Saving settings does not publish. Older generators reject active revenue
  settings instead of silently discarding them. Historical package reads remain
  available. GAM-only keeps metadata but emits no Prebid asset or deal targeting.

## Verification and immutable source

The independent reviewer approved source commit `ee59644d667649d676f4e76c27e1a0cfcd06868c`,
tree `fb7ab3b405acfe4a2a14a1e8fd292c0cd17d6361`, for a review candidate. Its GitHub
mirror `2af57b54847f77f9d180a242e76890b93d355064` has the identical tree. The registry
points at this reachable source mirror. Later changes concern UI feedback,
evidence and this provenance pin; runtime source bytes are unchanged.

- 34 contract, actual SQLite, route, package and readiness checks passed locally.
  Independent review reproduced 22 feature/integration checks and 12 readiness
  checks. Authentication, Origin, stale revision, unrelated settings preservation,
  protected position edits and Banner-then-rename were exercised.
- Six native Deals cases used locked Prebid with synthetic adapters and a
  controlled GAM choice: 1.20 open-market and 0.95 deal bids retained distinct
  adIds; the selected native deal creative rendered; refresh and expiry removed
  stale targeting/filtering; pending CMP choice blocked requests.
- The reviewer independently reproduced 29 native PubMatic/PUC cases from freshly
  generated readable/minified mixed and video-only scripts. Pinned official PUC
  1.17.2 executes the native renderer path. Managed deal filtering survives video
  configuration, native net USD CPM converts to EUR, and delayed/expired/changed
  consent callbacks cannot start the player. The 120-second pilot check observes
  one request and one auction only.
- Actual built React UI checks passed at 1440 and 390 px, including loading,
  save/reopen, retained input after failure, visible focused error feedback,
  site changes and Banner restoration. Local strict typecheck and build passed;
  all 63 historical generated outputs and historical source/lock inputs matched.
  Local Node was 24.19.0; CI is pinned to 22.23.3.

CI extends the existing consent-readiness workflow with the new contracts,
generated native scenarios and UI checks. Local results are not CI or hosted TEST
results. No Cloudflare deployment, publisher change, GAM write or paid request was
performed by this development round.

## Remaining acceptance

Native targeting exposes one selected bid per bidder per position. A lower deal
response and higher open-market response from the same bidder are not promised
as independently targetable creatives. Overlapping active managed deals for the
same bidder and position are rejected; unverified aliases are excluded.

Other video partners, responsive player resizing, Sticky/TakeOver video and player
pause/end/close refresh behavior are not enabled. Native tests replace the remote
BlueBillywig player with a synthetic bootstrap sink and simulate the GAM choice;
they do not prove the real partner player's lifecycle, live GAM eligibility,
billable impressions, CLS or revenue. Those require isolated hosted verification
and a controlled partner/publisher pilot before production promotion.
