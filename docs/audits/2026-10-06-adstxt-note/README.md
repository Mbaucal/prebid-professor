# Ads.txt note lifecycle diagnostic — MBA-20

A related late-save fixture race is now causally confirmed and synchronized. The exact original late-export failure remains unproven. This change updates only the synthetic browser fixture and its evidence; it does not fix or change the application.

Base: TEST `c5d8467d9d192eeeb726f60fb864244dfa3c009e`. Bootstrap used the checked-in isolated TEST locks. The compiled App JavaScript SHA-256 remains `3a27391b9c56901f185d303dcf7a0e02b9f0aa06cf075f1897f823ccd68e48bd`, matching the earlier accepted build. Neither AdsTxtVersionsPanel nor AdsTxtVersionsPortal was changed.

## Observations and limits

The earlier MBA-214 run failed once at `late-export-cancelled`: expected `Latest input`, observed empty. Subsequent original and controlled detector-delay probes passed; those probes did not establish a stale site-B panel as the cause.

This investigation ran 24 bounded instrumented copies of the original fixture against the same App bytes. Twenty-three completed all 14 desktop/390 checks. One failed earlier at `a-b-a-late-save`: expected `New visit note`, observed empty. That is a recurrence in a related scenario, not a reproduction of the exact original late-export failure. The initial diagnostic flushed only successful checkpoints and missed this failing transition. It cannot establish whether a stale site, component replacement, or another state update cleared the input. Later streaming traces did not reproduce a failure. Four scheduling-throttled probes that had already started also passed; no further repetitions were used to infer a fix.

After removing extra diagnostic browser roundtrips, the first verification run failed naturally at the late-save assertion on 390px. The passive failure trace captured the cause: at 855ms the global heading showed A but the card still showed B; at 865.4ms `New visit note` was entered into B's input node 4; at 866.2ms that input disappeared; at 874.3ms card A appeared, followed by empty input node 5 at 877.2ms. See [the captured trace](late-save-trace.json). The test had awaited the global heading plus a button state shared by both sites, so it did not establish the card's actual site before typing.

`choose(id)` now waits for the Ads.txt card's actual selected-site marker after the existing global-heading assertion. This is semantic synchronization, not a sleep or assertion relaxation. It addresses the proven late-save fixture race and applies consistently to site switches. It does not establish that the earlier untraced late-export failure had the same cause.

No wrong export or actual publisher write was observed. A successful repetition does not resolve the intermittent input-loss report. MBA-20 remains open for causal investigation before production promotion.

## Evidence now captured automatically

The existing fixture keeps the latest 256 synthetic lifecycle events in memory and writes `note-lifecycle.jsonl` in `.generated/adstxt-version-evidence/` if any assertion fails. Existing CI already uploads this directory with `if: always()`, so a future failure retains evidence without a special rerun. Successful runs produce no trace unless `--trace-note-lifecycle` is supplied.

Events include document identity and monotonic time, input DOM identity, global heading, panel site marker, input values, input events, DOM/context changes, and programmatic value-write stacks. Local Python phase labels bracket both relevant note fills and site selections without extra browser calls. The diagnostic itself adds no browser roundtrips between choose/fill/fulfill; the one additional card-site assertion is the explicit synchronization fix. The exit record preserves the failure type/message. It contains only local synthetic fixture state, no credentials or network bodies. The observer and native value-setter wrapper do not change application state; instrumentation can still affect scheduling, so a green instrumented run is not proof of absence.

All original 14 assertions, held responses, same-task marker race, no-export checks and write checks are retained. No sleeps were added; the only added readiness assertion identifies the actual selected site in the card.

## Validation

- Isolated TEST `npm ci` bootstrap and guarded App/Worker build: PASS, local Node 24.19.0.
- Captured before: a natural 390px late-save failure with input-node and site-context transitions. Exact synchronized fixture with successful trace enabled: 14/14 PASS at 1440px and 390px; existing error/retry and late-response scenarios retained.
- Controlled diagnostic failure: an in-memory copy raised `AssertionError('Controlled diagnostic-flush check')` immediately after the original late-export assertion. Exit status remained 1. With no trace flag, the artifact contained the latest input identity/context plus the failed exit record, within the 256-event bound. This validates evidence flushing; it is not a reproduction of the application issue.
- Python syntax and diff whitespace checks: PASS. No application bytes changed, so the broader application matrix was not repeated.

Reproduce the normal fixture with the existing isolated TEST build and pinned Playwright 1.55.0:

```sh
TESSERA_TEST_TOOLCHAIN=isolated python scripts/verify-adstxt-versions.py
# Optional: retain lifecycle evidence even when all assertions pass.
TESSERA_TEST_TOOLCHAIN=isolated python scripts/verify-adstxt-versions.py --trace-note-lifecycle
```

Local execution used `/tmp/mba212-py/bin/python` and `PLAYWRIGHT_BROWSERS_PATH=/tmp/mba212-browsers`; proxy environment variables were omitted only in the local child process. All responses were synthetic loopback fixture responses. No hosted browser, publisher configuration, deployment or external mutation was used.
