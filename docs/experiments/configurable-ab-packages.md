# Configurable A/B package foundation

The `tanjug-configurable-ab-v1` compiler builds a new, complete nine-file package
from the accepted Tanjug CMP package and its hash-pinned readable source. It does
not read or change hosted settings, publish a package, or modify a frozen runtime.

This is the compiler foundation for MBA-57. The main dashboard editor, authenticated
generation endpoint, immutable storage and direct publication are not wired yet.
The existing A/B archive shelf only stores previously prepared fixed packages.

## Settings

`worker/experiments/package-settings-v1.mjs` is the strict shared editor/compiler
contract. Unknown fields and unsupported modes fail instead of being ignored.

| Setting | Meaning |
| --- | --- |
| B traffic percentage | Integer 0–100; A receives the remainder, once per document. |
| Arm mode | `fresh-only` or `auction-with-cache`, independently for A and B. |
| Refresh seconds | `null` preserves reviewed position rules; integer 1–7200 explicitly sets a fixed standard interval. |
| Maximum bid age | Cache arms only, integer 1–300 seconds, still subject to the original bid TTL/native checks. |

A manual interval applies to mobile, desktop, sticky timers and the rule consulted
at the refresh boundary. Existing enabled/excluded positions, page activity,
viewability, advertiser exclusions and maximum refresh counts remain enforced.
An interval is a minimum scheduling condition, not a guaranteed wall-clock request
cadence: batching, consent and auction latency can delay the GAM request.

There is no adaptive ready-bid interval or campaign classification in this profile.
Both require separate validation before appearing as enabled controls in the editor.
The default keeps the reviewed refresh schedules for both arms, allowing a cache
comparison without changing cadence at the same time.

## Identity and output

The release suffix fingerprints canonical settings, pinned source/assets, compiled
arms and the compiled loader template. Identical inputs build identical ZIP bytes.
Changed settings or compiler output produce a new release directory and arm SRI.
Build metadata stays outside the public deployment directory. The CLI refuses to
overwrite an existing release with different bytes.

Public targeting remains exactly `Variant=A` or `Variant=B`. The existing
`AdVariant.snapshot()` additionally reports the assigned mode, traffic split,
configured refresh seconds (`null` means preserved rules) and cache age limit.
The current dashboard's copied inspector does not yet expose these new fields;
extend its allowlist when wiring this profile to the editor.

## Development command

After preparing the reviewed pilot and CMP package:

```sh
node scripts/prepare-configurable-ab.mjs
node scripts/prepare-configurable-ab.mjs tests/runtime/configurable-ab-settings.json
node --test tests/runtime/configurable-ab.test.mjs
```

The second command is a synthetic verification fixture with 10-second refresh on
both arms. It is not a recommendation or an automatically activated live test.
CI exercises this exact minified package with native Prebid 11.34.0, synthetic
GPT/TCF and external ad traffic blocked, including real scheduled refreshes below
the former 30-second value. This verifies delivery mechanics, not live revenue.

## Integration remaining

1. Form using the shared schema and a review of both arms before generation.
2. Server endpoint bound to the correct site and pinned baseline, with stale-draft
   protection, bounded generation and immutable save/download of the exact bytes.
3. Compact release labels, full identity available in details, rather than placing
   the full fingerprint across the main layout.
4. Extend the Debug inspector for configured intervals and per-slot delay reasons.
5. Only offer direct publish once it consumes the same saved package as Download.

Initial scope is the reviewed Tanjug baseline. Replacing its inventory, bidders or
Prebid build requires a new reviewed baseline, not silently mixing current site
settings into this frozen input.
