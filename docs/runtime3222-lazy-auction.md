# 3.22.2 lazy auction correction (MBA-420)

3.22.2 is an explicitly selected preview based on the complete 3.22.1 source closure. 3.21.2 remains the stable recommendation. No site changes version automatically, and existing runtime sources, release records, saved ZIP files and hashes remain unchanged.

## Reproduced failure

On generated 3.22.1, the display observer can run before the prefetch observer. The display path starts an auction and marks the position displayed but leaves prefetch unclaimed. A delayed prefetch notification then queues that same position. If the first auction has completed by the 200 ms batch flush, a second Prebid auction starts, although only one GAM dispatch is needed.

The regression control executes the real generated `wireLazyBtf` and `fetchBidsAndRefresh` functions: display → auction completion → prefetch → batch flush produces two auctions and one GAM dispatch.

## Correction and boundaries

The display-first path claims prefetch ownership and removes that observer. The prefetch callback and queued flush also ignore a position already displayed; this covers callbacks the browser queued before `unobserve`. Prefetch-first display still waits for its one auction. The inherited readiness implementation retains its separate replacement auction when prefetched bids expire before display.

This correction does not change configured lazy fetch/render margins, consent authority, bidder accounts, SChain, deals, GEO, contextual signals or TakeOver behavior. It does not add generic bid caching or combine the separate 3.23.0 candidate.

## Verification

`tests/runtime/runtime3222-lazy.test.mjs` includes the failing 3.22.1 control, reversed and repeated observer delivery, queued and inflight prefetch, delayed display, GAM-only, package/catalog selection, immutable source closure and a byte comparison of every non-lazy compiler change.

The full-script Chromium runner is `scripts/verify-lazy3222-browser.py`; prepare actual readable/minified packages with `scripts/prepare-lazy3222-browser-fixtures.mjs`. It uses synthetic CMP/GPT/Prebid and intercepted network, at desktop and narrow widths. Local browser evidence is distinct from native Prebid integration, hosted TEST and publisher acceptance.

Merge using a merge commit. The new release record refers to its immutable source commit, which must remain reachable from the integration branch.
