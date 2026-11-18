# Bid cache recovery in 3.25.1 (MBA-422)

3.25.1 retains the combined 3.24 serving program and all 3.25 GAM request
labels. Every allowed refresh still starts a new Prebid auction; valid unused
earlier bids compete with fresh bids. This release does not implement the
separate cache-first strategy in MBA-60.

## Recovery behavior

The old cache kept native filter decisions in a diagnostic map that resets
after 4096 distinct IDs. A targeting selection could then lose its positive
filter evidence and disable caching for the rest of the document.

The new helper keeps that evidence on the already tracked bid, together with
the current completed auction context. Resetting diagnostics cannot erase it.
A later rejection overwrites it, and a new completed auction requires fresh
filter evidence. The existing 64-auction eviction and consent reset remove
the tracked bid and its evidence together. No unbounded collection is added.

If a previously accepted cached bid expires or becomes ineligible between
native filtering and final validation, the helper reads native targeting
again. It makes at most three validation passes and two cache-enabled rereads
before the retained fresh-only fallback. Every retry, error and fallback
removes earlier cached readiness permissions. A bid never accepted by the
native filter, an explicit rejection or an ignored/replaced filter still
activates the existing protective fallback.

Consent, exact alias/account admission, current rules, sizes, native floors,
used-bid protection and fresh-deal precedence remain enforced. A cached bid
never moves to another position and a bid previously sent to GAM is not reused.

## Package and reporting

README.txt states whether this actual package enables caching, the positions
where it applies and the maximum age. It only documents the cache diagnostic
object when that object is emitted. The implementation example also states
whether caching is active. Cache-off generated JavaScript retains the 3.25
reporting program unchanged for the same normalized input.

The existing `refresh_policy=fresh_auction` describes the request path; that
request may contain a valid cached bid. `aq_bid_origin` identifies the primary
bid offered to GAM. A cached secondary bidder does not label a fresh primary
as cached, and local `cachedWins` counts targeting selections. Neither value
proves which demand GAM rendered or what revenue the cached bid earned.

There is no authoritative live SSP/GAM deal-end feed in this runtime. A
returned deal may remain eligible until the earlier of its original bid TTL
and configured maximum age, subject to the other checks. TTL does not prove
that a commercial deal remains active. Positions requiring authoritative live
deal expiry can explicitly disable bid caching. This limitation is documented
instead of inventing an expiry timestamp or changing partner deal semantics.

## Selection and validation

Select 3.25.1 explicitly in Script setup, accept Preview and generate a new
package. Existing selections, recommendations, saved ZIPs, runtime records and
publisher URLs retain their bytes and identities. Selecting or downloading a
package does not activate it or configure GAM reporting.

Targeted helper regressions cover long histories, expiry during targeting,
bounded retries, cleanup, filter violations, consent, account/alias admission,
floor/size changes and used bids. The frozen 3.24 helper reproduces 12 failures
in the 21-case independent suite; the new helper passes all 21.

The native browser verifier accepts `--runtime tessera-3.25.1` when generating
fixtures. Its additional long-history and expiry-race cases exercise complete
readable/minified packages with pinned Prebid 11.11.0 and 11.34.0 at desktop
and narrow widths. Every HTTP request is intercepted and demand, GPT and CMP
are synthetic. Native auction/targeting results do not establish live SSP/GAM
acceptance, publisher activation, report availability or revenue uplift.

For the revenue comparison in MBA-58, use the same new runtime and reporting
instrumentation in both arms, changing only cache OFF/ON. Keep the inventory,
refresh, demand, timeout, consent and reporting scope identical. Compare total
cohort revenue with valid matching denominators; cached-label impressions
alone do not measure incremental revenue. The accepted A/A delivery check
does not need to be repeated.
