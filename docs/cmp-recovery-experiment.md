# CMP recovery experiment — MBA-190

**Not a shipping runtime.** This experiment imports the existing frozen readiness helper and supplies it a local CMP API facade. It is confined to `tests/support/cmp-recovery-experiment.mjs` and its synthetic test. No application import, script version, registry, compiler, defaults, publisher globals, saved package or deployment changes exist.

Run `node tests/runtime/cmp-recovery-experiment.test.mjs`. All observations below use deterministic synthetic clocks, mock CMP callbacks and mock GAM dispatch; they do not prove native Prebid/GPT or publisher integration.

| # | Scenario | Frozen baseline | Experiment observation |
|---|---|---|---|
| 1 | API absent for 30s, then valid API appears | Recovers | Recovers within 250ms observation interval; no request before decision |
| 2 | Nonforwarding stub replaced after 30s | Remains blocked; real API never registered | Registers replacement once, resumes one pending slot |
| 3 | Same API loading for 60s, then Accept | Recovers | Recovers once; one registration throughout |
| 4 | Same API loading for 60s, then Reject | Recovers | Recovers once; rejection is a complete decision, not granted permission |
| 5 | Registration throws after retaining callback | Registers 6 times over 5s | Registers once, stays blocked; new API identity recovers |
| 6 | Ready API replaced with loading API | No ongoing API discovery | At detection, invalidates readiness/epoch, ignores old callbacks, clears stale slot targeting before later dispatch |
| 7 | Old callback fires after replacement, before polling | Can still deliver old data | Callback checks live API identity, triggers detection without forwarding old decision |
| 8 | Registration gives synchronous valid callback then throws | Not relied upon for acceptance | Invalidates before queued dispatch; removes known listener ID |
| 9 | Silent old stub supplies listener ID late | Not cleaned by existing helper | Removes late ID without accepting old consent |
| 10 | Ready API disappears; then teardown | No lifecycle teardown | Detection makes readiness pending; known listener removed, sole polling timer cleared on dispose |
| 11 | Unknown scope or unsuccessful callback | Remains blocked | Remains blocked; only positive `gdprApplies:false` is out-of-scope |
| 12 | 20 changing API identities | No replacement discovery | One poll retained; each known old listener removed once, latest removed on dispose |

The test currently has 20 cases because shared baseline/experiment scenarios and Accept/Reject run independently. Three cases deliberately prove remaining weaknesses: both immediate and already-queued dispatch can send under the old decision before replacement detection; 20 silent stubs retain 20 callbacks without listener IDs; failed removal is only an attempted cleanup. Same-slot repeated dispatch coalesces through the unchanged helper. No timeout fabricates consent, changes scope, or activates NPA/Limited Ads. Existing synthetic `consent-readiness.test.mjs` remains the reference for auction epoch/targeting controls; this experiment establishes lifecycle feasibility, not full auction correctness.

## Boundaries that still need design

- API replacement detection is polling (250ms), or sooner if an old callback is delivered. **Between replacement and detection the frozen helper can still have old readiness.** This prototype must not be shipped as a production solution. Request/dispatch boundaries would need identity validation in a reviewed new implementation.
- A registration throw is ambiguous: the CMP may already have registered. The experiment refuses automatic same-function retries, even if the underlying error was transient and truly registered nothing. A different API function recovers. Same-function failure therefore remains an explicit unsupported recovery case.
- A CMP that never supplies a listener ID cannot be reliably unregistered. Late IDs are removed when received; an old provider may retain a callback until then. A stub function which keeps the same identity and never forwards or calls back cannot be repaired safely here.
- `removeEventListener` errors are swallowed to keep consent blocked; successful cleanup is proven only for the cooperative mock. Repeated hostile IDs or uncooperative removal require further resource-limit design.
- Dispose clears adapter-owned polling and listeners and invalidates readiness. The frozen helper itself has no teardown API for its pending waiter closures; discard the isolated gate with the experiment. This is not complete runtime disposal.
- No browser/native Prebid claim, consent-field correctness claim, real CMP compatibility or live serving fallback is made. Full native integration and before-dispatch identity safeguards are prerequisites to any production proposal. Only after review should a separately selected runtime version be considered.
