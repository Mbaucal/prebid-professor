# TakeOver interval boot correction in 3.21.2

This release fixes WIRE-F1 and STO-3 from MBA-404. It is built on 3.21.1 and
keeps the CRIT-1 storage rules. 3.21.1, every older runtime and their registry
records are unchanged. Existing selected versions and saved packages are
unchanged; selecting 3.21.2 is explicit. The exact `codeSha256` and
`sourceCommit` are in `worker/runtime/runtime-releases.json`.

## Behavior

With a TakeOver interval above 0, 3.21.1 deferred the whole page boot until the
CMP decision on pages where the TakeOver can show. Slots, size-map
reservations, Sticky hosts and `window.adSlots` therefore appeared only after
the decision, or never with a pending CMP.

With a TakeOver interval, 3.21.2 does at page load what 3.21.0 does there. It
defines slots, decides keyword-conditioned unit rules (size maps and Disable
slot) and sets page-level key-values from `window.adsKeywords`, exactly as
3.21.0 does. 3.21.1 did all of this at the CMP decision. On pages without
content containers at load, the 20-second container discovery window starts
when ads.js starts (with the defer tag; see "Reference point for these times"),
as in 3.21.0. On sites with `geo_country` unit rules, one more pass (the
country pass) defines slots if the country lookup is still open at boot: when
the lookup settles, or without a country 1.5 seconds after ads.js starts, as in
3.21.0.

Only these wait for the current CMP decision. They are released together, in
the 3.21.1 order, by the first readiness waiter:

1. the TakeOver frequency cap (the only storage read, under the CRIT-1 rules);
2. the codeless guard (define, display, sweeps);
3. `enableSingleRequest`, `enableServices` and `googletag.display` of slots;
4. the initial start: viewability tracking, the ATF scan and `resolveConsent`.

| Item | 3.21.0 | 3.21.1 | 3.21.2 |
| --- | --- | --- | --- |
| Slots, size maps, Sticky hosts, `adSlots` | load | decision | load |
| Keyword-conditioned unit rules (map, Disable slot) | load | decision | load |
| Page-level key-values from `adsKeywords` | load | decision | load |
| Later `adsKeywords` in page key-values and new units' rules | 2 s poll if empty at start; discovery tries and the country pass, if the page has an ad container (incl. the Sticky host) | poll and discovery from the decision; country pass only if the decision comes first | as 3.21.0 |
| 20 s discovery (only pages without content containers at load) | from start | from decision | from start |
| Containers inserted after load, outside discovery and the country pass | not defined | defined at the decision if inserted before it | not defined |
| Cap storage read | load (CRIT-1) | decision | decision |
| Interstitial link block | load, if not capped | decision, if active | decision, if active |
| Guard, `enableServices`, slot display (pages where the TakeOver can show) | load | decision | decision |
| `TAKEOVER_ACTIVE_FOR_PAGE` before the decision (pages where the TakeOver can show) | `true` or `false` from storage | `false` | `null` |
| TakeOver status before the decision (pages where the TakeOver can show) | `waiting`, or `inactive` when capped | `inactive` | `waiting-consent` |

On other pages (in an iframe, or a viewport without a TakeOver size) all three
versions start GPT at load, with TAKEOVER_ACTIVE_FOR_PAGE false and status
inactive.

At the decision the release waiter decides the cap and then runs the held GPT
start and the initial start. It defines no slots for ad containers and does
not add `window.adsKeywords` to page key-values again. On an active page the
held start defines the guard before `enableServices`. The initial start then
defines the TakeOver slot, as in 3.21.1. Every slot defined while the decision
was pending, at load, by discovery or by the country pass, is displayed once
after `enableServices`. A failing cap decision sets status `cap-error`, emits
a `cap-error` event and still releases GPT. A capped or viewport-skipped page
never gets the guard or the `data-google-interstitial` attribute.

Frequency 0 and sites without a TakeOver compile to the exact 3.21.1 `ads.js`;
only the version label differs.

## Known differences from 3.21.1 (3.21.0 behavior)

These apply only with a TakeOver interval, on pages where the TakeOver can
show. In each case 3.21.2 behaves as production 3.21.0.

- **Keywords changed after ads.js loads.** Unit rules and page key-values are
  set from `window.adsKeywords` when ads.js starts. If gpt.js loads after
  ads.js, this happens when GPT runs ads.js's queued commands, and a change
  before that can also send both values, as in 3.21.0. Later changes are
  picked up only where 3.21.0 also picks them up:
  - when `window.adsKeywords` is empty when ads.js starts, keywords that
    appear within the first 2 seconds are added to page key-values;
  - container discovery tries about every 0.75 seconds for the first 7.5
    seconds until it finds a content container, and whenever a container
    appears within 20 seconds. A try, and the country pass, adds the current
    `window.adsKeywords` to page key-values if the page has any ad container,
    including the Sticky host ads.js adds; on a site without a Sticky position
    a try that finds no container adds nothing. They decide the rules of the
    containers they find with those keywords;
  - the Interstitial fallback rule is decided with the `window.adsKeywords`
    current when the TakeOver releases the fallback (empty, invalid, timed out
    or failed), after the decision, or, for a rule with a `geo_country`
    condition released before the country lookup settles, when it settles;
    3.21.0 and 3.21.1 do the same.

  Page targeting adds values, so GAM can then receive the load-time and the
  later values together, for example `category=[Sport,Politika]`. 3.21.1 used
  the value current at the decision.
