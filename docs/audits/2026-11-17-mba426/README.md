# MBA-426: active tools advisory remains blocked

This is an evidence record, **not a dependency remediation or an audit exception**.
As checked on 17 November 2026, there is no published patched Picomatch version
or supported compatible dependency update that clears this finding. MBA-426 and
the active-tools audit gate remain blocked. No dependency, gate, GAM code,
historical compiler input, frozen runtime or release record is changed here.

## Original failure and dependency graph

The complete [PR216 audit artifact](https://github.com/Mbaucal/prebid-professor/actions/runs/44151320790)
14359116702 was downloaded and its ZIP SHA-256 matched GitHub's artifact digest:
`f18b64923f368ddddb26167374ea5d57a9d4a5a1022b858a0ffa8607253f7a83`.
All seven files are retained in `original-audit/`, including the empty stderr
files. The reviewed PR216 head was
`8df377e54f80c5ae1353b8b34a4a2fd36b196907`; the separate dependency review starts
from MAIN `bf6b7c60a6f7c08673c1cd163c413bb7c6daf81d`.

| Scope | Findings | Meaning |
| --- | --- | --- |
| Active root production | 0 | Historical production compiler closure installed by the checked bootstrap |
| Active tools | 5 high, 0 critical | Five affected package nodes rooted in one Picomatch advisory |
| Historical full lock | 11 high, 0 critical | Retained historical inventory, not the active development installation |

The tools lock selects Vite 8.2.4, React plugin 6.0.5, Tinyglobby 0.2.17,
Fdir 6.5.0 and Picomatch 4.0.7. Vite directly requires Picomatch `^4.0.5` and
Tinyglobby `^0.2.17`; Tinyglobby requires Picomatch `^4.0.4` and Fdir `^6.5.0`;
Fdir's optional Picomatch peer is `^3 || ^4`. The React plugin's Vite peer is
`^8.0.0`. Audit propagates the Picomatch finding through these dependency edges.

## Primary advisory and bounded reproduction

[GHSA-fc5q-39xc-vjpf / CVE-2026-112366](https://github.com/advisories/GHSA-fc5q-39xc-vjpf),
reviewed and updated on 17 November at 15:56 UTC, affects Picomatch `<=4.0.7`.
The reviewed GitHub advisory snapshot has `first_patched_version: null`.
It describes event-loop denial of service when an application accepts hostile
single-branch repeated extglob patterns, such as `+(*a)`, and matches crafted
strings against the resulting nested-quantifier regular expression. The public
[upstream issue 175](https://github.com/micromatch/picomatch/issues/175) and
[PR194](https://github.com/micromatch/picomatch/pull/194) discuss incomplete
earlier safeguards; PR194 explicitly says it does not fix `+(*a)`.

An independent reviewer reproduced the affected behavior using the installed
Picomatch 4.0.7 in an isolated Node 24.22.1 subprocess. Pattern `+(*a)` compiles to
`^(?:(?=.)(?:[^/]*?a)+)$`. For subject `'a'.repeat(n) + '!'`, n=12 returned false
in 0.556 ms, n=20 returned false in 43.432 ms, and n=26 exceeded the enforced
1500 ms process deadline (`ETIMEDOUT`, `SIGTERM`). These are observations on
synthetic strings, not universal performance thresholds or live request tests.
A safe reproduction must enforce the deadline in a parent process; do not run
an unbounded hostile matcher in the test runner's own event loop.

Source review found no Picomatch, Tinyglobby or Fdir imports in `src/`, `worker/`
or `shared/`. The installed Tinyglobby matcher and partial matcher use
Picomatch; Fdir exposes optional glob matching. These are active Node build/dev
dependencies. Tinyglobby can disable extglobs with its `extglob:false` option,
but its default is enabled, and this is not a global fix for Vite's direct
Picomatch calls. The current local dev/preview entrypoints bind to 127.0.0.1.
Build configurations and repository inputs still form a relevant trust boundary;
being a development dependency does not make the finding harmless. This review
does not establish a universal non-reachability proof or evidence of compromise.

The reviewer also scanned the actual local PR216 production Worker and client
bundles for six matcher/build-tool identifiers and found zero occurrences. Exact
bundle sizes, SHA-256 values and terms are in `evidence.json`. This bounded string
scan and source inspection support a distinction between the Node toolchain and
the app runtime; they are neither deployed proof nor a security waiver.

## Published updates and upstream alternatives checked

Registry replies and upstream snapshots are indexed with hashes in
`evidence.json`; replies were captured on 17 November 2026. The raw source
snapshots relevant to this decision are retained alongside that index.

| Candidate | Observed status | Decision |
| --- | --- | --- |
| Official Picomatch | Latest 4.0.7; no 4.0.8 or 5.x version; all published versions fall in the advisory range | No official patched upgrade exists at review time |
| Latest Vite 8.3.8 | Still directly requires Picomatch `^4.0.7` and Tinyglobby `^0.2.17` | Does not fix this advisory |
| Latest Tinyglobby 0.2.17 / Fdir 6.5.0 | Already selected; retain Picomatch dependency/peer | No compatible removal of the affected package |
| Audit's Vite 6.2.7 / React plugin 5.2.0 suggestion | SemVer-major downgrade, incompatible with the current React plugin's Vite 8 peer; advisory affects older Picomatch too | A suggested dependency graph change is not evidence of a security fix |
| Official Picomatch master `9fab7bf61913ea334c4203ed321c426cfde44a42` | Still skips the single-branch guard at `branches.length > 1` | A Git pin to current master is not a fix |
| [PR254](https://github.com/micromatch/picomatch/pull/254), head `c63a5bf4e61dbdb81bc41e97dc2616c30acce337` | Open, unmerged proposal; removes redundant outer repetition for a checked token subset; documents capture changes | Public patch candidate requiring its own compatibility/security review; not a supported published release |
| [PR237](https://github.com/micromatch/picomatch/pull/237), head `1bf0d04563cb9ce568cf36efc5f6b7187d9911d5` | Open, unmerged proposal using a source-string analyzer and collapse rewrite | Not adopted; no official release or compatibility guarantee |
| [PR238](https://github.com/micromatch/picomatch/pull/238), head `44f192261f312ddf236cb7bdc05d8f22663f98f9` | Open, unmerged proposal that literalizes some patterns; explicitly leaves other shapes out of scope | Not adopted; matching behavior changes and coverage need separate review |
| [PR246](https://github.com/micromatch/picomatch/pull/246), head `f03bec2c02e46f063fbfdc161aae1d0f854b2565` | Open proposal for the v2 branch, not the installed v4 dependency | Not a compatible supported v4 update |
| [PR240](https://github.com/micromatch/picomatch/pull/240), head `f9822e9514d490f3e3bc17f50a4d3cacff2056c2` / `secured-picomatch` | Closed without merge; fork 4.0.7-a was unpublished on 28 October at 07:56:33.820 UTC | Not an installable registry alternative; package renaming would not itself prove remediation |

No unreviewed fork, local parser patch, alias, `audit fix --force`, advisory
suppression or audit threshold change was applied. Existing audit scripts and
workflow require zero active findings; there is no checked-in exception mechanism.
A formal risk decision would need an explicit project policy change and review,
not a claim that the present dependency graph is fixed.

## Local baseline checks and limits

The unchanged MAIN dependency graph was checked on Linux x64, Node 24.22.1,
npm 11.9.0, with workspace-local npm cache and Wrangler configuration/log paths:

- `node scripts/bootstrap-toolchain.mjs`: PASS, checked `npm ci` installations,
  16 historical production packages and 65 tools packages.
- `npm run typecheck`: PASS, all three strict app/Worker/tooling targets.
- `npm run build`: PASS, Vite 8.2.4 Worker/client build and existing frozen-output
  verification. The existing large-client-chunk warning remains a warning.
- `node scripts/verify-toolchain-isolation.mjs --outputs`: PASS, all 63 recorded
  generated outputs and the immutable compiler dependency closure preserved.
- `node scripts/audit-isolated-toolchain.mjs`: FAIL as expected at active-tools
  `5 !== 0`; fresh saved reports still show 0 / 5 / 11 findings by scope.

The root lock remains SHA-256
`7d9787650ad10fcafee21db223ce2bb76b2e9dc6ac6b943404b260e3b7f47280`;
the tools lock remains
`cdac329a2c94a223ba2f7dce0f6bc34c93869a086b41c1962487d987ae46bb0a`.
This local Node version differs from CI's pinned Node 22.23.3. No final dependency
candidate exists to validate on exact-head CI. The already reported PR216 strict,
build and packaging/parity passes are separate baseline evidence in
[MBA-426](https://linear.app/mbaucal/issue/MBA-426); broad browser/runtime matrices
were not repeated for an evidence-only change. There was no hosted TEST or
production deployment, GAM object creation, publisher configuration change or
live ad traffic.

The next legitimate options are an official patched release followed by the
smallest tools-only lock update and full validation, or a separately reviewed
patch/fork or formal bounded risk decision. Until then the gate accurately remains
red and this record does not resolve MBA-426 or unblock PR216.
