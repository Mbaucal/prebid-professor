# Bid cache per ad position

The reviewed Tanjug named-script generator supports three choices under Config → Ad units → Bid cache:

- **Use site setting**: inherit the current default in Config → Demand → Prebid.
- **On**: let valid, unused bids from earlier auctions for this position compete with fresh bids.
- **Off**: use only bids from the current auction for this position.

Each refresh still starts a fresh auction. A higher fresh CPM can win on any refresh, including the third. Turning cache off does not prevent the GAM request when the fresh auction returns no bids.

Saving a position changes the configuration for the next named version in Releases → Scripts and A/B tests. It does not modify existing ZIPs or an active publisher deployment. Each saved script and A/B reference retains its own position choices. Removing an override restores inheritance; changing the site default preserves explicit overrides. Disabling Prebid keeps the choices saved but inactive.

## Scope

These controls apply to the existing reviewed Tanjug inventory and pinned Prebid 11.34.0 build. Generic built-in generators do not yet implement this policy and reject generation if position cache settings would be ignored. Unsupported sites do not show these controls. The maximum bid age remains a site setting; the original bid TTL, consent, size and submitted-bid checks continue to apply.

## Implementation and verification

`prebidBidCache.positionOverrides` stores optional booleans keyed by the generator's ad-unit code. An absent key inherits the site default. Optimistic configuration revisions prevent stale forms overwriting another change. The new `tanjug-script-2.0.0-*` package uses a versioned policy and loader. The original policy, frozen runtime and packages without overrides remain unchanged.

Node tests cover filtering, current-auction acceptance, eligibility safeguards, immutable settings and package identity. Compiled Worker tests cover authenticated persistence and exact ZIP parity. CI browser checks exercise the actual ad-unit controls and packaged Prebid with synthetic bidder responses: site-on and site-off combinations, fresh 1 versus cached 4 CPM, a fresh 12 CPM bid on the third refresh, and no fresh bid with cache off. No external live auctions are used by these tests.
