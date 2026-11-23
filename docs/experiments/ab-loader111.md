# A/B loader 1.1.1: pending-arm startup arbitration

Loader 1.1.1 fixes the slow-transfer failure tracked in MBA-437. Loader 1.0.2
and 1.1.0 retired the assigned script after eight seconds, then retired control
A eight seconds later. Valid responses arriving after those deadlines could
therefore produce no ads. With the controlled uncompressed 15 KiB/s responses,
this affected assigned B while assigned A recovered from its existing transfer.

The eight-second timer is now a soft loading deadline. It can start one control
request while the original valid pending script remains eligible. The first
eligible script to enter the verified native startup guard claims execution.
The other script cannot enter another runtime, even if its response arrives
later. There are at most two script elements and one control retry; deadline
expiry never starts an unbounded retry loop.

If both requests remain pending after their deadlines, diagnostics say
`waiting-for-arm`. Their pending responses can still start the one runtime.
A transport, SRI, CORS, CSP or Trusted Types failure invalidates that attempt.
An HTTP-loaded script that did not enter native startup is a `no-start` failure,
not a successful runtime. A terminal failure is reported only when no eligible
attempt remains. Existing external runtimes keep their native startup ownership
and exclude the loader's attribution.

The startup claim happens before any further publisher-controlled keyword
getter is read. A keyword conflict discovered then clears experiment labels
without launching a second runtime. Before native entry, a known conflict can
still exclude B and select unlabelled control A.

## Diagnostics and measurement

The snapshot keeps the original assignment separate from the actual execution:

| Field | Meaning |
| --- | --- |
| `originalVariant` | Original randomized A/B group, retained after exclusions. |
| `executionArm` | The eligible script whose native startup guard claimed execution. |
| `fallbackRequested` | A B-to-A control request was made. B may still win. |
| `controlRetryRequested` | An assigned A request was retried with A. |
| `fallback` | Assigned B actually executed A. An A retry is not a fallback. |
| `attempts` | At most two attempts with eligibility, state and deadline outcome. |

`window.AdVariant.measurement()` exports the bounded, memory-only **schema 2**
ledger. It adds `arm-deadline`, `control-retry` and `fallback-requested` events.
`fallback` is emitted only after assigned B actually enters A. The original
assignment remains B for that page, including its GAM labels when attribution
remains eligible. A fallback request followed by successful B execution is not
counted as an actual fallback.

The offline parser keeps schema 1's original event vocabulary and semantics.
Schema 2 is explicitly tied to loader 1.1.1. Unknown schema/event fields,
executions after a definitive failure, multiple executions and incompatible
page prefixes are rejected. Existing immutable report plans and GAM CSV formats
are unchanged. Memory exports still do not prove all-assigned coverage or a
revenue cohort join: page RPM, uplift and a winner remain unavailable.

## Release and installation

New tests use loader 1.1.1. Every earlier loader source, registry entry, saved
test and ZIP keeps its exact bytes. Retrying an older save or downloading an
older test returns its original loader; use a new TestId and a newly saved test
to obtain 1.1.1. This release does not activate a publisher test or configure GAM.

Continue to upload the complete saved A/B ZIP unchanged. Preserve the approved
CMP/GPT installation and load the verified shared `prebid.js` before `ads.js`
where Prebid is enabled. The loading deadline grants no consent permission.

## Verification boundary

Validation uses frozen complete 3.25.1 arms and native Prebid 11.34.0, plus
synthetic CMP, bidders and GPT. The independent transport fixture uses two real
loopback origins, sustained per-response byte limits and native SRI/CORS. It
also covers nonce CSP/Trusted Types, errors, first-arm races, late consent and
publisher getter reentrancy. The existing native delivery and pinned real-GPT
wire suites continue to check first requests, refresh, lazy slots, exactly one
runtime and attribution.

These checks establish the controlled loading fix, not production reach or a
revenue improvement. Loader 1.1.1 is common to both arms of a new A/B ZIP; compare
one runtime/cache setting at a time for a revenue experiment. The previously
accepted manual A/A check is not repeated by this release.
