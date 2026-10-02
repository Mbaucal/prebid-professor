# PM round 1: main promotion, 2026-10-01

Marko authorized promotion to main after accepting the delayed-consent test and
asked the central PM to continue the Linear backlog. This promotion contains
PR109 (HTML/login boundaries), PR110 (coordination rules), PR111 (strict type
checks), and PR112 (explicitly selected runtime 3.14). The previously reviewed
integration is `685d09f20d74584f1b2aaf137c020e8977921ff7`; its parents preserve all
four PR histories. This is not a promotion of the whole TEST branch.

## Actual publisher evidence

Marko tested the supplied local Politika package in his browser and provided
before/after readiness snapshots on 2026-10-01. The active build was
`20260930_134500`. The `user-decision` event at `1790872006113` was followed by
`decision-ready` at `1790872041082`: 34,969 ms of recorded waiting with no wrapper
auction event in that interval. The consent epoch changed from 0 to 1.

| Positions | Auction start after ready | Completion after ready |
| --- | ---: | ---: |
| Billboard | 399 ms | 1,111 ms |
| Branding_Left, Branding_Right | 424 ms | 1,283 ms |
| P1, Sticky | 986 ms | 1,609 ms |

All three distinct auction IDs completed with `completed: true`. Marko also
reported seeing the auctions in Professor Prebid. His CMP callback reported
`gdprApplies: true`, `cmpStatus: loaded`, `eventStatus: useractioncomplete`, and a
nonempty TC string. Consent strings and vendor maps are not copied into this
record. This confirms the delayed-decision/ATF scenario; it does not establish
positive bids, impressions, or revenue.

## Promotion and remaining boundaries

- The default remains 3.10. Existing site choices, frozen runtime sources, release
  records, saved package bytes and publisher channels are unchanged.
- 3.14 is an opt-in generator version. The unrelated TEST versions 3.11 and 3.15
  are not included in this promotion.
- The actual publisher test used a documented local package preserving legacy
  Politika configuration. It is not evidence of a saved Tessera publisher release.
- Real rejection, GPT request privacy parameters and exact initial Google request
  counts remain open acceptance items in MBA-171. The automated matrix uses real
  Prebid with intercepted synthetic demand and controlled CMP/GPT.
- The publisher's existing missing `criteoIdSystem` remains a complete-package
  check blocker. This promotion neither modifies its Prebid build nor deploys the
  local Politika package publicly.
- The accepted delayed-consent scenario should not be requested again without a
  concrete new risk. Broader runtime follow-ups remain separate.

The PM requires green promotion-PR CI before merge and records the resulting
production deployment separately in Linear. New work on MBA-173 and MBA-184 is
isolated on separate branches and is not part of this promotion.