- **Containers inserted after load.** Discovery runs only on pages without
  content containers at load. It lasts 20 seconds after ads.js starts; 3.21.1
  opened the window at the decision. On sites with `geo_country` unit rules,
  the country pass runs if the country lookup is still open at boot: when the
  lookup settles, or without a country 1.5 seconds after ads.js starts. It
  defines the containers present then. Containers inserted after load are not
  defined in any other case. So on a page that has content containers at load,
  a container inserted while the decision is pending is not defined, unless
  the country pass finds it. With a TakeOver interval, 3.21.1 defined it at
  the decision. A container defined while the decision is pending is
  displayed once after `enableServices`.
- **Reference point for these times.** They assume the defer tag in
  implementation.html. If ads.js runs while the page HTML is still loading,
  discovery and the 2-second keyword check start at DOMContentLoaded, while the
  1.5-second country wait starts when the script runs, so there is no country
  pass if that wait ends first. 3.21.0 behaves the same.
- **Definition order.** Containers found by discovery are defined in the order
  discovery finds them, not in page order.

The package README says to set `window.adsKeywords` before ads.js, to put the
ad containers in the page HTML and to load ads.js with the defer tag shown in
implementation.html. It describes these 3.21.0 mechanisms by name only; the
timers are listed here.

One ordering differs from both 3.21.0 and 3.21.1: on an active page the guard
is defined after the slots defined at load, still before `enableServices`
(see "Not verified offline").

Correction in this revision: an earlier 3.21.2 draft also ran slot discovery at
the decision. That re-applied `window.adsKeywords`, and because page targeting
adds values, GAM received the load-time and decision-time values together (for
example `category=[Politika,Sport]`). At the decision, the release no longer
defines slots for ad containers or adds key-values.

## Source and generation

- `worker/runtime-3212/browser-boot.mjs` holds the browser functions.
  `scripts/prepare-runtime3212.mjs` copies their source text into
  `.generated/runtime-3212-browser-source.mjs` only after the source hash
  check; `browser-boot.mjs` is inside the hashed closure.
- `worker/runtime-3212/boot-compiler.mjs` patches only the newly generated
  3.21.1 program. Every anchor must match exactly once or generation fails.
  The held start replays the original 3.21.1 statements verbatim.

## Tests

- `tests/runtime/boot3212.test.mjs`: generated functions in a VM with recorded
  GPT, CMP, DOM and storage fakes. Container discovery and page targeting run
  the real generated code; the GPT fake replaces a key's values on
  `setTargeting`, as GPT does. Covers the pending CMP, active, capped,
  viewport-skipped and failing decisions, CRIT-1 storage cases, decision flips,
  synchronous CMP, late GPT, containers found by discovery while held, the
  discovery window, `adsKeywords` changed before the decision, geo-dependent
  units, a script in `<head>`, exact anchors and frequency-0 identity.
- `tests/runtime/runtime3212-package-qa.test.mjs`: 3.21.2 packages against
  3.21.1 packages from the same settings, stored drafts with and without deals,
  the TEST workspace flow, and a saved 3.21.1 pin that keeps generating 3.21.1.
- `tests/runtime/runtime-allow-list-parity.test.mjs` and
  `tests/runtime/runtime-lineage.test.mjs`: admin allow-lists and the source
  closure of the newest stable runtime.
- Chromium, in CI (`site-editor-checks.yml`), with the repository GPT/Prebid
  mock, a local CMP stub and every external request blocked:
  - `scripts/prepare-storage3212-browser.mjs` with
    `scripts/verify-storage3211-browser.py .generated/storage3212-browser`:
    the full storage/CMP regression on the eight 3.21.2 programs (GAM and
    Prebid, interval 0 and 5, readable and minified);
  - `scripts/prepare-boot3212-browser.mjs` with
    `scripts/verify-boot3212-browser.py`: the boot at interval 5 before and
    after the decision (accept, stored cap, containers inserted while
    pending), and page targeting after an `adsKeywords` change compared with
    the 3.21.0 program at intervals 5 and 30.

## Not verified offline

The GPT used in tests is a recorder. Whether real GPT request parameters depend
on the guard now being defined after the normal slots, and when GPT arms its
codeless interstitial, need a capture with real `gpt.js` and intercepted
requests on TEST before promotion.
